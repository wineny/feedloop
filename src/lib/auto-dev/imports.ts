// 수정 후보 파일의 import 를 따라 1-hop 이웃을 찾는다 — 자동 PR 의 「그라운딩」.
//
// PR #6 이 이렇게 났다: 후보로 `app/app/coupons/page.tsx` 하나만 골라 그 원본만 보고 고쳤는데,
// 그 파일이 직접 import 하는 `app/lib/coupon-session.ts` 가 이미 같은 실패를 막고 있어서
// 추가한 분기가 도달 불가능한 죽은 코드였다. 모델은 인과의 반대쪽 끝을 볼 기회가 없었다.
// PR 본문이 스스로 「coupon-session 원본이 제공되지 않아 확인하지 못했다」고 적었다.
//
// 그래서 후보 원본을 읽은 뒤 import 문을 파싱해 레포 트리와 대조하고, 실재하는 이웃을
// **참고용 원본**으로 2-pass 에 넣는다. 우버 팀 사례의 수치가 이 방향의 근거다 —
// 컨텍스트 그래프가 있으면 38초·정답률 100%, 없으면 20분·63%. 탐색 오버헤드가 가장 큰 낭비다.
//
// 이웃은 수정 대상이 아니다. 파일 전체를 돌려받는 구조라 응답이 커지면 함수 한도(300초)에
// 닿는다. 그래서 개수·바이트 상한을 걸고, 후보가 import 를 많이 하면 순위로 고른다.

/** 한 번에 넣는 이웃 파일 수 상한 */
export const MAX_NEIGHBOR_FILES = 3;
/** 이웃 파일 하나의 바이트 상한 — 넘으면 앞부분만 넣는다(선언·시그니처가 앞에 있다) */
export const MAX_NEIGHBOR_BYTES = 40_000;

/** import 로 따라갈 가치가 있는 소스만. CSS·JSON·이미지는 계약 확인에 쓸모가 없다. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = RESOLVE_EXTENSIONS.map((ext) => `index${ext}`);

/** 프로젝트 루트를 알려주는 파일. `@/` 별칭은 이 파일이 있는 디렉터리를 기준으로 푼다. */
const ROOT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json'];

export interface ParsedImport {
  specifier: string;
  /** `import type { X }` 처럼 타입만 가져오면 런타임 동작이 없다 — 인과 추적에 쓸모없다 */
  typeOnly: boolean;
  /** 소스에서 등장한 순서 (동점 정렬용) */
  order: number;
}

/**
 * import/export-from/require/dynamic import 의 specifier 를 뽑는다.
 * 완전한 파서가 아니다 — 문자열·주석 안의 가짜 import 는 잡힐 수 있지만
 * 어차피 레포 트리와 대조해서 없는 경로는 버리므로 해가 없다.
 */
export function parseImports(source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const seen = new Set<string>();
  let order = 0;

  const push = (specifier: string, typeOnly: boolean) => {
    if (seen.has(specifier)) {
      // 같은 모듈을 타입으로도 값으로도 가져오면 값 쪽이 이긴다
      if (!typeOnly) {
        const prev = out.find((i) => i.specifier === specifier);
        if (prev) prev.typeOnly = false;
      }
      return;
    }
    seen.add(specifier);
    out.push({ specifier, typeOnly, order: order++ });
  };

  // import ... from '...'  /  import type ... from '...'
  // clause 에 따옴표를 금지해야 `import './a.css'; import type {B} from './b'` 가 하나로 안 붙는다
  const importFrom = /(^|[\n;])\s*import\s+(type\s+)?([^'"]*?)\s+from\s*['"]([^'"\n]+)['"]/g;
  for (const m of source.matchAll(importFrom)) {
    const isTypeKeyword = Boolean(m[2]);
    const clause = m[3];
    push(m[4], isTypeKeyword || isTypeOnlyClause(clause));
  }

  // import '...'  (side-effect)
  const sideEffect = /(^|[\n;])\s*import\s*['"]([^'"\n]+)['"]/g;
  for (const m of source.matchAll(sideEffect)) push(m[2], false);

  // export ... from '...'
  const exportFrom = /(^|[\n;])\s*export\s+(type\s+)?(?:\*|\{[\s\S]*?\})(?:\s+as\s+\w+)?\s+from\s*['"]([^'"\n]+)['"]/g;
  for (const m of source.matchAll(exportFrom)) push(m[3], Boolean(m[2]));

  // require('...') / import('...')
  const callForm = /\b(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  for (const m of source.matchAll(callForm)) push(m[1], false);

  return out;
}

/** `{ type A, type B }` 처럼 괄호 안이 전부 type 이면 타입 전용이다. */
function isTypeOnlyClause(clause: string): boolean {
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (!brace) return false; // default import 또는 namespace import → 값
  const hasDefault = clause.replace(brace[0], '').replace(/,/g, '').trim() !== '';
  if (hasDefault) return false;
  const names = brace[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return false;
  return names.every((n) => /^type\s+/.test(n));
}

/** 경로의 부모 디렉터리들을 가까운 순서로 ('' 가 레포 루트) */
function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  const out: string[] = [];
  for (let i = parts.length; i >= 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * import 하는 파일에서 가장 가까운 프로젝트 루트(tsconfig/package.json 이 있는 디렉터리).
 * 데모 레포는 Vercel root 가 `app` 이라 `@/lib/x` → `app/lib/x` 다. 레포 루트로 넘겨짚으면 틀린다.
 */
export function findProjectRoot(fromPath: string, blobPaths: Set<string>): string {
  for (const dir of ancestors(fromPath)) {
    const prefix = dir ? `${dir}/` : '';
    if (ROOT_MARKERS.some((marker) => blobPaths.has(`${prefix}${marker}`))) return prefix;
  }
  return '';
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return ''; // 레포 밖으로 나간다
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 확장자 없는 경로를 실제 blob 으로. 정확한 경로 → 확장자 붙이기 → index 파일 순서. */
function resolveWithExtensions(base: string, blobPaths: Set<string>): string | null {
  if (!base) return null;
  if (blobPaths.has(base) && RESOLVE_EXTENSIONS.some((ext) => base.endsWith(ext))) return base;
  // NodeNext/ESM 레포는 `./k.ts` 를 `./k.js` 로 적는다 — 확장자를 떼고 다시 붙여본다
  const jsLike = base.match(/^(.*)\.(?:js|jsx|mjs|cjs)$/);
  if (jsLike && !blobPaths.has(base)) base = jsLike[1];
  for (const ext of RESOLVE_EXTENSIONS) {
    if (blobPaths.has(`${base}${ext}`)) return `${base}${ext}`;
  }
  for (const index of INDEX_FILES) {
    if (blobPaths.has(`${base}/${index}`)) return `${base}/${index}`;
  }
  return null;
}

/**
 * specifier 를 레포 경로로. 못 풀면 null — 외부 패키지(`react`), `node:` 내장, CSS 등.
 * `@/`·`~/` 별칭은 프로젝트 루트와 `src/` 를 차례로 시도한다.
 */
export function resolveImport(
  specifier: string,
  fromPath: string,
  blobPaths: Set<string>,
): string | null {
  const spec = specifier.split('?')[0]; // `?raw` 같은 로더 쿼리 제거
  if (!spec) return null;

  if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = fromPath.split('/').slice(0, -1).join('/');
    return resolveWithExtensions(normalize(dir ? `${dir}/${spec}` : spec), blobPaths);
  }

  const alias = spec.match(/^[@~]\/(.+)$/);
  if (alias) {
    const root = findProjectRoot(fromPath, blobPaths);
    for (const base of [`${root}${alias[1]}`, `${root}src/${alias[1]}`]) {
      const hit = resolveWithExtensions(normalize(base), blobPaths);
      if (hit) return hit;
    }
    return null;
  }

  // 나머지(`react`, `next/link`, `node:fs`, `@octokit/rest`)는 패키지다
  return null;
}

// ─── 순위 ─────────────────────────────────────────────────────────────────────
//
// 후보 하나가 import 를 15개 하는 건 흔하다(데모 레포 쿠폰 페이지가 그렇다). 앞에서 3개를 자르면
// 컴포넌트·아이콘·i18n 이 먼저 잡히고 정작 데이터 계층(`coupon-session`)은 16번째라 떨어진다.
// 버그의 인과는 대개 렌더가 아니라 데이터를 만드는 쪽에 있으므로 로직 모듈을 앞에 둔다.

/** 경로에 이 디렉터리가 있으면 로직 계층으로 본다 */
const LOGIC_SEGMENTS = new Set([
  'lib', 'libs', 'utils', 'util', 'services', 'service', 'hooks', 'api', 'store', 'stores',
  'data', 'server', 'actions', 'helpers', 'core', 'domain', 'models', 'model', 'db', 'queries',
]);
/** 계약 확인에 거의 쓸모없는 것들 — 아이콘·번역·스타일·타입 선언 모음 */
const NOISE_PATTERN = /(^|\/)(i18n|icons?|styles?|theme|types?|constants?)(\/|\.|$)/i;
/** 키워드로 세지 않는 흔한 조각 */
const GENERIC_TOKENS = new Set([
  'page', 'index', 'route', 'layout', 'app', 'src', 'components', 'component', 'lib', 'api',
  'tsx', 'ts', 'js', 'jsx', 'client', 'server', 'utils', 'view', 'main', 'default',
]);

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    for (const piece of raw.split(/(?=[A-Z])/)) {
      const t = piece.toLowerCase();
      if (t.length >= 4 && !GENERIC_TOKENS.has(t)) out.add(t);
    }
  }
  return out;
}

/** `coupon` 과 `coupons` 를 같은 말로 — 앞 5글자가 같으면 같은 어간으로 본다 */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(5, a.length, b.length);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

export interface NeighborCandidate {
  path: string;
  from: string;
  score: number;
  order: number;
}

function scoreNeighbor(path: string, keywords: Set<string>): number {
  let score = 0;
  const segments = path.split('/');
  if (segments.some((s) => LOGIC_SEGMENTS.has(s.toLowerCase()))) score += 2;
  if (NOISE_PATTERN.test(path)) score -= 3;

  let overlap = 0;
  for (const t of tokensOf(path)) {
    for (const k of keywords) {
      if (sameStem(t, k)) {
        overlap += 1;
        break;
      }
    }
  }
  score += Math.min(overlap, 2);
  return score;
}

/**
 * 후보 파일들의 1-hop 이웃을 순위대로 최대 `MAX_NEIGHBOR_FILES` 개 고른다.
 * 후보 자신은 제외한다(이미 「수정 대상 원본」으로 들어간다).
 * 점수가 음수인 것(i18n·아이콘·스타일·타입 모음)은 자리가 남아도 넣지 않는다 — 40KB 를 소음에 쓰지 않는다.
 *
 * @param keywordText 피드백 요약·원문·기술 맥락을 이어붙인 문자열. 한글은 토큰이 안 되고
 *   URL·에러 메시지·식별자 같은 라틴 조각만 센다(`/api/coupons/history` → coupons, history).
 *   후보 파일 경로 자체도 키워드로 더한다 — 실제로는 이쪽이 주 신호다.
 */
export function selectImportNeighbors(
  sources: { path: string; content: string }[],
  blobPaths: Set<string>,
  keywordText: string,
  limit: number = MAX_NEIGHBOR_FILES,
): NeighborCandidate[] {
  const candidateSet = new Set(sources.map((s) => s.path));
  const keywords = tokensOf(`${keywordText} ${sources.map((s) => s.path).join(' ')}`);
  const byPath = new Map<string, NeighborCandidate>();
  let order = 0;

  for (const source of sources) {
    for (const imp of parseImports(source.content)) {
      if (imp.typeOnly) continue;
      const resolved = resolveImport(imp.specifier, source.path, blobPaths);
      if (!resolved || candidateSet.has(resolved) || byPath.has(resolved)) continue;
      byPath.set(resolved, {
        path: resolved,
        from: source.path,
        score: scoreNeighbor(resolved, keywords),
        order: order++,
      });
    }
  }

  return [...byPath.values()]
    .filter((n) => n.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit);
}

/** 상한을 넘는 이웃은 앞부분만 남기고 잘린 사실을 표시한다. */
export function truncateNeighbor(content: string, maxBytes: number = MAX_NEIGHBOR_BYTES): string {
  if (Buffer.byteLength(content, 'utf-8') <= maxBytes) return content;
  let cut = content.slice(0, maxBytes);
  while (Buffer.byteLength(cut, 'utf-8') > maxBytes) cut = cut.slice(0, -1000);
  return `${cut}\n\n// … (rest omitted — over ${maxBytes.toLocaleString('en-US')} bytes. Reference only, so only the beginning is included)`;
}

// 제보자가 보낸 기술 맥락을 레포 트리와 대조한다 (2026-09-09).
//
// 왜 — `context` 는 무인증 위젯 라우트로 들어온다. 위젯이 자동으로 걷어오는 게
// 보통이지만, **아무나 그 모양으로 POST 할 수 있다.** 그런데 자동 PR 프롬프트는
// 이걸 「위젯이 자동 수집」이라 부르며 "그것부터 보라"고 시켰다.
//
// 실제로 터졌다 — 데모 레포 PR #6. 조작된 맥락에 `500 /api/coupons/history` 가
// 들어 있었는데 **그런 라우트는 레포에 없다**(실제는 `/api/coupons/mine`). 모델은
// 그 이름을 PR 본문에 그대로 옮겨 적고, 없는 실패 경로에 맞춘 방어 코드를 썼다.
// 도달 불가능한 죽은 코드였다.
//
// 그래서 레포 트리로 대조할 수 있는 것(페이지 경로·API 라우트)은 대조해서
// 「레포에 없음」을 프롬프트에 명시한다. 지우지는 않는다 — 지우면 모델이
// "왜 이 단서가 없지" 를 물을 기회조차 잃고, 정상 제보를 놓칠 위험이 생긴다.
//
// 🔴 판정 편향은 **관대한 쪽**이다. 못 고르겠으면 `unknown`, 애매하면 `confirmed`.
// 잘못된 `missing` 은 진짜 단서를 버리게 만들지만, 잘못된 `confirmed` 는
// 그저 오늘과 같은 동작으로 돌아갈 뿐이다.

import { formatTargetLines } from './context';
import { targetLabel, targetLabelEn, type WidgetTarget } from './pick';

/** 라우트·페이지 파일의 basename */
const ROUTE_BASENAME = /^(route|page)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** `[slug]` — URL 한 세그먼트와 대응 */
const DYNAMIC_SEG = /^\[[^.\]]+\]$/;
/** `[...slug]` · `[[...slug]]` — 남은 세그먼트 전부와 대응 */
const CATCH_ALL_SEG = /^\[{1,2}\.\.\.[^\]]+\]{1,2}$/;
/** `(marketing)` 라우트 그룹 · `@modal` 병렬 라우트 — URL 에 안 나온다 */
const INVISIBLE_SEG = /^(\(.*\)|@.+)$/;

/** 스택트레이스에 나온 원본 파일명. `.js` 는 번들 산출물이라 제외한다 */
const SOURCE_FILE_IN_TEXT = /\b([A-Za-z0-9_.-]+\.tsx?)\b/g;

export type ClaimStatus = 'confirmed' | 'missing' | 'unknown';

export interface ContextClaim {
  /** 프롬프트·PR 본문에 그대로 실릴 문장 */
  value: string;
  status: ClaimStatus;
  /** `missing` 일 때 무엇을 못 찾았는지 */
  note?: string;
  /** PR 본문(영어 고정)용 `note` */
  noteEn?: string;
}

export interface VerifiedContext {
  urls: ContextClaim[];
  errors: ContextClaim[];
  requests: ContextClaim[];
  /**
   * 방문자가 화면에서 짚은 요소(B3). 이미 여러 줄로 포맷된 문자열이다. 레포 트리와 대조하지
   * «않는다» — DOM 값이라 대응할 «파일»이 없고, 글자·클래스명이 어느 파일에 있는지는 트리로는
   * 모른다(blob 내용이 없다). 그래서 판정 없이 «제보자가 짚은 값»으로만 싣는다.
   */
  targets: string[];
  /** targets 의 PR 본문용(html 줄 없음) */
  targetsForPrBody: string[];
  /**
   * 짚은 요소를 «요소 단위»로 든 판정(B3 3차, 2026-09-16). `targetItems` 원자료가 왔을 때만 채워진다.
   * 처음엔 전부 `unknown` 이고, 엔진이 `confirmTargetClaims` 로 레포 «원본»을 읽어 `confirmed` 로 올린다.
   * 비어 있으면 위 `targets` 문자열(옛 경로)을 그대로 쓴다.
   */
  targetClaims: TargetClaim[];
  /** 하나라도 레포에서 확인되지 않았는가 — 프롬프트 경고 수위를 가른다 */
  hasMissing: boolean;
}

/** 위젯 맥락에서 뽑아낸 원자료. 건수는 묶음 실행에서 신호가 된다 */
export interface ContextItems {
  urls: string[];
  errors: string[];
  requests: string[];
  /** 짚은 요소를 포맷한 줄들(context.ts formatTargetLines). 없으면 빈 배열 또는 생략 */
  targets?: string[];
  /** 같은 것의 PR 본문용 — html 뼈대 줄이 없다. 생략이면 targets 에서 html 줄을 걸러 쓴다 */
  targetsForPrBody?: string[];
  /**
   * 짚은 요소의 원자료(상위 3개, 같은 셀렉터를 여러 사람이 짚었으면 count). 문자열로 굳히기 전 값이라
   * 레포 원본과 대조할 수 있다. 없으면(옛 호출부) targets 문자열만으로 종전처럼 싣는다.
   */
  targetItems?: { target: WidgetTarget; count: number }[];
}

/** 레포 전체 blob 경로에서 라우트·페이지 파일의 디렉터리 세그먼트만 추린다 */
function routeDirSegments(paths: Iterable<string>): { segs: string[]; isApi: boolean }[] {
  const out: { segs: string[]; isApi: boolean }[] = [];
  for (const p of paths) {
    const segs = p.split('/');
    const file = segs[segs.length - 1];
    if (!ROUTE_BASENAME.test(file)) continue;
    const dir = segs.slice(0, -1);
    out.push({ segs: dir, isApi: file.startsWith('route.') });
  }
  return out;
}

/**
 * URL 세그먼트 목록이 라우트 파일 경로의 **꼬리**와 맞는지 본다.
 *
 * 앱 라우터 루트(`app/` · `src/app/` · `app/app/`)를 찾아내려 애쓰지 않는다 —
 * 레포마다 다르고 틀리면 곧바로 잘못된 `missing` 이 된다. 꼬리 매칭이면
 * 루트가 어디든 맞는다. 대신 `/mine` 같은 짧은 경로가 헐겁게 맞을 수 있는데,
 * 그건 관대한 쪽 오류라 받아들인다.
 */
function tailMatches(urlSegs: string[], dirSegs: string[]): boolean {
  // 라우트 그룹·병렬 세그먼트는 URL 에 안 나오므로 빼고 비교한다
  const dir = dirSegs.filter((s) => !INVISIBLE_SEG.test(s));

  for (let start = dir.length - urlSegs.length; start >= 0; start--) {
    if (matchFrom(urlSegs, dir, start)) return true;
  }
  // catch-all 은 URL 이 파일 경로보다 길 수 있다
  for (let start = dir.length - 1; start >= 0; start--) {
    if (dir.slice(start).some((s) => CATCH_ALL_SEG.test(s)) && matchFrom(urlSegs, dir, start)) {
      return true;
    }
  }
  return false;
}

function matchFrom(urlSegs: string[], dir: string[], start: number): boolean {
  let u = 0;
  let d = start;
  while (d < dir.length) {
    const seg = dir[d];
    if (CATCH_ALL_SEG.test(seg)) return u < urlSegs.length || seg.startsWith('[[');
    if (u >= urlSegs.length) return false;
    if (!DYNAMIC_SEG.test(seg) && seg !== urlSegs[u]) return false;
    u++;
    d++;
  }
  return u === urlSegs.length;
}

/**
 * URL 문자열에서 경로 세그먼트만 뽑는다. 쿼리·해시·오리진은 버린다.
 *
 * 실패한 요청은 `500 /api/x` 나 `500 https://host/api/x` 처럼 **상태코드가 앞에 붙어**
 * 온다. 그래서 경로를 문자열 맨 앞에서만 찾으면 안 된다 — 그렇게 했다가
 * 정작 이 기능이 잡아야 할 `500 /api/coupons/history` 를 통째로 놓쳤다.
 */
function pathSegments(raw: string): string[] | null {
  const abs = raw.match(/https?:\/\/[^/\s]+(\/[^\s?#]*)/);
  const rel = raw.match(/(?:^|\s)(\/[^\s?#]*)/);
  const path = abs?.[1] ?? rel?.[1];
  if (path === undefined) return null;
  return path.split('/').filter(Boolean);
}

function verifyPath(
  raw: string,
  routes: { segs: string[]; isApi: boolean }[],
  wantApi: boolean,
): ContextClaim {
  const segs = pathSegments(raw);
  if (segs === null) return { value: raw, status: 'unknown' };
  if (segs.length === 0) return { value: raw, status: 'confirmed' }; // 루트 경로

  const pool = routes.filter((r) => (wantApi ? r.isApi : true));
  if (pool.length === 0) return { value: raw, status: 'unknown' };

  const hit = pool.some((r) => tailMatches(segs, r.segs));
  if (hit) return { value: raw, status: 'confirmed' };
  return {
    value: raw,
    status: 'missing',
    note: wantApi
      ? '이 경로를 처리하는 라우트 파일이 레포에 없다'
      : '이 경로에 해당하는 페이지 파일이 레포에 없다',
    noteEn: wantApi ? 'no route file for this path in the repo' : 'no page file for this path in the repo',
  };
}

/**
 * 콘솔 에러는 대부분 검증할 수 없다 — `page.js:42` 는 번들 산출물이라
 * 레포에 그 이름의 파일이 없는 게 정상이다. 그래서 `.ts`/`.tsx` 로
 * 소스맵이 풀린 이름이 보일 때만 대조하고, 나머지는 `unknown` 으로 둔다.
 */
function verifyError(raw: string, allPaths: Set<string>): ContextClaim {
  const names = Array.from(raw.matchAll(SOURCE_FILE_IN_TEXT), (m) => m[1]);
  if (names.length === 0) return { value: raw, status: 'unknown' };

  const missing = names.filter(
    (n) => !Array.from(allPaths).some((p) => p === n || p.endsWith(`/${n}`)),
  );
  if (missing.length === 0) return { value: raw, status: 'confirmed' };
  return {
    value: raw,
    status: 'missing',
    note: `${missing.join(', ')} 이(가) 레포에 없다`,
    noteEn: `${missing.join(', ')} not found in the repo`,
  };
}

/** 레포 트리(`blobShas` 의 키)와 대조해 항목마다 판정을 붙인다 */
export function verifyContextItems(
  items: ContextItems,
  repoPaths: Iterable<string>,
): VerifiedContext {
  const all = new Set(repoPaths);
  const routes = routeDirSegments(all);

  const urls = items.urls.map((u) => verifyPath(u, routes, false));
  const requests = items.requests.map((r) => verifyPath(r, routes, true));
  const errors = items.errors.map((e) => verifyError(e, all));

  const hasMissing = [...urls, ...requests, ...errors].some((c) => c.status === 'missing');
  const targets = items.targets ?? [];
  const targetsForPrBody = items.targetsForPrBody ?? targets.filter((l) => !/^\s*html: /.test(l));
  const targetClaims = (items.targetItems ?? []).map(({ target, count }) => initialTargetClaim(target, count));
  return { urls, errors, requests, targets, targetsForPrBody, targetClaims, hasMissing };
}

const MARK: Record<ClaimStatus, string> = {
  confirmed: '',
  missing: '  ⚠️ 레포에서 확인 안 됨',
  unknown: '  (레포로 확인 불가)',
};

function claimLines(label: string, claims: ContextClaim[]): string[] {
  if (claims.length === 0) return [];
  const lines = [`- ${label}:`];
  for (const c of claims) {
    const note = c.status === 'missing' && c.note ? ` — ${c.note}` : '';
    lines.push(`  · ${c.value}${MARK[c.status]}${note}`);
  }
  return lines;
}

/** 프롬프트에 실을 본문. 판정을 항목마다 붙인다 */
export function formatVerifiedForPrompt(v: VerifiedContext): string {
  return [
    ...claimLines('발생 페이지', v.urls),
    ...claimLines('콘솔 에러', v.errors),
    ...claimLines('실패한 요청', v.requests),
    ...targetClaimPromptLines(v),
  ].join('\n');
}

/**
 * 짚은 요소를 프롬프트에. 요소 단위 판정(`targetClaims`)이 있으면 확인된 것과 아닌 것을 갈라 싣고,
 * 없으면(옛 호출부) 문자열을 종전 라벨로 싣는다.
 *
 * 확인됐어도 「이 파일이 그린다」까지만 말한다 — 「원인이 여기 있다」는 말은 안 한다. 제보자 값은 단서이지
 * 근거가 아니고(PR #6), 요소를 그리는 파일과 증상을 만드는 파일은 다를 수 있다.
 */
function targetClaimPromptLines(v: VerifiedContext): string[] {
  if (v.targetClaims.length === 0) {
    return v.targets.length ? ['- 제보자가 화면에서 짚은 요소 (DOM 값 — 레포 트리로는 대조 불가):', ...v.targets] : [];
  }
  const out: string[] = [];
  for (const c of v.targetClaims) {
    if (c.status === 'confirmed') {
      const files = c.files.map((f) => f.path).join(', ');
      out.push(`- 제보자가 화면에서 짚은 요소 — **레포 원본에서 확인됨, 이 파일이 그린다: ${files}** (근거: ${describeMatches(c)}):`);
    } else {
      out.push('- 제보자가 화면에서 짚은 요소 (DOM 값 — 레포 원본에서 확인 못 함, 대조 불가):');
    }
    out.push(...c.lines);
  }
  return out;
}

/** 「data-testid 'claim', class 'RegionSelector_pill'」 — 무엇이 맞았는지 한 줄. 값은 이미 한 줄·백틱 없음 */
function describeMatches(c: TargetClaim, lang: 'ko' | 'en' = 'ko'): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of c.files) {
    for (const m of f.matched) {
      if (seen.has(m)) continue;
      seen.add(m);
      const id = c.identifiers.find((i) => i.value === m);
      parts.push(`${(lang === 'en' ? IDENT_KIND_LABEL_EN : IDENT_KIND_LABEL)[id?.kind ?? 'text']} '${m}'`);
    }
  }
  return parts.join(', ');
}

/** PR 본문용. 확인된 것과 확인 안 된 것을 나눠 사람이 바로 알아보게 한다 */
export function formatVerifiedForPrBody(v: VerifiedContext): string {
  const all = [
    ...v.urls.map((c) => ({ ...c, kind: 'Page' })),
    ...v.errors.map((c) => ({ ...c, kind: 'Console error' })),
    ...v.requests.map((c) => ({ ...c, kind: 'Failed request' })),
  ];
  const confirmedTargets = v.targetClaims.filter((c) => c.status === 'confirmed');
  const unverifiedTargets = v.targetClaims.filter((c) => c.status !== 'confirmed');
  if (all.length === 0 && v.targetsForPrBody.length === 0 && v.targetClaims.length === 0) return '';

  const ok = all.filter((c) => c.status !== 'missing');
  const bad = all.filter((c) => c.status === 'missing');

  const out: string[] = [];
  if (ok.length || confirmedTargets.length) {
    out.push("Values sent by the reporter's browser:");
    for (const c of ok) out.push(`- ${c.kind}: \`${c.value}\``);
    for (const c of confirmedTargets) {
      // 「그린다」이지 「원인」이 아니다. 어떤 문자열이 맞았는지도 적어 리뷰어가 직접 확인할 수 있게 한다
      out.push(
        `- Picked element: ${c.labelEn} → ${c.files.map((f) => `\`${f.path}\``).join(', ')} renders it (verified in the source: ${describeMatches(c, 'en')})`,
      );
    }
  }
  if (bad.length) {
    if (out.length) out.push('');
    out.push('⚠️ **The following were not found in this repository.** The reporter sent these values, but no matching file exists:');
    for (const c of bad) out.push(`- ${c.kind}: \`${c.value}\`${c.noteEn ? ` — ${c.noteEn}` : ''}`);
  }
  const unverifiedLines = v.targetClaims.length
    ? unverifiedTargets.flatMap((c) => c.prBodyLines)
    : v.targetsForPrBody;
  if (unverifiedLines.length) {
    if (out.length) out.push('');
    out.push("Picked elements sent by the reporter's browser (unverified input — not found in the repository source):");
    for (const line of unverifiedLines) out.push(line.replace(/^  /, ''));
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 짚은 요소를 레포 «원본»과 대조 (B3 3차, 2026-09-16)
//
// 트리(경로)만으로는 DOM 값을 대조할 수 없다 — 글자·클래스명이 어느 파일에 있는지는 파일 «내용»에
// 있다. 실측(데모 레포)에서 뼈대의 CSS 모듈 클래스 `RegionSelector_pill__f0btH` 가 1-pass 로 하여금
// `RegionSelector.tsx` 를 고르게 했다 — 즉 data-testid·id·안정 클래스·CSS 모듈 앞부분·버튼 글자가
// 강한 단서다. 이걸 «모델의 짐작»에서 «원본에서 확인된 사실»로 올리는 것이 이 절이다.
//
// 흐름: 식별자 추출(순수) → 트리에서 이름 힌트로 후보 파일 ≤ 20 고르기(순수) → 엔진이 blob ≤ 8 개
// 읽기 → 문자열 포함 여부(순수). LLM 호출은 안 늘고 GitHub 호출만 최대 8회 는다.
//
// 🔴 판정은 `confirmed` / `unknown` 둘뿐이다. `missing` 은 안 낸다 — 400개 파일 중 8개를 읽고
// 「없다」고 말할 수 없고, 잘못된 missing 은 진짜 단서를 버린다(위 URL 대조와 같은 편향).
// 🔴 이 값은 무인증 라우트로 아무나 보낸다. 식별자는 글자 집합·길이를 제한하고 정규식은 «우리 형식»에만
// 돌린다. 원본 대조는 `indexOf` 다 — 제보자 문자열로 정규식을 만들지 않는다.
// 🔴 «구조적» 식별자(data-testid·id·class·CSS 모듈)가 있어야만 후보를 고르고 확인한다. 글자(`text`)·aria-label 은
// 보조 근거다 — 보안 리뷰(2026-09-16)가 PoC 로 보였다: URL 경로 하나(`/coupons` → `coupons/page.tsx`) + 흔한 낱말
// 「쿠폰」만 지어내면 DOM 을 만진 적 없이 confirmed 가 됐다. 글자는 데이터·번역 파일도 끌어온다(실측 `lib/i18n/region.ts`).

export type TargetIdentifierKind = 'testid' | 'id' | 'aria' | 'module' | 'class' | 'text';

/** 요소를 «그 파일이 그린다»고 말할 수 있는 식별자 — 글자·aria 는 아니다 */
const STRUCTURAL_KINDS: ReadonlySet<TargetIdentifierKind> = new Set(['testid', 'id', 'module', 'class']);
export const isStructuralIdentifier = (id: Pick<TargetIdentifier, 'kind'>) => STRUCTURAL_KINDS.has(id.kind);

export interface TargetIdentifier {
  kind: TargetIdentifierKind;
  /** 원본 파일에서 찾을 문자열. testid·id·class 는 단어 경계, text 는 그대로 포함 */
  value: string;
  /** CSS 모듈 클래스(`RegionSelector_pill__f0btH`)에서 뽑은 컴포넌트 이름 — 파일명 후보를 고르는 힌트 */
  component?: string;
}

export interface TargetClaim {
  /** 「「서울 종로」 버튼」 */
  label: string;
  /** PR 본문(영어 고정)용 — `"서울 종로" button` */
  labelEn: string;
  /** 프롬프트용(html 뼈대 포함). context.ts formatTargetLines 그대로 */
  lines: string[];
  /** PR 본문용(html 없음) */
  prBodyLines: string[];
  identifiers: TargetIdentifier[];
  status: 'confirmed' | 'unknown';
  /** 이 요소를 그린다고 확인된 파일(≤ 3) 과 거기서 맞은 식별자 */
  files: { path: string; matched: string[] }[];
  /** 이름 힌트로 고른 후보 파일 수. 0 이면 힌트가 없었다 */
  candidates: number;
  /** 그중 실제로 읽은 수. candidates > 0 인데 0 이면 읽기가 전부 실패한 것(권한·네트워크) */
  read: number;
  /** 짚은 페이지 URL — 후보 순위에 쓴다 */
  url?: string;
  /** 조상 태그 경로 — 후보 순위에 약하게 쓴다 */
  path?: string;
}

/** 식별자 문자 집합. 무인증 값이라 여기 없는 글자는 식별자가 못 된다(text 는 예외 — 아래) */
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
/** 요소 하나에서 뽑는 식별자 상한 — 프롬프트·대조 비용의 천장 */
const MAX_IDENTIFIERS = 8;
/** 트리에서 고르는 후보 파일 상한 */
export const MAX_TARGET_CANDIDATES = 20;
/** 실제로 읽는 blob 상한(요소 3개 합쳐서). GitHub 호출 수의 천장 */
export const MAX_TARGET_BLOB_READS = 8;
/** 한 식별자가 이보다 많은 후보 파일에 있으면 «흔한 문자열»로 보고 판정에 안 쓴다 */
const MAX_HITS_PER_IDENTIFIER = 5;
/** 요소당 프롬프트·PR 본문에 싣는 파일 수 */
const MAX_FILES_PER_CLAIM = 3;
const MAX_TEXT_NEEDLE = 64;

const IDENT_KIND_LABEL: Record<TargetIdentifierKind, string> = {
  testid: 'data-testid',
  id: 'id',
  aria: 'aria-label',
  module: 'CSS 모듈 클래스',
  class: 'class',
  text: '글자',
};

const IDENT_KIND_LABEL_EN: Record<TargetIdentifierKind, string> = {
  testid: 'data-testid',
  id: 'id',
  aria: 'aria-label',
  module: 'CSS module class',
  class: 'class',
  text: 'text',
};

/** 뼈대 `html` 은 widget-pick.js 의 skeleton() 이 만든 «우리 형식»이다 — 값은 40자·따옴표는 `'` 로 치환됨 */
const SKELETON_ATTR = /\s(data-testid|id|aria-label|class)="([^"]*)"/g;
/** 이모션·styled-components 해시 클래스 — 빌드마다 바뀌고 소스에 없다 */
const RUNTIME_HASH_CLASS = /^(css|sc)-/;
/** CSS 모듈: `<파일이름>_<클래스>__<해시>`. BEM 의 `block__elem` 과 갈라야 한다 — 해시엔 숫자나 대문자가 있다 */
const CSS_MODULE_CLASS = /^([A-Za-z][A-Za-z0-9-]*)_([A-Za-z][A-Za-z0-9_-]*?)__([A-Za-z0-9_-]{4,})$/;
/** 소스 파일명 힌트로 쓰기엔 너무 흔한 이름 */
const GENERIC_NAMES = new Set([
  'page', 'layout', 'index', 'module', 'styles', 'style', 'main', 'app', 'root', 'item', 'list',
  'wrapper', 'container', 'inner', 'outer', 'content', 'header', 'footer', 'button', 'default',
  'active', 'primary', 'secondary', 'globals', 'component', 'components', 'view', 'section',
]);
/**
 * 유틸리티 클래스(테일윈드류) 첫 세그먼트. `px-4`·`flex-col`·`text-white` 는 거의 모든 파일에 있어
 * «어느 파일이 그리는가»를 못 가른다. `btn-primary` 같은 자기 클래스는 여기 안 걸려 남는다.
 */
const UTILITY_PREFIX = new Set([
  'flex', 'grid', 'items', 'justify', 'text', 'font', 'bg', 'border', 'rounded', 'shadow',
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'w', 'h', 'min', 'max',
  'gap', 'space', 'overflow', 'absolute', 'relative', 'fixed', 'sticky', 'static', 'top', 'left', 'right',
  'bottom', 'inset', 'z', 'opacity', 'transition', 'duration', 'ease', 'delay', 'hover', 'focus', 'active',
  'disabled', 'group', 'peer', 'sm', 'md', 'lg', 'xl', '2xl', 'hidden', 'block', 'inline', 'container',
  'truncate', 'whitespace', 'leading', 'tracking', 'uppercase', 'lowercase', 'capitalize', 'cursor',
  'select', 'pointer', 'outline', 'ring', 'divide', 'place', 'content', 'self', 'order', 'col', 'row',
  'aspect', 'object', 'list', 'align', 'break', 'decoration', 'underline', 'line', 'animate', 'scale',
  'rotate', 'translate', 'origin', 'backdrop', 'blur', 'sr', 'not', 'dark', 'print', 'motion', 'snap',
  'scroll', 'touch', 'will', 'appearance', 'resize', 'fill', 'stroke', 'table', 'isolate', 'visible',
  'invisible', 'float', 'clear', 'box', 'columns', 'prose', 'size', 'basis', 'grow', 'shrink', 'from',
  'via', 'to', 'italic', 'antialiased', 'tabular', 'ordinal', 'transform', 'filter', 'drop', 'mix',
]);

function isHashSuffix(s: string): boolean {
  return /\d/.test(s) || /[A-Z]/.test(s);
}

/** 유틸리티 클래스인가 — 첫 세그먼트가 테일윈드 네임스페이스면 그렇다 */
function isUtilityClass(c: string): boolean {
  const head = c.split('-')[0];
  return UTILITY_PREFIX.has(head);
}

/**
 * 짚은 요소 하나에서 «원본 파일에서 찾을 문자열»을 뽑는다. 순수 함수.
 *
 * - `data-testid` · `id`(자동 생성 숫자 꼬리 제외) · `aria-label` — 소스에 리터럴로 있을 확률이 높다
 * - `class` — CSS 모듈(`RegionSelector_pill__f0btH`)은 `RegionSelector` + `pill` 로 가르고, 이모션·
 *   styled-components 해시·테일윈드 유틸리티·외자 소문자(`primary`)는 뺀다(어느 파일에나 있어 못 가른다)
 * - `text` — 버튼 글자(2~64자). 한글이라 IDENT_RE 밖이지만 대조가 `indexOf` 라 안전하다
 */
export function targetIdentifiers(t: WidgetTarget): TargetIdentifier[] {
  const out: TargetIdentifier[] = [];
  const seen = new Set<string>();
  const push = (id: TargetIdentifier) => {
    if (out.length >= MAX_IDENTIFIERS || seen.has(id.value)) return;
    seen.add(id.value);
    out.push(id);
  };

  const html = typeof t.html === 'string' ? t.html : '';
  for (const m of html.matchAll(SKELETON_ATTR)) {
    const attr = m[1];
    const value = m[2].trim();
    if (!value) continue;
    if (attr === 'data-testid') {
      if (IDENT_RE.test(value)) push({ kind: 'testid', value });
    } else if (attr === 'id') {
      // `radix-:r3:`·`headlessui-menu-123` 류는 렌더마다 바뀐다 — widget-pick.js 의 anchor 규칙과 같다
      if (IDENT_RE.test(value) && !/\d{3,}/.test(value)) push({ kind: 'id', value });
    } else if (attr === 'aria-label') {
      const flat = Array.from(value).slice(0, MAX_TEXT_NEEDLE).join('');
      if (Array.from(flat).length >= 2 && /[\p{L}\p{N}]/u.test(flat)) push({ kind: 'aria', value: flat });
    } else {
      for (const c of value.split(/\s+/)) {
        if (!IDENT_RE.test(c) || RUNTIME_HASH_CLASS.test(c)) continue;
        const mod = c.match(CSS_MODULE_CLASS);
        if (mod && isHashSuffix(mod[3])) {
          const component = GENERIC_NAMES.has(mod[1].toLowerCase()) ? undefined : mod[1];
          const cls = mod[2];
          // `Card_root__Ab12c` — 가장 흔한 CSS 모듈 관례다. 클래스 `root` 는 흔해도 컴포넌트 이름 `Card` 가
          // 파일명 힌트라 버리면 안 된다(코드 리뷰). 둘 다 흔한 이름(`page_root__x`)일 때만 버린다
          if (GENERIC_NAMES.has(cls.toLowerCase()) && !component) continue;
          push({ kind: 'module', value: cls, component });
          continue;
        }
        if (isUtilityClass(c)) continue;
        // 대문자·밑줄이 있거나(컴포넌트식) 하이픈 두 세그먼트 이상(BEM·자기 클래스)이면 가를 힘이 있다.
        // `primary`·`pill` 같은 외자 소문자는 어느 파일에나 있어 못 가른다
        if (/[A-Z_]/.test(c) || c.includes('-')) push({ kind: 'class', value: c });
      }
    }
  }

  const text = typeof t.text === 'string' ? t.text.trim() : '';
  if (text && /[\p{L}\p{N}]/u.test(text)) {
    const cut = Array.from(text).slice(0, MAX_TEXT_NEEDLE).join('');
    if (Array.from(cut).length >= 2) push({ kind: 'text', value: cut });
  }
  return out;
}

function initialTargetClaim(target: WidgetTarget, count: number): TargetClaim {
  const lines = formatTargetLines(target);
  const prBodyLines = formatTargetLines(target, '  ', { html: false, lang: 'en' });
  if (count > 1) {
    lines[0] += ` (${count}건)`;
    prBodyLines[0] += ` (${count} reports)`;
  }
  return {
    label: targetLabel(target, 60),
    labelEn: targetLabelEn(target, 60),
    lines, prBodyLines,
    identifiers: targetIdentifiers(target),
    status: 'unknown', files: [], candidates: 0, read: 0,
    url: target.url, path: target.path,
  };
}

/** `RegionSelector` → `region`·`selector`, `claim-coupon` → `claim`·`coupon`. 4자 이상·흔한 말 제외 */
function nameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4 && !GENERIC_NAMES.has(t));
}

function basenameOf(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.replace(/\.module(?=\.)/, '').replace(/\.[^.]+$/, '').toLowerCase();
}

/** URL 경로 세그먼트 중 파일명 힌트가 될 만한 것 — 숫자·uuid 같은 동적 값은 뺀다 */
function urlSegments(url?: string): string[] {
  if (!url) return [];
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  return pathname.split('/').filter((s) => s.length >= 3 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(s) && !/\d{3,}/.test(s));
}

/**
 * 트리에서 «이 요소를 그릴 법한» 파일을 고른다. 점수가 0 이면 후보가 아니다 — 아무 파일이나 읽지 않는다.
 *
 * 컴포넌트 이름이 파일명과 같으면 +6, 이름 토큰이 파일명에 들면 +3, 짚은 페이지의 URL 세그먼트가
 * 경로에 들면 +2, 조상 태그(form·nav…)가 파일명에 들면 +1, JSX 파일 +1. 모듈 식별자가 있으면 `.module.css` 도 +1.
 *
 * 구조적 식별자가 하나도 없으면 빈 배열이다. URL 세그먼트는 가점일 뿐 혼자서는 후보를 못 만든다 —
 * 앱 라우터 레포는 URL 이 곧 디렉터리라 공개 URL 하나로 후보를 «지정»할 수 있었다(보안 리뷰 M5).
 */
export function rankTargetCandidates(
  claim: Pick<TargetClaim, 'identifiers' | 'url' | 'path'>,
  paths: Iterable<string>,
  limit = MAX_TARGET_CANDIDATES,
): string[] {
  const components = new Set<string>();
  const tokens = new Set<string>();
  let hasModule = false;
  for (const id of claim.identifiers) {
    if (id.kind === 'text' || id.kind === 'aria') continue;
    if (id.kind === 'module') hasModule = true;
    if (id.component) {
      components.add(id.component.toLowerCase());
      for (const t of nameTokens(id.component)) tokens.add(t);
    }
    if (id.kind !== 'module') for (const t of nameTokens(id.value)) tokens.add(t);
  }
  const segs = urlSegments(claim.url);
  const tags = (claim.path ?? '')
    .split('>')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 4 && /^[a-z]+$/.test(s) && !GENERIC_NAMES.has(s) && s !== 'body' && s !== 'html');

  if (!claim.identifiers.some(isStructuralIdentifier)) return [];
  if (components.size === 0 && tokens.size === 0 && segs.length === 0) return [];

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const base = basenameOf(path);
    let score = 0;
    if (components.has(base)) score += 6;
    for (const t of tokens) if (base.includes(t)) score += 3;
    for (const s of segs) if (path.includes(`/${s}/`) || path.includes(`/${s}.`)) score += 2;
    if (score === 0) continue; // 태그·확장자만으로는 후보가 못 된다
    for (const t of tags) if (base.includes(t)) score += 1;
    if (/\.(tsx|jsx)$/.test(path)) score += 1;
    if (hasModule && /\.module\.(css|scss|sass)$/.test(path)) score += 1;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map((s) => s.path);
}

const WORD_CHAR = /[A-Za-z0-9_-]/;

/** 단어 경계 포함 검사. 정규식 없이 indexOf 로 — needle 은 제보자 값이다 */
function hasWord(content: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = content.indexOf(needle, from);
    if (i < 0) return false;
    const before = i > 0 ? content[i - 1] : '';
    const after = content[i + needle.length] ?? '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

function identifierMatches(id: TargetIdentifier, content: string): boolean {
  if (id.kind === 'text' || id.kind === 'aria') return content.includes(id.value);
  return hasWord(content, id.value);
}

/**
 * 읽어 온 후보 원본에서 식별자를 찾아 판정한다. 순수 함수.
 * 후보 5개 넘게 맞는 식별자는 «흔한 문자열»로 보고 버린다 — `pill` 이 파일 열 개에 있으면 아무것도 가르지 못한다.
 * 파일은 **구조적 식별자가 하나라도 맞아야** 「그린다」로 인정한다. 글자만 맞은 파일(지역 이름 데이터·번역 카탈로그)은
 * 이름을 «제공»할 뿐 그리지 않는다 — 글자·aria 는 그 파일의 근거 목록에만 따라붙는다.
 */
export function matchTargetInSources(
  claim: TargetClaim,
  sources: { path: string; content: string }[],
): Pick<TargetClaim, 'status' | 'files'> {
  const perFile = new Map<string, string[]>();
  for (const id of claim.identifiers) {
    const hits = sources.filter((s) => identifierMatches(id, s.content));
    if (hits.length === 0 || hits.length > MAX_HITS_PER_IDENTIFIER) continue;
    for (const h of hits) {
      const list = perFile.get(h.path) ?? [];
      list.push(id.value);
      perFile.set(h.path, list);
    }
  }
  const structural = new Set(claim.identifiers.filter(isStructuralIdentifier).map((i) => i.value));
  const order = new Map(sources.map((s, i) => [s.path, i]));
  const files = Array.from(perFile.entries())
    .filter(([, matched]) => matched.some((m) => structural.has(m)))
    .map(([path, matched]) => ({ path, matched }))
    .sort((a, b) => b.matched.length - a.matched.length || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0))
    .slice(0, MAX_FILES_PER_CLAIM);
  return { status: files.length ? 'confirmed' : 'unknown', files };
}

/**
 * 엔진이 부른다. 후보를 고르고(`rankTargetCandidates`) `readBlob` 으로 원본을 읽어 판정을 올린다.
 * 읽기는 요소 전부 합쳐 `maxReads` 개 — 같은 파일은 한 번만 읽는다. 읽기 실패는 그 파일만 건너뛴다(대조는 보강이지
 * 필수 재료가 아니다). 후보가 없거나 하나도 안 맞으면 `unknown` 그대로 — 그게 오늘까지의 동작이다.
 */
export async function confirmTargetClaims(
  claims: TargetClaim[],
  opts: {
    paths: Iterable<string>;
    readBlob: (path: string) => Promise<string | null>;
    maxReads?: number;
  },
): Promise<TargetClaim[]> {
  const maxReads = opts.maxReads ?? MAX_TARGET_BLOB_READS;
  const paths = Array.from(opts.paths);
  const cache = new Map<string, string | null>();
  let reads = 0;

  const out: TargetClaim[] = [];
  for (const claim of claims) {
    if (claim.identifiers.length === 0) {
      out.push(claim);
      continue;
    }
    const candidates = rankTargetCandidates(claim, paths);
    const sources: { path: string; content: string }[] = [];
    let read = 0;
    for (const path of candidates) {
      if (!cache.has(path)) {
        if (reads >= maxReads) break;
        reads++;
        let content: string | null = null;
        try {
          content = await opts.readBlob(path);
        } catch {
          content = null;
        }
        cache.set(path, content);
      }
      const content = cache.get(path);
      if (typeof content === 'string' && content.length > 0) {
        sources.push({ path, content });
        read++;
      }
    }
    out.push({ ...claim, ...matchTargetInSources(claim, sources), candidates: candidates.length, read });
  }
  return out;
}

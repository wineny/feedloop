// 수정안의 「담당자용 설명」 — 코드를 모르는 사람이 반영 여부를 정하는 재료 (I-19).
//
// 엔진이 2-pass 에서 수정안과 함께 쓴다. 세 칸(무엇이 문제였나 / 무엇을 바꿨나 / 반영되면)에
// 「확인하지 못한 것」이 붙는다. 마지막 것이 핵심이다 — PR #8 은 본문에서 스스로
// 「관련 파일을 못 봐서 예외가 실제로 나는지 모른다」고 자백했는데, 그 정직함이 diff 밑 어딘가가
// 아니라 담당자 눈앞에 있어야 반영을 멈출 수 있다.
//
// 확인 못 한 항목마다 **누가 확인할 수 있는지**를 갈라 둔다. 코드로 확인되는 것(못 읽은 파일이
// 있음)은 [AI 에게 확인시키기] 로 그 파일만 읽고 다시 판단하고, 제보자만 아는 것(데이터·기기)은
// 대화 탭으로 되묻고, 나머지는 사람이 프리뷰에서 본다. 자유 입력은 두지 않는다 —
// 열린 질문은 예산·시간을 못 지키고, 엔진이 스스로 「못 봤다」고 말한 것에만 손잡이를 단다.
//
// 이 모듈은 의존성이 없다. 엔진(생성)·라우트(검증·저장)·화면(표시)이 같은 형태를 본다.

export const VERIFIABLE_BY = ['code', 'reporter', 'human'] as const;
export type VerifiableBy = (typeof VERIFIABLE_BY)[number];

export const VERDICT_STATUS = ['fix_holds', 'fix_does_not_hold', 'inconclusive'] as const;
export type VerdictStatus = (typeof VERDICT_STATUS)[number];

export interface UnverifiedVerdict {
  status: VerdictStatus;
  /** 담당자 말로 쓴 판정 이유 */
  text: string;
  checkedAt: string;
  /** 실제로 읽은 파일 */
  files: string[];
}

export interface UnverifiedItem {
  text: string;
  verifiableBy: VerifiableBy;
  /** `code` 일 때 읽어야 할 레포 파일 — 레포에 실재하는 경로만 남는다 */
  files: string[];
  /** `reporter` 일 때 제보자에게 보낼 질문 초안 */
  question: string | null;
  /** [AI 에게 확인시키기] 결과. 없으면 아직 안 시켰다 */
  verdict: UnverifiedVerdict | null;
}

export interface RunExplanation {
  problem: string;
  change: string;
  effect: string;
  unverified: UnverifiedItem[];
  /** `model` = 엔진이 수정안과 함께 씀 · `pr_body` = 이 기능 전의 실행을 PR 본문에서 뽑음 */
  source: 'model' | 'pr_body';
}

/** 담당자가 읽는 글이다. 길면 안 읽는다 — 상한을 넘으면 자른다(거절이 아니라). */
export const EXPLANATION_FIELD_MAX = 600;
export const UNVERIFIED_TEXT_MAX = 400;
export const UNVERIFIED_QUESTION_MAX = 200;
export const UNVERIFIED_MAX_ITEMS = 6;
export const UNVERIFIED_MAX_FILES = 3;
export const VERDICT_TEXT_MAX = 800;

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function isVerifiableBy(v: unknown): v is VerifiableBy {
  return typeof v === 'string' && (VERIFIABLE_BY as readonly string[]).includes(v);
}

export function isVerdictStatus(v: unknown): v is VerdictStatus {
  return typeof v === 'string' && (VERDICT_STATUS as readonly string[]).includes(v);
}

/**
 * 레포 안의 상대 POSIX 경로만. 절대경로·`..`·백슬래시·제어문자를 거른다 — 이 값은 나중에
 * `repos.getContent({ path })` 로 GitHub 에 그대로 가고, `{+path}` 템플릿은 예약 문자를 인코딩하지
 * 않아 `../` 가 다른 API 엔드포인트로 풀린다. 쓰는 쪽(엔진 grounding)뿐 아니라 읽는 쪽에도 방어선을 둔다.
 */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false;
  if (/^[a-z]+:/i.test(p)) return false; // 스킴처럼 보이는 것
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * @param strict 저장된 값을 읽을 때 true — 레포 경로 형태만. 모델 출력을 받을 때는 false —
 *   `./x`·`../x` 같은 import 표기도 받아 `groundUnverifiedFiles` 가 실제 경로로 바꾸게 둔다
 *   (바꾸지 못한 것은 거기서 버려지므로 저장되는 값은 늘 실제 레포 경로다).
 */
function fileList(v: unknown, strict: boolean): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== 'string') continue;
    const t = f.trim();
    const ok = strict ? isSafeRepoPath(t) : t.length > 0 && t.length <= 300 && !/[\x00-\x1f\x7f]/.test(t);
    if (!ok || out.includes(t)) continue;
    out.push(t);
    if (out.length >= UNVERIFIED_MAX_FILES) break;
  }
  return out;
}

/**
 * 모델 JSON 의 `explanation`·`unverified` 를 우리 형태로. 모델이 형식을 어기면 그 부분만 버린다 —
 * 설명이 없다고 수정안 자체를 버리지는 않는다(설명은 보강이지 필수 재료가 아니다).
 *
 * `verifiable_by` 가 없으면 파일이 있으면 code, 질문이 있으면 reporter, 아니면 human 으로 본다.
 * 파일 경로의 실재 여부는 여기서 모른다 — 엔진이 레포 트리를 들고 `groundUnverifiedFiles` 로 거른다.
 */
export function normalizeExplanation(raw: {
  explanation?: unknown;
  unverified?: unknown;
}): RunExplanation | null {
  const ex = raw.explanation;
  if (!ex || typeof ex !== 'object') return null;
  const e = ex as Record<string, unknown>;
  const problem = str(e.problem, EXPLANATION_FIELD_MAX);
  const change = str(e.change, EXPLANATION_FIELD_MAX);
  const effect = str(e.effect, EXPLANATION_FIELD_MAX);
  if (!problem && !change) return null;

  const unverified: UnverifiedItem[] = [];
  if (Array.isArray(raw.unverified)) {
    for (const item of raw.unverified) {
      if (!item || typeof item !== 'object') continue;
      const u = item as Record<string, unknown>;
      const text = str(u.text, UNVERIFIED_TEXT_MAX);
      if (!text) continue;
      const files = fileList(u.files, false);
      const question = str(u.question, UNVERIFIED_QUESTION_MAX) || null;
      let verifiableBy: VerifiableBy = isVerifiableBy(u.verifiable_by)
        ? u.verifiable_by
        : files.length > 0
          ? 'code'
          : question
            ? 'reporter'
            : 'human';
      // 읽을 파일이 없는 「코드로 확인」은 버튼을 눌러도 할 일이 없다 — 사람 몫으로 내린다
      if (verifiableBy === 'code' && files.length === 0) verifiableBy = 'human';
      unverified.push({
        text,
        verifiableBy,
        files: verifiableBy === 'code' ? files : [],
        question: verifiableBy === 'reporter' ? question : null,
        verdict: null,
      });
      if (unverified.length >= UNVERIFIED_MAX_ITEMS) break;
    }
  }

  return { problem, change, effect, unverified, source: 'model' };
}

/**
 * `code` 항목의 파일을 레포에 실재하는 경로로 바꾼다. 못 푸는 경로는 버리고, 파일이 하나도
 * 안 남으면 그 항목은 `human` 으로 내린다. 모델은 `@/lib/x` 같은 별칭이나 `identity.ts` 같은
 * 꼬리만 적기도 한다 — `resolve` 가 그것을 푼다(엔진이 imports.ts 의 해석기를 넘겨준다).
 */
export function groundUnverifiedFiles(
  explanation: RunExplanation,
  resolve: (candidate: string) => string | null,
): RunExplanation {
  return {
    ...explanation,
    unverified: explanation.unverified.map((item) => {
      if (item.verifiableBy !== 'code') return item;
      const files = item.files.map(resolve).filter((p): p is string => Boolean(p));
      const unique = [...new Set(files)];
      if (unique.length === 0) return { ...item, verifiableBy: 'human', files: [] };
      return { ...item, files: unique };
    }),
  };
}

/**
 * 레포 경로 하나를 푼다 — 정확히 있으면 그대로, 별칭이면 import 해석기로, 꼬리만 적혔으면
 * 유일하게 끝나는 경로로. 둘 이상 맞으면 어느 것인지 모르니 null.
 */
export function makeRepoPathResolver(
  blobPaths: Set<string>,
  resolveImport: (spec: string, fromPath: string) => string | null,
  fromPath: string,
): (candidate: string) => string | null {
  return (candidate) => {
    const c = candidate.replace(/^\.?\//, '').trim();
    if (!c) return null;
    if (blobPaths.has(c)) return c;
    if (/^[@~]\//.test(candidate) || candidate.startsWith('./') || candidate.startsWith('../')) {
      const hit = resolveImport(candidate, fromPath);
      if (hit) return hit;
    }
    const tails: string[] = [];
    for (const p of blobPaths) {
      if (p === c || p.endsWith(`/${c}`)) tails.push(p);
    }
    return tails.length === 1 ? tails[0] : null;
  };
}

/**
 * DB 에서 읽은 값을 검증한다. 화면과 라우트가 같은 형태를 기대하므로 컬럼이 손으로 고쳐졌거나
 * 옛 형태여도 여기서 걸러진다. 형태가 아니면 null.
 */
export function parseStoredExplanation(raw: unknown): RunExplanation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source = r.source === 'pr_body' ? 'pr_body' : 'model';
  const problem = str(r.problem, EXPLANATION_FIELD_MAX);
  const change = str(r.change, EXPLANATION_FIELD_MAX);
  const effect = str(r.effect, EXPLANATION_FIELD_MAX);
  if (!problem && !change) return null;

  const unverified: UnverifiedItem[] = [];
  if (Array.isArray(r.unverified)) {
    for (const item of r.unverified) {
      if (!item || typeof item !== 'object') continue;
      const u = item as Record<string, unknown>;
      const text = str(u.text, UNVERIFIED_TEXT_MAX);
      if (!text) continue;
      const verifiableBy = isVerifiableBy(u.verifiableBy) ? u.verifiableBy : 'human';
      let verdict: UnverifiedVerdict | null = null;
      if (u.verdict && typeof u.verdict === 'object') {
        const v = u.verdict as Record<string, unknown>;
        if (isVerdictStatus(v.status) && typeof v.checkedAt === 'string') {
          verdict = {
            status: v.status,
            text: str(v.text, VERDICT_TEXT_MAX),
            checkedAt: v.checkedAt,
            files: fileList(v.files, true),
          };
        }
      }
      unverified.push({
        text,
        verifiableBy,
        files: verifiableBy === 'code' ? fileList(u.files, true) : [],
        question: verifiableBy === 'reporter' ? str(u.question, UNVERIFIED_QUESTION_MAX) || null : null,
        verdict,
      });
      if (unverified.length >= UNVERIFIED_MAX_ITEMS) break;
    }
  }
  return { problem, change, effect, unverified, source };
}

/** 우리가 조립한 PR 본문(`composePrBody`)의 고정 절 — 옛 실행의 설명을 여기서 뽑는다 */
const LEGACY_FIXED_CHECKS = [
  // 한국어(i18n 4d 이전에 만든 PR 본문) · 영어(지금)
  '이 수정이 실제로 위 증상을 없애는지 직접 확인',
  '빌드·타입 검사 통과 확인',
  'Check yourself that this change removes the symptom above',
  'Check that the build and type check pass',
];
/** composePrBody 의 고정 절 제목 — 옛 한국어와 지금 영어를 둘 다 읽는다 */
const SECTION_CAUSE = ['Root cause', '원인 분석'];
const SECTION_CHECKLIST = ['Before you merge', '머지 전 확인'];

/**
 * 이 기능 전에 만들어진 실행은 설명 컬럼이 비어 있다. PR 본문은 우리가 조립했으므로
 * 「원인 분석」 절과 「머지 전 확인」 체크리스트를 알고 있다 — 그걸로 최선의 설명을 만든다.
 * 담당자 말로 다시 쓴 것은 아니라서 `source: 'pr_body'` 로 표시하고 화면이 그 사실을 말한다.
 */
export function extractLegacyExplanation(prBody: string | null | undefined): RunExplanation | null {
  if (!prBody) return null;
  const sections = new Map<string, string>();
  let intro = '';
  const parts = prBody.split(/^## +/m);
  intro = (parts.shift() ?? '').trim();
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? '' : part.slice(nl + 1).trim();
    sections.set(title, body);
  }

  // 우리가 조립한 본문(composePrBody)만 다룬다. 고정 절이 하나도 없으면 사람이 쓴 PR 이라
  // 머리말을 「무엇을 바꿨나」로 띄우면 엉뚱한 글이 설명 자리에 앉는다 — 설명 없음으로 둔다
  const pick = (titles: string[]) => titles.map((t) => sections.get(t)).find((v) => v !== undefined);
  if (pick(SECTION_CAUSE) === undefined && pick(SECTION_CHECKLIST) === undefined) return null;
  const problem = str(pick(SECTION_CAUSE) ?? '', EXPLANATION_FIELD_MAX);
  // 본문 맨 앞이 모델의 pr_body(무엇을 어떻게 바꾸는지) 다. 구분선 뒤 자동 생성 안내는 뺀다
  const change = str(intro.split(/^---$/m)[0] ?? '', EXPLANATION_FIELD_MAX);
  if (!problem && !change) return null;

  const unverified: UnverifiedItem[] = [];
  const checklist = pick(SECTION_CHECKLIST) ?? '';
  for (const line of checklist.split('\n')) {
    const m = line.match(/^- \[[ x]\]\s*(.+)$/);
    if (!m) continue;
    const text = m[1].replace(/^⚠️\s*/, '').trim();
    if (LEGACY_FIXED_CHECKS.some((fixed) => text.startsWith(fixed))) continue;
    const t = str(text, UNVERIFIED_TEXT_MAX);
    if (!t) continue;
    unverified.push({ text: t, verifiableBy: 'human', files: [], question: null, verdict: null });
    if (unverified.length >= UNVERIFIED_MAX_ITEMS) break;
  }

  return { problem, change, effect: '', unverified, source: 'pr_body' };
}

/** 확인 결과를 항목에 적는다. 없는 index 면 null — 호출부가 409 로 답한다. */
export function withVerdict(
  explanation: RunExplanation,
  index: number,
  verdict: UnverifiedVerdict,
): RunExplanation | null {
  if (!Number.isInteger(index) || index < 0 || index >= explanation.unverified.length) return null;
  return {
    ...explanation,
    unverified: explanation.unverified.map((item, i) => (i === index ? { ...item, verdict } : item)),
  };
}

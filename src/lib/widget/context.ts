// 위젯이 함께 보내는 기술 맥락 — 검증 · 마스킹 · 프롬프트 변환.
//
// 이 값은 **무인증 공개 라우트로 아무나 보낼 수 있다.** 위젯이 보낸 것처럼
// 꾸며서 아무 문자열이나 넣을 수 있으므로, 크기·모양을 전부 여기서 강제한다.
// 통과한 값은 그대로 자동 PR 프롬프트에 실리므로 상한이 곧 비용 상한이다.
//
// 그리고 이건 **남의 사이트에서 도는 스크립트가 걷어온 값**이다.
// URL 쿼리에 토큰·이메일이 실려 오는 일이 흔하다 — 저장 전에 지운다.

import type { ContextItems } from './verify-context';
import { collapseWhitespace } from '@/lib/text';
import { TARGET_KIND, TARGET_KIND_DEFAULT, targetLabel, targetLabelEn, type WidgetTarget } from './pick';

export interface WidgetContext {
  url?: string;
  user_agent?: string;
  viewport?: string;
  screen?: string;
  language?: string;
  errors?: string[];
  failed_requests?: string[];
  /** 방문자가 「화면에서 짚기」로 고른 요소 (B3, 2026-09-16). 셀렉터·글자·outerHTML 조각 */
  target?: WidgetTarget;
}

const MAX_URL = 500;
const MAX_UA = 300;
const MAX_SHORT = 64;
const MAX_ERRORS = 5;
const MAX_ERROR_CHARS = 300;
const MAX_REQUESTS = 5;
const MAX_REQUEST_CHARS = 200;
/** 짚은 요소 — outerHTML 은 페이지 «내용»이 실려 온다(다른 방문자 이름·이메일). 마스킹 필수 */
const MAX_TARGET_SELECTOR = 400;
const MAX_TARGET_TEXT = 120;
const MAX_TARGET_LABEL = 100;
const MAX_TARGET_PATH = 200;
const MAX_TARGET_HTML = 600;
const MAX_TARGET_KIND = 8;
const MAX_TARGET_TAG = 32;
const MAX_TARGET_HEADING = 60;
const SHOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 위젯의 KIND 표에 없는 종류가 오면 «영역» — 무인증 값이라 프롬프트에 임의 단어를 못 싣게 */
const TARGET_KINDS = new Set([...Object.values(TARGET_KIND), TARGET_KIND_DEFAULT]);
const MAX_TARGET_COORD = 100_000;

/** 이름만 봐도 값이 비밀인 쿼리 키. 값을 통째로 가린다. */
const SENSITIVE_PARAM =
  /(token|key|secret|password|passwd|pwd|auth|session|sid|email|mail|phone|tel|code|otp|signature|sig|credential|apikey)/i;

/** 값 자체가 비밀처럼 생긴 것 — 키 이름이 평범해도 가린다. */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;
/** 32자 이상 이어지는 영숫자 덩어리 — API 키·세션 토큰의 흔한 모양 */
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

const MASK = '***';

/** 자유 텍스트(에러 메시지 등)에서 비밀처럼 생긴 것을 지운다. */
export function maskSecrets(text: string): string {
  return text
    .replace(JWT_RE, MASK)
    .replace(EMAIL_RE, MASK)
    .replace(LONG_TOKEN_RE, MASK);
}

/**
 * URL 을 저장 가능한 모양으로 줄인다.
 * 쿼리는 통째로 버리지 않는다 — `?tab=kakao` 처럼 재현에 필요한 값이 흔하다.
 * 대신 민감한 키의 값만 가리고, 해시(#)는 버린다.
 */
export function sanitizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  // http(s) 가 아니면 버린다 (javascript:, data: 등)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  // https://user:pass@host/ 형태로 자격증명이 실려 오는 경우가 있다. 통째로 버린다.
  parsed.username = '';
  parsed.password = '';

  // 경로에도 비밀이 실린다 — /users/{email}/orders/{apiKey} 는 REST 에서 흔한 모양이다.
  // 쿼리만 가리면 여기로 새어 나간다(실측으로 확인된 누출 경로).
  // 인코딩된 값(%40 등)까지 잡으려면 디코딩 후 마스킹해야 한다.
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 잘못된 % 시퀀스면 원본 그대로 검사한다 */
  }
  parsed.pathname = maskSecrets(path);

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_PARAM.test(key)) {
      parsed.searchParams.set(key, MASK);
      continue;
    }
    const value = parsed.searchParams.get(key) ?? '';
    const masked = maskSecrets(value);
    if (masked !== value) parsed.searchParams.set(key, masked);
  }
  parsed.hash = '';

  return parsed.toString().slice(0, MAX_URL);
}

/**
 * 한 줄 문자열로. 이 값들은 «줄 단위» 프롬프트와 PR 본문에 그대로 보간된다 — 개행이 남으면
 * 익명 방문자가 `\n- 새 지시` 로 줄을 하나 더 만들 수 있다(보안 리뷰 H1 실측). `collapseWhitespace`
 * 가 제로폭·양방향 재정의 문자까지 지워 인박스 라벨의 시각 위조도 같이 닫힌다.
 * 백틱은 코드 스팬 밖으로 «탈출»하는 글자라 `'` 로 바꾼다. 마스킹은 자른 «뒤»에 — 64KB 본문 전체에
 * 정규식을 돌릴 이유가 없다(자른 경계의 토큰이 살아남는 건 32자 미만 조각이라 어차피 매치 대상이 아니다).
 */
function shortString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = collapseWhitespace(value.slice(0, max * 4)).replace(/`/g, "'");
  if (!flat) return undefined;
  // 코드포인트 단위 — UTF-16 slice 는 이모지 가운데를 쪼개 외톨이 서로게이트를 jsonb 에 넣는다(코드 리뷰 M2)
  return maskSecrets(Array.from(flat).slice(0, max).join(''));
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((v) => shortString(v, maxChars))
    .filter((v): v is string => v !== undefined)
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

/**
 * 브라우저 확장이 낸 에러를 알아보는 표시 (I-45).
 *
 * 위젯은 호스트 페이지의 콘솔 에러를 걷어 제보와 함께 보내는데, 방문자가 깔아 둔 확장
 * (지갑·번역기·광고차단…)이 낸 것도 섞인다. 그건 **호스트 사이트의 버그가 아니다.**
 * 그대로 두면 요약이 그걸 증상으로 받아 적고, 묶기가 그 문자열을 기준으로
 * 전혀 다른 제보들을 한 묶음에 넣는다 — 실측: 「쿠폰 사용 버튼이 안 먹는다」가
 * 「MetaMask 연결 실패」 묶음에 합류했다(2026-09-18 전수 QA §3).
 *
 * 스킴이 남아 있는 것만 판단한다. 문자열에 단서가 없는 확장 에러까지 걸러 내려면
 * 제품 이름 목록이 필요한데, 그러면 호스트가 «정말» 그 기능을 쓸 때 진짜 버그를 놓친다.
 * 1차 방어는 위젯 쪽(`public/widget.js`)이 스택·출처를 보고 애초에 안 싣는 것이고,
 * 여기는 그걸 통과한 값을 한 번 더 거르는 자리다.
 */
const EXTENSION_ORIGIN = /(?:chrome|moz|safari-web|ms-browser)-extension:\/\//i;

/** 확장이 낸 티가 나는 항목인가. */
export function isExtensionNoise(entry: unknown): boolean {
  return typeof entry === 'string' && EXTENSION_ORIGIN.test(entry);
}

function intCoord(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  return Math.abs(n) > MAX_TARGET_COORD ? undefined : n;
}

/**
 * 짚은 요소를 저장 가능한 모양으로. `selector` 가 없으면 통째로 버린다 — 셀렉터가 이 값의 정체다.
 *
 * outerHTML 은 페이지에 렌더된 «다른 사람의» 값이 들어올 수 있다(주문 목록의 이메일, 회원 이름).
 * 글자·라벨·html 전부 maskSecrets 를 지난다. 위치는 정수로 접고 터무니없는 값은 버린다.
 */
export function sanitizeTarget(raw: unknown): WidgetTarget | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const selector = shortString(t.selector, MAX_TARGET_SELECTOR);
  if (!selector) return undefined;
  const tag = shortString(t.tag, MAX_TARGET_TAG)?.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const kindRaw = shortString(t.kind, MAX_TARGET_KIND);
  const out: WidgetTarget = {
    kind: kindRaw && TARGET_KINDS.has(kindRaw) ? kindRaw : TARGET_KIND_DEFAULT,
    tag: tag || 'div',
    selector,
  };
  const text = shortString(t.text, MAX_TARGET_TEXT);
  if (text) out.text = text;
  const label = shortString(t.label, MAX_TARGET_LABEL);
  if (label) out.label = label;
  const path = shortString(t.path, MAX_TARGET_PATH);
  if (path) out.path = path;
  const html = shortString(t.html, MAX_TARGET_HTML);
  if (html) out.html = html;
  if (t.rect && typeof t.rect === 'object' && !Array.isArray(t.rect)) {
    const r = t.rect as Record<string, unknown>;
    const x = intCoord(r.x), y = intCoord(r.y), w = intCoord(r.w), h = intCoord(r.h);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) out.rect = { x, y, w, h };
  }
  if (typeof t.url === 'string') {
    const url = sanitizeUrl(t.url);
    if (url) out.url = url;
  }
  if (typeof t.viewport === 'string' && /^\d{1,5}x\d{1,5}$/.test(t.viewport)) out.viewport = t.viewport;
  const heading = shortString(t.heading, MAX_TARGET_HEADING);
  if (heading) out.heading = heading;
  // 스크린샷 id. UUID 모양만 통과 — 실제로 이 방문자 것인지는 messages POST 가 붙일 때(attachShot) 본다
  if (typeof t.shot === 'string' && SHOT_ID_RE.test(t.shot)) out.shot = t.shot.toLowerCase();
  return out;
}

/**
 * 위젯이 보낸 값을 저장 가능한 모양으로 정규화한다.
 * 쓸 만한 게 하나도 없으면 null — 컬럼을 비워둔다.
 */
export function sanitizeWidgetContext(raw: unknown): WidgetContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const ctx: WidgetContext = {};

  if (typeof input.url === 'string') {
    const url = sanitizeUrl(input.url);
    if (url) ctx.url = url;
  }
  const ua = shortString(input.user_agent, MAX_UA);
  if (ua) ctx.user_agent = ua;

  const viewport = shortString(input.viewport, MAX_SHORT);
  if (viewport) ctx.viewport = viewport;

  const screen = shortString(input.screen, MAX_SHORT);
  if (screen) ctx.screen = screen;

  const language = shortString(input.language, MAX_SHORT);
  if (language) ctx.language = language;

  // 확장이 낸 것은 «자르기 전에» 뺀다. 나중에 빼면 확장 에러가 상한 5칸을 채워
  // 진짜 에러가 밀려난 뒤라, 걷어내고 나면 빈손이 된다.
  const rawErrors = Array.isArray(input.errors) ? input.errors.filter((e) => !isExtensionNoise(e)) : input.errors;
  const errors = stringList(rawErrors, MAX_ERRORS, MAX_ERROR_CHARS);
  if (errors) ctx.errors = errors;

  const requests = stringList(input.failed_requests, MAX_REQUESTS, MAX_REQUEST_CHARS);
  if (requests) ctx.failed_requests = requests;

  const target = sanitizeTarget(input.target);
  if (target) ctx.target = target;

  return Object.keys(ctx).length > 0 ? ctx : null;
}

/**
 * 짚은 요소를 프롬프트·PR 본문용 여러 줄로. 첫 줄이 이름(「「쿠폰 받기」 버튼」), 그 밑에 셀렉터·
 * 경로·html 조각. html 은 코드 펜스 없이 한 줄로 접는다 — 마크다운 안에서 태그가 살아나지 않게
 * 백틱으로 감싼다.
 */
export function formatTargetLines(t: WidgetTarget, indent = '  ', opts: { html?: boolean; lang?: 'ko' | 'en' } = {}): string[] {
  // 저장된 값은 sanitizeTarget 을 지났지만(한 줄·백틱 없음), 옛 행이나 다른 경로가 있을 수 있어 한 번 더 접는다.
  const one = (s: string) => collapseWhitespace(s).replace(/`/g, "'");
  // 프롬프트용은 한국어(5단계에서 같이 손본다), GitHub PR 본문용(`lang: 'en'`)은 영어 고정
  const en = opts.lang === 'en';
  const L = en
    ? { page: 'page', selector: 'selector', label: 'nearby label', path: 'position', rect: 'viewport coordinates' }
    : { page: '페이지', selector: '셀렉터', label: '주변 라벨', path: '위치', rect: '화면 좌표' };
  const head = en ? targetLabelEn(t, 60) : targetLabel(t, 60);
  const lines = [`${indent}· ${one(head)} <${one(t.tag)}>${t.url ? ` — ${L.page} ${one(t.url)}` : ''}`];
  lines.push(`${indent}  ${L.selector}: \`${one(t.selector)}\``);
  if (t.label && t.label !== t.text) lines.push(`${indent}  ${L.label}: ${one(t.label)}`);
  if (t.path) lines.push(`${indent}  ${L.path}: ${one(t.path)}`);
  if (t.rect) lines.push(`${indent}  ${L.rect}: (${t.rect.x}, ${t.rect.y}) ${t.rect.w}×${t.rect.h}px`);
  // html 뼈대는 프롬프트에만(기본). PR 본문은 GitHub 에 남는 글이라 페이지 조각을 싣지 않는다(보안 리뷰 H2)
  if (t.html && opts.html !== false) lines.push(`${indent}  html: \`${one(t.html)}\``);
  return lines;
}

/**
 * 자동 PR 프롬프트에 넣을 한 덩어리로 바꾼다.
 * 값이 없으면 빈 문자열 — 프롬프트에 빈 껍데기 섹션이 생기지 않게 한다.
 */
export function formatContextForPrompt(ctx: unknown): string {
  const c = sanitizeWidgetContext(ctx);
  if (!c) return '';

  const lines: string[] = [];
  if (c.url) lines.push(`- 발생 페이지: ${c.url}`);
  if (c.viewport) lines.push(`- 뷰포트: ${c.viewport}${c.screen ? ` (화면 ${c.screen})` : ''}`);
  if (c.user_agent) lines.push(`- 브라우저: ${c.user_agent}`);
  if (c.language) lines.push(`- 언어: ${c.language}`);
  if (c.errors?.length) {
    // 「참고」라고 못박는다 — 방문자가 말하지 않은 에러 문구가 요약 제목에 박히면
    // 묶기가 그 문자열로 엉뚱한 제보들을 한데 묶는다(I-45).
    lines.push(`- 콘솔 에러 ${c.errors.length}건 (참고용. 방문자가 깔아 둔 브라우저 확장이 낸 것일 수 있다 — 방문자가 직접 말하지 않은 내용은 요약·제목에 넣지 말 것):`);
    for (const e of c.errors) lines.push(`  · ${e}`);
  }
  if (c.failed_requests?.length) {
    lines.push(`- 실패한 요청 ${c.failed_requests.length}건:`);
    for (const r of c.failed_requests) lines.push(`  · ${r}`);
  }
  if (c.target) {
    lines.push('- 제보자가 화면에서 짚은 요소:');
    lines.push(...formatTargetLines(c.target));
  }

  return lines.join('\n');
}

/**
 * 묶음 실행용 — 여러 제보의 맥락을 한 덩어리로 합친다.
 *
 * 묶음은 "여러 사람이 같은 문제를 말한 것" 이므로 페이지와 에러가 겹치는 게 정상이다.
 * 겹치는 것을 지우면 오히려 신호가 죽으므로, 중복은 **횟수와 함께** 남기고
 * 많이 나온 것부터 보여준다. 그게 곧 "어디가 문제인지" 의 근거다.
 */
export function mergeContextsForPrompt(raws: unknown[]): string {
  const { urls, errors, requests, targets } = tally(raws);

  const lines: string[] = [];

  const topUrls = top(urls, 3);
  if (topUrls.length) {
    lines.push('- 발생 페이지:');
    for (const u of topUrls) lines.push(`  · ${u}`);
  }

  const topErrors = top(errors, MAX_ERRORS);
  if (topErrors.length) {
    lines.push('- 콘솔 에러:');
    for (const e of topErrors) lines.push(`  · ${e}`);
  }

  const topRequests = top(requests, MAX_REQUESTS);
  if (topRequests.length) {
    lines.push('- 실패한 요청:');
    for (const r of topRequests) lines.push(`  · ${r}`);
  }

  const topTargets = topTargetLines(targets);
  if (topTargets.length) {
    lines.push('- 제보자들이 화면에서 짚은 요소:');
    lines.push(...topTargets);
  }

  return lines.join('\n');
}

/**
 * 여러 제보의 맥락을 «횟수와 함께» 센다. 프롬프트 문자열(`mergeContextsForPrompt`)과 검증용 원자료
 * (`collectContextItems`)가 같은 집계를 써야 한다 — 두 벌이면 한쪽만 고쳐져 단건과 묶음이 다른 것을 본다.
 */
function tally(raws: unknown[]) {
  const urls = new Map<string, number>();
  const errors = new Map<string, number>();
  const requests = new Map<string, number>();
  const targets = new Map<string, { t: WidgetTarget; n: number }>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const raw of raws) {
    const c = sanitizeWidgetContext(raw);
    if (!c) continue;
    if (c.url) bump(urls, c.url);
    for (const e of c.errors ?? []) bump(errors, e);
    for (const r of c.failed_requests ?? []) bump(requests, r);
    if (c.target) {
      const hit = targets.get(c.target.selector);
      if (hit) hit.n++;
      else targets.set(c.target.selector, { t: c.target, n: 1 });
    }
  }
  return { urls, errors, requests, targets };
}

/** 많이 나온 것부터 limit 개, 2건 이상이면 횟수를 붙인다 */
const top = (map: Map<string, number>, limit: number) =>
  Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => (count > 1 ? `${value} (${count}건)` : value));

/** 같은 셀렉터를 여러 사람이 짚었으면 횟수를 첫 줄에 붙인다. 최대 3개 */
const MAX_TARGETS = 3;
function topTargets(targets: Map<string, { t: WidgetTarget; n: number }>): { t: WidgetTarget; n: number }[] {
  return Array.from(targets.values())
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_TARGETS);
}
function topTargetLines(targets: Map<string, { t: WidgetTarget; n: number }>, opts: { html?: boolean; lang?: 'ko' | 'en' } = {}): string[] {
  return topTargets(targets)
    .flatMap(({ t, n }) => {
      const lines = formatTargetLines(t, '  ', opts);
      if (n > 1) lines[0] += opts.lang === 'en' ? ` (${n} reports)` : ` (${n}건)`;
      return lines;
    });
}

/**
 * 검증(`verify-context.ts`)에 넘길 원자료. 문자열로 굳히기 전 단계다.
 *
 * `mergeContextsForPrompt` 와 같은 규칙으로 고른다 — 중복은 지우지 않고
 * **횟수와 함께** 남기고 많이 나온 것부터다. 여러 사람이 같은 페이지를
 * 말했다는 사실 자체가 신호이기 때문이다.
 *
 * 단건도 이 경로를 탄다(`raws` 에 하나만 넣으면 된다). 단건과 묶음이
 * 서로 다른 코드를 타면 한쪽만 검증되는 사고가 난다.
 */
export function collectContextItems(raws: unknown[]): ContextItems {
  const { urls, errors, requests, targets } = tally(raws);

  return {
    urls: top(urls, 3),
    errors: top(errors, MAX_ERRORS),
    requests: top(requests, MAX_REQUESTS),
    targets: topTargetLines(targets),
    // PR 본문용 — html 뼈대 없이. 방문자가 짚은 «표의 한 행» 같은 페이지 조각이 고객사 GitHub 에 남으면 안 된다
    targetsForPrBody: topTargetLines(targets, { html: false, lang: 'en' }),
    // 원자료 — 엔진이 레포 «원본»과 대조하려면 문자열로는 안 된다(B3 3차). 위 두 줄과 같은 순서·같은 상한
    targetItems: topTargets(targets).map(({ t, n }) => ({ target: t, count: n })),
  };
}

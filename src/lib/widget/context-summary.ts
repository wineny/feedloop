// 제보 맥락(messages.context)을 운영자 화면 한 줄로 (셀프 QA [3] 답 항목 · B3, 2026-09-16).
//
// 의존성 0 — `/inbox` 클라이언트 컴포넌트가 그대로 import 한다. 값은 서버(context.ts)가 이미
// 정규화·마스킹한 것이지만, 화면에 그대로 뿌리기엔 UA 문자열이 너무 길다. 여기서 «사람이 읽을 말»로 줄인다.

import { targetLabel, type WidgetTarget } from './pick';

export interface ContextSummary {
  /** `/coupons?tab=used` — 오리진 없이 경로+쿼리. 없으면 undefined */
  page?: string;
  /** `390×844` */
  viewport?: string;
  /** `Safari · iPhone` */
  browser?: string;
  /** 콘솔 에러·실패 요청 건수 */
  errors: number;
  requests: number;
  /** 짚은 요소 — 「「쿠폰 받기」 버튼」 + 셀렉터 */
  target?: {
    label: string;
    selector: string;
    page?: string;
    /** 짚은 시점 페이지 전체 주소(target.url, 없으면 context.url) — 운영자 화면 「제보된 페이지」 링크 */
    url?: string;
    /** 뷰포트 기준 위치 — 스크린샷 위 테두리·미니맵 폴백이 쓴다 */
    rect?: { x: number; y: number; w: number; h: number };
    /** 짚은 시점의 뷰포트 크기(context.viewport). 미니맵 비율과 좌표 환산의 기준 */
    viewport?: { w: number; h: number };
    /** 스크린샷이 붙었던 메시지인가 — 붙었는데 이미지가 없으면 보존 기간이 지났거나 서명에 실패한 것 */
    hadShot: boolean;
  };
}

function validRect(r: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, unknown>;
  const nums = [o.x, o.y, o.w, o.h];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
}

/** UA 를 「브라우저 · 기기」로. 정확한 버전은 필요 없다 — 재현할 때 무엇으로 열지가 정보다 */
export function shortUserAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung'
      : /Whale/.test(ua)
        ? 'Whale'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : '';
  return [browser, device].filter(Boolean).join(' · ');
}

function pathOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return undefined;
  }
}

/** context 컬럼 값(정규화된 JSON)을 요약. 아무것도 없으면 null — 그 말풍선엔 줄을 안 그린다 */
export function summarizeContext(raw: unknown): ContextSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const out: ContextSummary = { errors: 0, requests: 0 };

  if (typeof c.url === 'string') out.page = pathOf(c.url);
  if (typeof c.viewport === 'string' && /^\d+x\d+$/.test(c.viewport)) out.viewport = c.viewport.replace('x', '×');
  if (typeof c.user_agent === 'string') {
    const b = shortUserAgent(c.user_agent);
    if (b) out.browser = b;
  }
  if (Array.isArray(c.errors)) out.errors = c.errors.length;
  if (Array.isArray(c.failed_requests)) out.requests = c.failed_requests.length;

  const t = c.target as Partial<WidgetTarget> | undefined;
  if (t && typeof t === 'object' && typeof t.selector === 'string' && t.selector) {
    out.target = {
      label: targetLabel({ kind: t.kind ?? '', text: t.text, label: t.label, heading: t.heading, rect: validRect(t.rect) }, 40),
      selector: t.selector,
      page: typeof t.url === 'string' ? pathOf(t.url) : undefined,
      url: typeof t.url === 'string' ? t.url : typeof c.url === 'string' ? c.url : undefined,
      rect: validRect(t.rect),
      hadShot: typeof t.shot === 'string' && t.shot.length > 0,
    };
    // 짚는 순간의 뷰포트가 있으면 그것이 기준이다(보낼 때 값은 주소창·회전으로 달라진다 — 코드 리뷰 M1)
    const vpRaw = typeof t.viewport === 'string' ? t.viewport : c.viewport;
    const vp = typeof vpRaw === 'string' ? /^(\d+)x(\d+)$/.exec(vpRaw) : null;
    if (vp) out.target.viewport = { w: Number(vp[1]), h: Number(vp[2]) };
  }

  const hasAny = out.page || out.viewport || out.browser || out.errors || out.requests || out.target;
  return hasAny ? out : null;
}

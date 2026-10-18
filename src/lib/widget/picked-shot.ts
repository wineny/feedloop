// 운영자 화면의 「화면에서 선택」 카드 재료 (I-55, 2026-09-25). 의존성 0 — 클라이언트 컴포넌트가 그대로 쓴다.
//
// 스크린샷은 방문자 «뷰포트 그대로»(좌표 = CSS px)이고 짚은 영역 rect 도 같은 뷰포트 기준이다.
// 그래서 이미지 픽셀 크기와 무관하게, 이미지를 «뷰포트 폭 × 배율» 로 그리면 rect 를 그대로 겹칠 수 있다.
// 이미지가 없으면(옛 제보·촬영 실패·보존 기한 경과) 같은 좌표로 미니맵을 그린다.

import { summarizeContext } from './context-summary';
import type { PickedShotView } from './pick';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PickedShotData {
  /** 「「쿠폰 받기」 버튼」·「「오늘의 널널 PICK」 구역 · 1120×973」 */
  label: string;
  selector: string;
  rect?: Rect;
  /** 짚은 시점의 뷰포트(CSS px). 없으면 이미지 크기로 대신한다 */
  viewport?: { w: number; h: number };
  /** 서명 URL(10분). 없으면 미니맵 폴백 */
  shot: PickedShotView | null;
  /** 촬영본이 붙었던 메시지인가 — 붙었는데 shot 이 없으면 보존 기간이 지났거나 서명에 실패했다 */
  hadShot: boolean;
  /** 짚은 시점 페이지 주소 — http(s) 만. 운영자가 새 탭으로 연다(지금 화면이라 방문자가 본 것과 다를 수 있다) */
  pageUrl?: string;
  /** 제보 시각(ISO) — 「보존 기간이 지나 삭제됐어요」 판정 */
  at?: string;
}

/** 보존 기간(lib/widget/shots.ts SHOT_RETENTION_DAYS 와 같다 — 테스트 대조) */
export const PICKED_SHOT_RETENTION_DAYS = 90;
/** 썸네일에서 테두리가 이보다 작아지면 최소 상자 + 핀으로 그린다(134×23 버튼이 점이 되지 않게) */
export const MIN_MARK_PX = 12;
/** 운영자 화면 각주 */
export const SHOT_FOOTNOTE = '방문자 브라우저에서 다시 그린 화면이라 이미지·지도·고정 헤더는 빠질 수 있어요';
/** 「제보된 페이지」 링크 문구·각주 */
export const PAGE_LINK_LABEL = '제보된 페이지';
export const PAGE_LINK_NOTE = '지금 상태의 페이지가 열려서 방문자가 본 화면과 다를 수 있어요';

/** http(s) 만 통과 — 서버가 이미 걸렀지만 href 에 싣기 전에 한 번 더(javascript: 등) */
export function safePageUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** 링크 글자 — 경로+쿼리만(`/spots/gyeongbokgung`). 첫 화면이면 「/」 하나라 어디인지 모르니 도메인으로. 전체 주소는 title 로 */
export function pagePathLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return path && path !== '/' ? path : u.host;
  } catch {
    return url;
  }
}

/** messages.context + 서명 결과 → 카드 재료. 짚은 요소가 없으면 null */
export function pickedFromContext(context: unknown, shot: PickedShotView | null | undefined, at?: string): PickedShotData | null {
  const s = summarizeContext(context);
  if (!s?.target) return null;
  return {
    label: s.target.label,
    selector: s.target.selector,
    rect: s.target.rect,
    viewport: s.target.viewport,
    shot: shot ?? null,
    hadShot: s.target.hadShot,
    pageUrl: safePageUrl(s.target.url),
    at,
  };
}

/** 이미지가 없을 때 무엇이라 말할지 */
export function missingShotReason(d: Pick<PickedShotData, 'shot' | 'hadShot' | 'at'>, now = Date.now()): string | null {
  if (d.shot) return null;
  if (!d.hadShot) return '이 제보엔 화면이 없어요 · 위치만 표시해요';
  const t = d.at ? Date.parse(d.at) : NaN;
  if (Number.isFinite(t) && now - t > PICKED_SHOT_RETENTION_DAYS * 86_400_000) return '보존 기간이 지나 화면이 삭제됐어요 · 위치만 표시해요';
  return '화면을 불러오지 못했어요 · 위치만 표시해요';
}

/** 좌표계 크기 — 뷰포트, 없으면 이미지 크기, 둘 다 없으면 rect 를 담는 최소 상자 */
type Geometry = Partial<Pick<PickedShotData, 'viewport' | 'shot' | 'rect'>>;

export function frameOf(d: Geometry): { w: number; h: number } {
  // 이미지가 있으면 세로는 이미지 비율로 — 가로 배율은 균일하므로 뷰포트 폭 × (이미지 세로/가로) 가 촬영 순간의
  // 세로다. 뷰포트 값이 «보낼 때» 것이어도 이미지가 늘어나지 않는다(코드 리뷰 M1)
  if (d.viewport && d.viewport.w > 0 && d.shot && d.shot.width > 0 && d.shot.height > 0) {
    return { w: d.viewport.w, h: (d.viewport.w * d.shot.height) / d.shot.width };
  }
  if (d.viewport && d.viewport.w > 0 && d.viewport.h > 0) return d.viewport;
  if (d.shot && d.shot.width > 0 && d.shot.height > 0) return { w: d.shot.width, h: d.shot.height };
  const r = d.rect;
  return { w: Math.max(1280, r ? r.x + r.w : 0), h: Math.max(800, r ? r.y + r.h : 0) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** rect 중 뷰포트 안에 보이던 부분. 전혀 안 보였으면 null */
export function visibleRect(r: Rect | undefined, f: { w: number; h: number }): Rect | null {
  if (!r) return null;
  const x1 = clamp(r.x, 0, f.w), y1 = clamp(r.y, 0, f.h);
  const x2 = clamp(r.x + r.w, 0, f.w), y2 = clamp(r.y + r.h, 0, f.h);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface ThumbLayout {
  /** 이미지(또는 미니맵 판)의 위치·크기 — 썸네일 상자 기준 px */
  img: { left: number; top: number; width: number; height: number };
  /** 짚은 영역 테두리 — 썸네일 상자 기준 px. 영역이 화면 밖이었으면 null */
  mark: { left: number; top: number; width: number; height: number; small: boolean } | null;
}

/**
 * 썸네일 box(w×h) 안에서 짚은 영역을 가운데 두는 배치. 배율은 «빈 칸 없이 상자를 덮는 최소»부터 시작해
 * 영역이 상자의 70% 안에 들 만큼 키우되 3배를 넘지 않는다. 이미지 밖이 보이지 않게 위치를 가둔다.
 * contain=true(미니맵·라이트박스)면 판 전체를 상자 안에 넣는다.
 */
export function thumbLayout(
  d: Geometry,
  box: { w: number; h: number },
  opts: { contain?: boolean } = {},
): ThumbLayout {
  const f = frameOf(d);
  const vr = visibleRect(d.rect, f);
  let z: number;
  if (opts.contain || !vr) {
    z = opts.contain ? Math.min(box.w / f.w, box.h / f.h) : Math.max(box.w / f.w, box.h / f.h);
  } else {
    const cover = Math.max(box.w / f.w, box.h / f.h);
    const fit = Math.min((box.w * 0.7) / vr.w, (box.h * 0.7) / vr.h);
    z = clamp(fit, cover, Math.max(cover, cover * 3));
  }
  const width = f.w * z, height = f.h * z;
  let left: number, top: number;
  if (opts.contain) {
    left = (box.w - width) / 2;
    top = (box.h - height) / 2;
  } else {
    const cx = vr ? vr.x + vr.w / 2 : f.w / 2, cy = vr ? vr.y + vr.h / 2 : f.h / 2;
    left = clamp(box.w / 2 - cx * z, box.w - width, 0);
    top = clamp(box.h / 2 - cy * z, box.h - height, 0);
  }
  let mark: ThumbLayout['mark'] = null;
  if (vr) {
    const mw = vr.w * z, mh = vr.h * z;
    const small = mw < MIN_MARK_PX || mh < MIN_MARK_PX;
    const w = Math.max(mw, MIN_MARK_PX), h = Math.max(mh, MIN_MARK_PX);
    mark = {
      left: left + (vr.x + vr.w / 2) * z - w / 2,
      top: top + (vr.y + vr.h / 2) * z - h / 2,
      width: w,
      height: h,
      small,
    };
  }
  return { img: { left, top, width, height }, mark };
}

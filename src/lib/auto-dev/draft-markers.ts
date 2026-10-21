/**
 * PR 본문·댓글에서 상태를 찾는 마커. 문구가 번역돼도 판정이 깨지지 않도록 HTML 주석을 쓴다.
 * 이미 열린 PR 에는 예전 한국어 문구만 있으므로 찾을 때는 둘 다 인식한다.
 */
export const DRAFT_WAIT_MARKER = '<!-- feedloop:draft-wait -->';
export const DRAFT_PROMOTED_MARKER = '<!-- feedloop:draft-gate:promoted -->';

const LEGACY_DRAFT_WAIT = '## 자동 검사 대기';
const LEGACY_PROMOTED = '검토 요청으로 바꿨습니다';

/** PR 본문이 「자동 검사 대기」 초안인지. */
export function hasDraftWaitMarker(body: string | null | undefined): boolean {
  return Boolean(body && (body.includes(DRAFT_WAIT_MARKER) || body.includes(LEGACY_DRAFT_WAIT)));
}

/** 댓글이 「검토 요청으로 전환 완료」 기록인지. */
export function hasPromotedMarker(body: string | null | undefined): boolean {
  return Boolean(body && (body.includes(DRAFT_PROMOTED_MARKER) || body.includes(LEGACY_PROMOTED)));
}

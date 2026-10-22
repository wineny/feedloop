/**
 * PR 본문·댓글에서 상태를 찾는 마커. 문구가 번역돼도 판정이 깨지지 않도록 HTML 주석을 쓴다.
 * 이미 열린 PR 에는 예전 한국어 문구만 있으므로 찾을 때는 둘 다 인식한다.
 */
export const DRAFT_WAIT_MARKER = '<!-- feedloop:draft-wait -->';
export const DRAFT_PROMOTED_MARKER = '<!-- feedloop:draft-gate:promoted -->';

// 줄 단위로만 맞춘다. 사람이 쓴 댓글·본문 중간에 같은 구절이 있어도 마커로 읽지 않는다.
const LEGACY_DRAFT_WAIT = /^## 자동 검사 대기\s*$/m;
// 예전 전환 댓글 문장 3종(자동 통과 / 10분 유예 / 권한 없음). 문장 끝에서만 맞춘다.
const LEGACY_PROMOTED =
  /(?:자동 검사를 통과해|생성 후 10분 동안 확인할 수 있는 검사가 없어|검사 결과를 읽을 권한이 없어 담당자 판단으로 반영하기 위해) 검토 요청으로 바꿨습니다\.?\s*$/m;

/** PR 본문이 「자동 검사 대기」 초안인지. */
export function hasDraftWaitMarker(body: string | null | undefined): boolean {
  return Boolean(body && (body.includes(DRAFT_WAIT_MARKER) || LEGACY_DRAFT_WAIT.test(body)));
}

/** 댓글이 「검토 요청으로 전환 완료」 기록인지. */
export function hasPromotedMarker(body: string | null | undefined): boolean {
  return Boolean(body && (body.includes(DRAFT_PROMOTED_MARKER) || LEGACY_PROMOTED.test(body)));
}

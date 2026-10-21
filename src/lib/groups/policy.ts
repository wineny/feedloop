// 묶음 카테고리별로 "그 다음에 뭘 할 수 있는가" 를 정하는 한 곳 (Gleap 차용 P1-3).
//
// 왜 나눴나 — 지금까지는 분류는 했는데 **그 다음이 같았다.** 묶이기만 하면
// 전부 PR 경로로 갔다. "다크모드 만들어주세요" 에 AI 가 PR 을 열면 십중팔구 쓸모없다.
// 리허설에서 후속 문의 묶음에 PR 을 만들어 useCallback·주석뿐인 PR #4 가 나온 게 같은 계열의 사고다.
//
// Gleap 은 이걸 제품 수준에서 갈라놨다 — 버그는 Kai Code(코드 수정), 기능 요청은 Kai PM(스펙 작성).
// 우리도 같은 갈래를 쓰되, 판단 기준을 여기 하나에 두고 크론·화면·API 가 전부 이걸 본다.
// (기준이 흩어지면 화면은 막는데 크론은 도는 상태가 된다.)

/** grouping.ts 가 묶음에 붙이는 카테고리 값. */
export type GroupCategory = 'bug' | 'ux' | 'feature_request' | 'praise' | 'cs' | 'other';

/**
 * 코드 수정 PR 을 시도해 볼 만한 카테고리.
 *
 * `ux` 를 넣은 건 "버튼이 안 보여요" 류가 실제로 코드 몇 줄로 고쳐지기 때문이다.
 * `feature_request` 는 뺐다 — 새 기능은 설계 판단이 먼저라 PR 이 먼저 나오면 안 된다.
 * `praise`·`cs`·`other` 는 애초에 고칠 것이 없다.
 */
const CODE_FIXABLE = new Set<string>(['bug', 'ux']);

/** 스펙 초안을 만들어 사람이 판단하게 할 카테고리. */
const SPEC_WORTHY = new Set<string>(['feature_request']);

/** 이 묶음에 자동 코드 수정 PR 을 시도해도 되는가. */
export function isCodeFixable(category: string): boolean {
  return CODE_FIXABLE.has(category);
}

/** 이 묶음은 PR 대신 스펙 초안이 어울리는가. */
export function isSpecWorthy(category: string): boolean {
  return SPEC_WORTHY.has(category);
}

/**
 * 화면이 이 묶음에 무엇을 띄울지.
 * - `pr`   : 「PR 만들기」
 * - `spec` : 「스펙 초안」 (기능 요청)
 * - `none` : 아무것도 — 칭찬·문의처럼 고칠 게 없는 것
 */
export function groupAction(category: string): 'pr' | 'spec' | 'none' {
  if (isCodeFixable(category)) return 'pr';
  if (isSpecWorthy(category)) return 'spec';
  return 'none';
}

/** 자동 PR 을 막을 때 API 가 쓰는 문구의 사전 키(`messages/<locale>/errors.json` 의 `api.<키>`). 이 모듈은 클라이언트도 import 해서 문구는 들고 있지 않다. */
export function codeFixBlockedReasonKey(category: string): 'specCategory' | 'noCodeToFix' {
  return isSpecWorthy(category) ? 'specCategory' : 'noCodeToFix';
}

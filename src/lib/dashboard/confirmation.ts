// 되돌림 확인(F5) — 「고쳤다」는 우리 주장이고, 「잘 돼요」는 그 사람의 말이다.
//
// 머지 ≠ 배포 ≠ 해결이라, 되돌림을 몇 건 보냈는지만으로는 루프가 닫혔는지 알 수 없다.
// 방문자가 되돌림 카드에서 누른 답(`responses.user_confirmation` = 'fixed' | 'not_fixed' | NULL)이
// 유일한 증거다(카드 UI 는 I-30, 값을 쓰는 곳은 `confirm_widget_resolution` RPC).
//
// ── 두 비율의 분모가 다르다. 섞으면 안 된다 ──
//   「잘 돼요」 비율 = fixed / (fixed + not_fixed)   ← 답한 사람 중 고쳐졌다고 한 비율
//   응답률          = (fixed + not_fixed) / 전달된 되돌림 수  ← 물어본 사람 중 답한 비율
// 답이 하나도 없으면(fixed + not_fixed = 0) 「잘 돼요」 비율은 0% 가 아니라 **없음**이다.

// ── 왜 «웹 위젯만» 인가 ──
// 답을 받는 길은 위젯 카드 하나뿐이다. 그 답을 쓰는 RPC(`confirm_widget_resolution`)가
// `c.source='web'` 인 대화만 받기 때문에(20260913_22 이후 모든 판) 채널톡·카카오로 나간
// 되돌림은 분자에 «영원히» 들어갈 수 없다. 그걸 분모에 넣으면 응답률이 구조적으로 낮게 나온다.
// 그래서 분자도 분모도 web 대화로 좁히고, 카드에도 「웹 위젯 기준」이라고 적는다.
// 다른 입구에도 확인 UI 가 생기면 이 필터를 라우트에서 빼면 셋이 함께 움직인다.

export type ConfirmationState = 'ok' | 'empty' | 'error';

export interface ConfirmationStats {
  /** `empty`(아직 답이 없다)와 `error`(집계를 못 읽었다)는 다른 사실이다 */
  state: ConfirmationState;
  fixed: number;
  notFixed: number;
  /** 전달된 되돌림 수(웹 위젯 대화만) = 응답률의 분모 */
  delivered: number;
}

export const EMPTY_CONFIRMATION: ConfirmationStats = { state: 'empty', fixed: 0, notFixed: 0, delivered: 0 };

/** 집계를 못 읽었을 때. 「아직 답이 없다」와 구분해서 그린다. */
export const FAILED_CONFIRMATION: ConfirmationStats = { state: 'error', fixed: 0, notFixed: 0, delivered: 0 };

export interface ConfirmationRates {
  /** 답한 건수 = fixed + not_fixed */
  answered: number;
  /** 답한 사람 중 「네, 잘 돼요」 비율. 답이 0 이면 null */
  fixedRate: number | null;
  /** 되돌림을 받은 사람 중 답한 비율. 보낸 것이 0 이면 null */
  responseRate: number | null;
}

export function confirmationRates(stats?: ConfirmationStats): ConfirmationRates {
  const fixed = stats?.fixed ?? 0;
  const notFixed = stats?.notFixed ?? 0;
  const delivered = stats?.delivered ?? 0;
  const answered = fixed + notFixed;

  return {
    answered,
    fixedRate: answered > 0 ? fixed / answered : null,
    // 답이 보낸 것보다 많을 수는 없지만, 스코프가 바뀌는 사이의 어긋난 숫자를 100% 넘겨 그리지 않는다.
    responseRate: delivered > 0 ? Math.min(answered / delivered, 1) : null,
  };
}

/** 0.666… → 「67%」. 소수점은 쓰지 않는다 — 표본이 한 자릿수라 정밀도를 주장하면 거짓말이 된다. */
export function formatRate(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

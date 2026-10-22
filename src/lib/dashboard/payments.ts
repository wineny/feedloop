// 대시보드 PayPal 줄 — 무엇을 그릴지 고르는 순수 함수. 화면(`components/dashboard/PaymentStats`)과 테스트가 같이 쓴다.
//
// 재료는 `/api/dashboard` 의 `payments` 블록(`DashboardPayments`, 정의·규칙은 그 파일 주석).
//   - connected        → 숫자 카드 3장(결제 문의·자동 환불·승인 대기)
//   - connectBotId 있음 → 「PayPal 연결하기」 카드 1장. 숫자가 없으면 그 자리를, 있으면 숫자 아래 작은 카드로
//   - 둘 다 아님        → 아무것도 안 그린다(아래 `paymentsLayout` 주석)

import type { DashboardPayments } from '@/app/api/dashboard/route';
import { formatMoney } from '@/lib/paypal/money';

export type PaymentsLayout =
  | { kind: 'none' }
  | { kind: 'connect'; connectHref: string }
  | { kind: 'numbers'; connectHref: string | null };

/** 승인 카드가 있는 곳. 받은편지함에 「승인 대기만」 거르는 필터가 아직 없어 받은편지함 자체로 보낸다. */
export const APPROVALS_HREF = '/inbox';

/** 봇 설정의 PayPal 탭(소유자 전용). */
export function paypalSettingsHref(botId: string): string {
  return `/bots/${encodeURIComponent(botId)}/paypal`;
}

/**
 * `checklistVisible`: 시작 체크리스트가 서 있으면 그 마지막 단계(「PayPal 연결 (선택)」)가 같은 일을 권한다.
 * 같은 행동을 두 번 권하지 않게 따로 서는 「PayPal 연결하기」 카드는 내린다(숫자 아래 작은 안내는 그대로).
 */
export function paymentsLayout(
  payments: DashboardPayments | null | undefined,
  { checklistVisible = false }: { checklistVisible?: boolean } = {},
): PaymentsLayout {
  if (!payments) return { kind: 'none' };
  const connectHref = payments.connectBotId ? paypalSettingsHref(payments.connectBotId) : null;
  if (payments.connected) return { kind: 'numbers', connectHref };
  if (connectHref) return checklistVisible ? { kind: 'none' } : { kind: 'connect', connectHref };
  // 연결도 안 됐고 연결할 봇도 없다 = 승인자로만 들어간 봇(남의 봇)을 보고 있다. PayPal 탭은 소유자 전용이라
  // 승인자는 여기서 할 수 있는 일이 없다 — 빈 카드나 0 을 세우면 「뭔가 해야 한다」로 읽히니 줄 자체를 그리지 않는다.
  return { kind: 'none' };
}

/**
 * 자동 환불 금액 — 영수증 화면과 같은 규칙(`$9 USD`). 통화가 섞여 금액·통화가 null 이면 null(건수만 보인다).
 * 0건이라도 통화를 알면 `$0 USD` 를 그린다.
 */
export function autoRefundAmount(autoRefunds: DashboardPayments['autoRefunds7d']): string | null {
  if (!autoRefunds || autoRefunds.amountCents === null || !autoRefunds.currency) return null;
  return `${formatMoney(autoRefunds.amountCents, autoRefunds.currency)} ${autoRefunds.currency}`;
}

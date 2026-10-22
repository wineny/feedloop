// What the receipt page shows for an order status. Pure (no React, no DB) so the mapping is testable;
// the page in `src/app/[locale]/pricing/receipt/[orderId]/page.tsx` renders it.

import { isCapturedOrLater, type OrderStatus } from '@/lib/paypal/store';
import type { Receipt } from './shop';

/** ok = paid · wait = still settling · refund = money (partly) went back · bad = not paid. */
export type ReceiptTone = 'ok' | 'wait' | 'refund' | 'bad';

/** Every order status, its look. The copy key is the status itself (`pricing.receipt.<status>`). */
export const RECEIPT_TONE: Record<OrderStatus, ReceiptTone> = {
  captured: 'ok',
  approved: 'wait',
  created: 'wait',
  expired: 'bad',
  failed: 'bad',
  partially_refunded: 'refund',
  refunded: 'refund',
  // A reversal (chargeback / PayPal taking the money back) is not a refund the store chose, and the
  // plan is no longer paid — same "not paid" look as expired/failed.
  reversed: 'bad',
};

/** Still settling: the page refreshes itself until the webhook / return route finishes. Refund states are settled. */
export function isSettling(status: OrderStatus): boolean {
  return status === 'created' || status === 'approved';
}

/** The "Questions about this payment?" box: for anything that took money, refunded or not. */
export function showsQuestions(status: OrderStatus): boolean {
  return isCapturedOrLater(status);
}

export interface RefundFacts {
  /** Which row label the amount takes. */
  kind: 'refunded' | 'reversed';
  /** PayPal's refunded/reversed total, or null when we could not read it (0) — never shown as "$0". */
  refundedCents: number | null;
  /** What is still paid after a partial refund; null for full refunds/reversals or an unknown total. */
  remainingCents: number | null;
  /** When Feedloop saw the change (refunded_at) — not PayPal's own refund time. */
  recordedAt: string | null;
}

/** The refund rows for a refund state, or null for every other status. */
export function refundFacts(order: Pick<Receipt, 'status' | 'amount_cents' | 'refunded_cents' | 'refunded_at'>): RefundFacts | null {
  if (order.status !== 'refunded' && order.status !== 'partially_refunded' && order.status !== 'reversed') return null;
  const refunded = order.refunded_cents > 0 ? order.refunded_cents : null;
  const remaining =
    order.status === 'partially_refunded' && refunded !== null && refunded < order.amount_cents ? order.amount_cents - refunded : null;
  return {
    kind: order.status === 'reversed' ? 'reversed' : 'refunded',
    refundedCents: refunded,
    remainingCents: remaining,
    recordedAt: order.refunded_at,
  };
}

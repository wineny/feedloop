// Deterministic payment router for the web widget (design v2 §2).
//
// Decides, WITHOUT an LLM call, whether a visitor message goes to the payment agent or stays on the
// ordinary reply path. Any one of four signals is enough:
//   1. an open payment action on this conversation (refund waiting for approval / executing)
//   2. the previous reply in this conversation came from the payment agent
//   3. something that looks like a PayPal order / capture id
//   4. a payment keyword (English or Korean)
// No LLM classifier: that would add 1-3 s to every message and its insight could not be reused
// (the taxonomy has no payment category). Pure and dependency-free so the table test covers it
// and the widget route pays nothing for a non-payment message.

import { isPaymentResponseType } from './response-types';

export type PaymentRouteReason = 'open_action' | 'previous_turn' | 'order_id' | 'keyword';

export type PaymentRoute = { route: true; reason: PaymentRouteReason } | { route: false };

export const NO_PAYMENT_ROUTE: PaymentRoute = { route: false };

/** The subset of a timeline item the router reads. `responseType` is only set on our replies. */
export interface RouterTurn {
  id?: string;
  kind: string;
  responseType?: string | null;
}

export interface PaymentRouteInput {
  /** The visitor's message, as saved. */
  text: string;
  /** Recent timeline, oldest first. May include the current message when it is already saved. */
  recentTurns: readonly RouterTurn[];
  /** Id of the current message so it is not mistaken for context. */
  currentMessageId?: string | null;
  /** This conversation has a payment action in pending/executing state. */
  hasOpenAction: boolean;
}

/**
 * English money words, word-bounded so "pay" does not fire on "payload" and "bill" not on
 * "billion". "order" is excluded when it is the phrase "in order to".
 */
const EN_KEYWORDS =
  /\b(?:refund(?:s|ed|ing)?|money ?back|charge[ds]?|charging|overcharged|payments?|paid|pay(?:ing)?|purchases?d?|purchasing|bought|buy(?:ing)?|receipts?|invoices?|bill(?:ed|ing)?|paypal|transactions?|checkout|subscriptions?|(?<!in )orders?)\b/i;

/** Korean money words. Substring match: Korean has no word boundaries the regex engine knows. */
const KO_KEYWORDS = ['환불', '결제', '구매', '주문', '영수증', '청구', '페이팔', '환급'];

/**
 * PayPal order and capture ids are 17 upper-case alphanumerics (e.g. 5O190127TN364715T,
 * 3C679366HH908993F). A 17-character token mixing letters and digits almost never appears in
 * ordinary chat, so it is a strong signal on its own. Case-insensitive: visitors retype ids.
 */
const ORDER_ID = /(?<![A-Z0-9])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{17}(?![A-Z0-9])/i;

export function hasPaymentKeyword(text: string): boolean {
  if (EN_KEYWORDS.test(text)) return true;
  return KO_KEYWORDS.some((k) => text.includes(k));
}

export function looksLikePayPalId(text: string): boolean {
  return ORDER_ID.test(text);
}

/**
 * The last reply before the current message, whoever sent it. Only that one counts: if an
 * operator (or a system notice) spoke after the payment agent, the thread has moved on.
 */
export function previousReplyWasPayment(
  turns: readonly RouterTurn[],
  currentMessageId?: string | null,
): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (currentMessageId && t.id === currentMessageId) continue;
    if (t.kind === 'user') continue;
    return isPaymentResponseType(t.responseType);
  }
  return false;
}

export function routePayment(input: PaymentRouteInput): PaymentRoute {
  if (input.hasOpenAction) return { route: true, reason: 'open_action' };
  if (previousReplyWasPayment(input.recentTurns, input.currentMessageId)) {
    return { route: true, reason: 'previous_turn' };
  }
  const text = input.text.trim();
  if (text === '') return NO_PAYMENT_ROUTE;
  if (looksLikePayPalId(text)) return { route: true, reason: 'order_id' };
  if (hasPaymentKeyword(text)) return { route: true, reason: 'keyword' };
  return NO_PAYMENT_ROUTE;
}

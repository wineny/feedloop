// What the inbox shows for a payment_actions row (design v2 §4 "approval card"), as plain JSON the
// operator route sends and the client renders. English: the card is on the judges' screen (§10).
// No Node imports — the client page imports this too.

import { formatMoney } from './money';
import type { PaymentActionRow, PaymentActionStatus } from './store';

export interface PaymentActionView {
  id: string;
  kind: 'refund' | 'accept_dispute';
  status: PaymentActionStatus;
  origin: 'auto' | 'approval';
  amountCents: number | null;
  currency: string | null;
  /** "$29.50" or null when the row has no amount. */
  amount: string | null;
  reason: string | null;
  captureId: string;
  /** Every guardrail check, in a stable order, with its result. Empty for rows without a record. */
  checks: { key: string; label: string; passed: boolean }[];
  paypalRef: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** The operator can still approve or reject this row. */
  decidable: boolean;
}

/** Operator-facing names for the guardrail checks the RPC records (20261019_01, 20261021_01). */
export const CHECK_LABELS: Record<string, string> = {
  amount_within_max: 'Amount within auto limit',
  within_days: 'Paid recently enough',
  no_prior_refund: 'No earlier refund on this payment',
  currency_matches: 'Currency matches the store',
  daily_cap_ok: 'Daily refund cap not exceeded',
  customer_known: 'Customer identified',
  customer_cap_ok: 'Customer refund cap not exceeded',
  no_dispute: 'No open dispute',
  not_propose_only: 'Store allows automatic refunds',
  not_paused: 'Automatic refunds not paused',
};

const CHECK_ORDER = Object.keys(CHECK_LABELS);

export const STATUS_LABELS: Record<PaymentActionStatus, string> = {
  pending: 'Waiting for approval',
  executing: 'Sending to PayPal',
  unknown: 'Processing (awaiting PayPal confirmation)',
  executed: 'Refunded',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
};

export function toPaymentActionView(row: PaymentActionRow): PaymentActionView {
  const guardrail = row.guardrail ?? {};
  const keys = [...CHECK_ORDER.filter((k) => k in guardrail), ...Object.keys(guardrail).filter((k) => !CHECK_ORDER.includes(k))];
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    amountCents: row.amount_cents,
    currency: row.currency,
    amount: row.amount_cents !== null && row.currency ? formatMoney(row.amount_cents, row.currency) : null,
    reason: row.reason,
    captureId: row.target_id,
    checks: keys.map((key) => ({ key, label: CHECK_LABELS[key] ?? key, passed: guardrail[key] === true })),
    paypalRef: row.paypal_ref,
    error: row.error,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidable: row.status === 'pending',
  };
}

/** The checks that did not pass — why this refund waits for a person. */
export function failedChecks(view: Pick<PaymentActionView, 'checks'>): string[] {
  return view.checks.filter((c) => !c.passed).map((c) => c.label);
}

/** What the inbox does with the decision route's answer. Pure, so the handler is testable without React. */
export interface DecisionResponseEffect {
  /** The row as the server now has it; replaces the card whatever the HTTP status. */
  action: PaymentActionView | null;
  /** The conversation's "needs a person" badge came down. */
  escalationCleared: boolean;
  /** Shown on the card (the decision did not go through). */
  cardError: string | null;
  /** Shown at the conversation level (the decision is saved; something else needs attention). */
  notice: string | null;
}

export function interpretDecisionResponse(status: number, body: unknown): DecisionResponseEffect {
  const b = (body && typeof body === 'object' ? body : {}) as { action?: PaymentActionView; escalationCleared?: unknown; error?: unknown };
  const action = b.action && typeof b.action === 'object' ? b.action : null;
  const escalationCleared = b.escalationCleared === true;
  const serverError = typeof b.error === 'string' && b.error ? b.error : null;
  if (status === 409 && action) {
    return { action, escalationCleared, cardError: 'This request was already decided by someone else. The card shows the current state.', notice: null };
  }
  if (!action) {
    return { action: null, escalationCleared, cardError: serverError ?? `The decision failed (${status}).`, notice: null };
  }
  if (status < 200 || status >= 300) {
    // e.g. 502: the approval is saved (the row says "Sending to PayPal") but nothing went out yet.
    return { action, escalationCleared, cardError: null, notice: serverError ?? `The decision was saved but could not be completed (${status}).` };
  }
  return { action, escalationCleared, cardError: null, notice: null };
}

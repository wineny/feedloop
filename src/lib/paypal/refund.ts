// requestRefund — a verified visitor asks for money back (design v2 §4).
//
// Order of operations, and why:
//  1. Read the capture from PayPal. Amount, currency, date and "already refunded" come from THAT
//     read, never from the model or the visitor. A capture that is not COMPLETED is refused here.
//  2. Read disputes for the capture. If the read fails we pass null, which the RPC treats as
//     "has a dispute": unknown facts never widen what runs automatically.
//  3. Cancellation gate, then ONE RPC (`payment_action_open_refund`) that decides and writes the row
//     in the same statement. Limits are read inside it at that moment. created=false means a live
//     action already exists for this capture: nothing is sent to PayPal.
//  4. auto=true: the row is already `executing` (write-ahead). Second cancellation gate — a request
//     that was cancelled while we were deciding must not start moving money; the row is settled
//     `failed` (nothing was sent, so that is certain). Then PayPal is called with
//     PayPal-Request-Id = action.id and an explicit amount.
//  5. Classifying what came back is the part that matters most. An HTTP success carries a refund
//     resource whose `status` is the real answer (COMPLETED | PENDING | FAILED | CANCELLED,
//     https://developer.paypal.com/api/payments/v2/definitions/refund/):
//       COMPLETED          → settle `executed`. If THAT write fails, the row stays `executing`:
//                            money moved, the reservation stays, the id is the retry key.
//       PENDING            → settle `unknown` WITH the refund id: PayPal accepted it but has not
//                            finished; reconciliation GETs the refund later. Visitor hears "processing".
//       FAILED / CANCELLED → settle `failed` (definite: no money moved, slot freed).
//       other / malformed  → settle `unknown` (we cannot read the answer).
//       4xx from PayPal    → settle `failed` (definite answer, slot freed).
//       anything else      → settle `unknown` (timeout, abort mid-flight, network, 5xx): we do not
//                            know whether PayPal refunded. The row stays live; a later retry with
//                            the same id is answered from PayPal's idempotency cache; task 3's
//                            reaper reconciles rows left in unknown/executing.
//     Never `failed` for a lost or unfinished answer: `failed` frees the slot and the next request
//     would open a NEW id and could refund twice.
//
// Task 3 still revises the decision inside the RPC (UTC day, NULL customer key, amount ≤ capture
// total) and adds the reaper + approval RPC.

import { isUncertainPayPalError, type PayPalClient } from './client';
import { describeError } from './checkout';
import { centsToValue, valueToCents } from './money';
import type { PaymentActionRow, PaymentsStore } from './store';

export interface RefundDeps {
  store: PaymentsStore;
  paypal: PayPalClient;
}

export interface RefundRequest {
  botId: string;
  conversationId: string;
  captureId: string;
  /** Omitted = the whole capture. Always resolved to an explicit number before PayPal sees it. */
  amountCents?: number | null;
  reason: string;
  /** The verified payer email, lower-cased. null is allowed but the RPC may then refuse auto (task 3). */
  customerKey: string | null;
  /** The caller's cancellation (the tool's abortSignal). Checked before every write. */
  signal?: AbortSignal;
}

export type RefundRefusal = 'capture_not_completed' | 'bad_amount' | 'amount_too_high' | 'paypal_unreadable' | 'canceled';

export type RefundOutcome =
  | { status: 'executed'; action: PaymentActionRow; refundId: string; amountCents: number; currency: string }
  | { status: 'pending'; action: PaymentActionRow; amountCents: number; currency: string; checks: Record<string, boolean> }
  /** A live action (pending / executing / unknown / executed) already exists for this capture. */
  | { status: 'already_open'; action: PaymentActionRow }
  /** Refused before any row was written. */
  | { status: 'refused'; reason: RefundRefusal }
  /** The row exists and is now `failed`: PayPal said no (4xx), or we were cancelled before sending. */
  | { status: 'failed'; action: PaymentActionRow; reason: 'paypal_failed' | 'canceled' }
  /**
   * PayPal was asked and the outcome is not final: the answer was lost, or PayPal said PENDING
   * (`refundId` set). The row is `unknown` and keeps its reservation.
   */
  | { status: 'unknown'; action: PaymentActionRow; refundId?: string };

const REFUNDED_STATUSES = new Set(['REFUNDED', 'PARTIALLY_REFUNDED']);
const REFUNDABLE_STATUSES = new Set(['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED']);
const MAX_REASON_CHARS = 300;
const MAX_ERROR_CHARS = 200;

export async function requestRefund(deps: RefundDeps, input: RefundRequest): Promise<RefundOutcome> {
  const { signal } = input;

  // 1. facts from PayPal
  let capture;
  try {
    capture = await deps.paypal.getCapture(input.captureId, { signal });
  } catch (err) {
    console.error('[paypal] getCapture failed', { captureId: input.captureId, ...describeError(err) });
    return { status: 'refused', reason: signal?.aborted ? 'canceled' : 'paypal_unreadable' };
  }
  if (!REFUNDABLE_STATUSES.has(capture.status)) return { status: 'refused', reason: 'capture_not_completed' };

  const captureCents = valueToCents(capture.amount?.value);
  const currency = capture.amount?.currency_code?.toUpperCase();
  if (captureCents === null || captureCents <= 0 || !currency) return { status: 'refused', reason: 'paypal_unreadable' };

  const amountCents = input.amountCents ?? captureCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { status: 'refused', reason: 'bad_amount' };
  if (amountCents > captureCents) return { status: 'refused', reason: 'amount_too_high' };

  // 2. disputes (unknown → null → the RPC waits for approval)
  let hasDispute: boolean | null;
  try {
    hasDispute = (await deps.paypal.listDisputesForCapture(input.captureId, { signal })).length > 0;
  } catch (err) {
    if (signal?.aborted) return { status: 'refused', reason: 'canceled' };
    console.error('[paypal] listDisputes failed', { captureId: input.captureId, ...describeError(err) });
    hasDispute = null;
  }

  // 3. cancellation gate, then decide + write-ahead row
  if (signal?.aborted) return { status: 'refused', reason: 'canceled' };
  const decision = await deps.store.openRefund({
    botId: input.botId,
    conversationId: input.conversationId,
    captureId: input.captureId,
    amountCents,
    currency,
    capturedAt: capture.create_time ?? null,
    captureHasRefund: REFUNDED_STATUSES.has(capture.status),
    hasDispute,
    customerKey: input.customerKey ? input.customerKey.trim().toLowerCase() : null,
    reason: input.reason.trim().slice(0, MAX_REASON_CHARS),
  });

  if (!decision.created) return { status: 'already_open', action: decision.action };
  if (!decision.auto) {
    return { status: 'pending', action: decision.action, amountCents, currency, checks: decision.checks ?? {} };
  }

  // 4. second gate: nothing has been sent yet, so a cancelled request can still be closed as certain.
  const action = decision.action;
  const payload = { amount: { value: centsToValue(amountCents), currency_code: currency } };
  if (signal?.aborted) {
    await settle(deps.store, action.id, { status: 'failed', error: 'canceled_before_send', payload });
    return { status: 'failed', action, reason: 'canceled' };
  }

  // 5. execute. The amount is always explicit; the request id is the row id.
  let refund;
  try {
    refund = await deps.paypal.refundCapture(input.captureId, {
      amountValue: payload.amount.value,
      currencyCode: currency,
      requestId: action.id,
      signal,
    });
  } catch (err) {
    const info = describeError(err);
    const error = String(info.name ?? info.message ?? 'paypal_failed').slice(0, MAX_ERROR_CHARS);
    if (isUncertainPayPalError(err)) {
      console.error('[paypal] refundCapture: answer lost, row kept as unknown', { actionId: action.id, ...info });
      await settle(deps.store, action.id, { status: 'unknown', error, payload, result: info });
      return { status: 'unknown', action };
    }
    console.error('[paypal] refundCapture refused by PayPal', { actionId: action.id, ...info });
    await settle(deps.store, action.id, { status: 'failed', error, payload, result: info });
    return { status: 'failed', action, reason: 'paypal_failed' };
  }

  // HTTP success. Now read the resource: only COMPLETED is money moved.
  const refundId = typeof refund?.id === 'string' && refund.id ? refund.id : null;
  const status = typeof refund?.status === 'string' ? refund.status : null;
  const result = { id: refundId, status, amount: refund?.amount ?? null };

  if (status === 'COMPLETED' && refundId) {
    // A failed settle write must not change that story: the row stays `executing` (still live,
    // same id) until reconciliation.
    const settled = await settle(deps.store, action.id, { status: 'executed', paypalRef: refundId, payload, result });
    if (!settled) {
      console.error('[paypal] refund executed but the row could not be settled; left for reconciliation', {
        actionId: action.id,
        refundId,
      });
    }
    return { status: 'executed', action, refundId, amountCents, currency };
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    console.error('[paypal] refund resource not completed', { actionId: action.id, refundId, status });
    await settle(deps.store, action.id, { status: 'failed', error: `REFUND_${status}`, paypalRef: refundId, payload, result });
    return { status: 'failed', action, reason: 'paypal_failed' };
  }

  // PENDING (accepted, not finished) or something we cannot read: keep the reservation and the
  // refund id so reconciliation can GET /v2/payments/refunds/{id}.
  if (status !== 'PENDING') {
    console.error('[paypal] refund response unrecognised; row kept as unknown', { actionId: action.id, refundId, status });
  }
  await settle(deps.store, action.id, {
    status: 'unknown',
    error: status === 'PENDING' ? null : 'REFUND_RESPONSE_UNRECOGNIZED',
    paypalRef: refundId,
    payload,
    result,
  });
  return refundId ? { status: 'unknown', action, refundId } : { status: 'unknown', action };
}

/** settleAction that never throws: a DB hiccup here must not be mistaken for a PayPal answer. */
async function settle(
  store: PaymentsStore,
  actionId: string,
  outcome: Parameters<PaymentsStore['settleAction']>[1],
): Promise<boolean> {
  try {
    const ok = await store.settleAction(actionId, outcome);
    if (!ok) console.error('[paypal] settleAction: row was not executing', { actionId, status: outcome.status });
    return ok;
  } catch (err) {
    console.error('[paypal] settleAction threw', { actionId, status: outcome.status, message: (err as Error).message });
    return false;
  }
}

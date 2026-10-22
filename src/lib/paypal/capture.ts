// Capturing an approved order, from either door: the buyer's return URL or the
// CHECKOUT.ORDER.APPROVED / PAYMENT.CAPTURE.COMPLETED webhooks.
//
// Exactly-once without a lock:
//  - PayPal side: capture is sent with PayPal-Request-Id = order id, so a second capture call
//    for the same order is answered from PayPal's idempotency cache (or ORDER_ALREADY_CAPTURED,
//    which we treat as "read the order and continue").
//  - Our side: the row moves to `captured` with a conditional update (only from a
//    not-yet-captured status). Whoever wins that update also writes the conversation line;
//    the loser re-reads the row and returns it.
// Unknown order ids are refused: we never capture an order we did not create.

import { PayPalApiError, type PayPalCapture, type PayPalClient, type PayPalOrder } from './client';
import { describeError } from './checkout';
import { centsToValue, formatMoney, valueToCents } from './money';
import { isCapturedOrLater, type OrderRow, type OrderStatus, type PaymentsStore, type RefundOrderStatus } from './store';

/** PayPal order ids are short upper-case alphanumerics (e.g. 5O190127TN364715T). */
export const ORDER_ID_RE = /^[A-Z0-9]{8,32}$/;

export const NOT_CAPTURED: readonly OrderStatus[] = ['created', 'approved', 'expired', 'failed'];

export interface CaptureDeps {
  store: PaymentsStore;
  paypal: PayPalClient;
  now?: () => Date;
}

export type CaptureError = 'not_found' | 'not_approved' | 'declined' | 'paypal_failed';

export type CaptureResult =
  | { ok: true; order: OrderRow; changed: boolean }
  | { ok: false; error: CaptureError; order?: OrderRow };

export interface CaptureFacts {
  captureId: string | null;
  captureStatus: string | null;
  payerEmail: string | null;
  payerId: string | null;
  amount: { value: string; currency_code: string } | null;
}

interface OrderWithPayer extends PayPalOrder {
  payer?: { email_address?: string; payer_id?: string };
  payment_source?: { paypal?: { email_address?: string; account_id?: string } };
}

interface CaptureUnit {
  payments?: {
    captures?: { id?: string; status?: string; amount?: { value: string; currency_code: string } }[];
  };
}

/** Reads the first capture and the payer from a PayPal order (capture response or GET order). */
export function readCaptureFacts(order: PayPalOrder): CaptureFacts {
  const o = order as OrderWithPayer;
  const unit = (o.purchase_units?.[0] ?? {}) as CaptureUnit;
  const capture = unit.payments?.captures?.[0];
  return {
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    payerEmail: o.payer?.email_address ?? o.payment_source?.paypal?.email_address ?? null,
    payerId: o.payer?.payer_id ?? o.payment_source?.paypal?.account_id ?? null,
    amount: capture?.amount ?? null,
  };
}

/** The `issue` code of a 422 from PayPal, e.g. ORDER_NOT_APPROVED. */
export function paypalIssue(err: unknown): string | null {
  if (!(err instanceof PayPalApiError)) return null;
  const details = (err.details as { details?: { issue?: string }[] } | null)?.details;
  return details?.[0]?.issue ?? null;
}

export async function captureCheckout(
  deps: CaptureDeps,
  input: { botId: string; orderId: string },
): Promise<CaptureResult> {
  const row = await deps.store.getOrder(input.orderId);
  if (!row || row.bot_id !== input.botId) return { ok: false, error: 'not_found' };
  // Refunded / reversed rows were captured too: nothing to capture again.
  if (isCapturedOrLater(row.status)) return { ok: true, order: row, changed: false };

  let order: PayPalOrder;
  try {
    order = await deps.paypal.captureOrder(row.order_id, row.order_id);
  } catch (err) {
    const issue = paypalIssue(err);
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      try {
        order = await deps.paypal.getOrder(row.order_id);
      } catch (readErr) {
        console.error('[paypal] re-read after ORDER_ALREADY_CAPTURED failed', { orderId: row.order_id, ...describeError(readErr) });
        return { ok: false, error: 'paypal_failed', order: row };
      }
    } else if (issue === 'ORDER_NOT_APPROVED' || issue === 'PAYER_ACTION_REQUIRED') {
      return { ok: false, error: 'not_approved', order: row };
    } else if (issue === 'INSTRUMENT_DECLINED') {
      const failed = await deps.store.updateOrder(row.order_id, row.bot_id, NOT_CAPTURED, { status: 'failed' });
      return { ok: false, error: 'declined', order: failed ?? row };
    } else {
      // A racing capture with the same Request-Id (return URL vs webhook) can be refused while the
      // first is in flight. Read the order: if it is captured, record it like a normal success.
      console.error('[paypal] capture failed', { orderId: row.order_id, ...describeError(err) });
      try {
        order = await deps.paypal.getOrder(row.order_id);
      } catch {
        return { ok: false, error: 'paypal_failed', order: row };
      }
      const status = readCaptureFacts(order).captureStatus;
      if (status !== 'COMPLETED' && status !== 'PENDING') return { ok: false, error: 'paypal_failed', order: row };
    }
  }

  return applyCapturedOrder(deps, row, order);
}

/**
 * Writes what PayPal says about an order into our row. `order` must come from PayPal's API
 * (capture response or GET), never from a webhook body.
 */
export async function applyCapturedOrder(
  deps: CaptureDeps,
  row: OrderRow,
  order: PayPalOrder,
): Promise<CaptureResult> {
  const facts = readCaptureFacts(order);
  const now = (deps.now ?? (() => new Date()))();

  if (facts.amount && (facts.amount.value !== centsToValue(row.amount_cents) || facts.amount.currency_code !== row.currency)) {
    // Should be impossible (we set the amount), so make it loud. The capture still happened.
    console.error('[paypal] captured amount differs from our order row', {
      orderId: row.order_id,
      expected: `${centsToValue(row.amount_cents)} ${row.currency}`,
      got: `${facts.amount.value} ${facts.amount.currency_code}`,
    });
  }

  const payer = { payer_email: facts.payerEmail, payer_id: facts.payerId };

  if (facts.captureStatus === 'COMPLETED' && facts.captureId) {
    const updated = await deps.store.updateOrder(row.order_id, row.bot_id, NOT_CAPTURED, {
      status: 'captured',
      capture_id: facts.captureId,
      captured_at: now.toISOString(),
      ...payer,
    });
    if (!updated) {
      // Another request captured it between our read and our write.
      const current = await deps.store.getOrder(row.order_id);
      return current ? { ok: true, order: current, changed: false } : { ok: false, error: 'not_found' };
    }
    await announcePayment(deps.store, updated);
    return { ok: true, order: updated, changed: true };
  }

  if (facts.captureStatus === 'PENDING' && facts.captureId) {
    // PayPal is holding the funds (e.g. review). PAYMENT.CAPTURE.COMPLETED will finish it.
    const updated = await deps.store.updateOrder(row.order_id, row.bot_id, ['created', 'approved', 'expired'], {
      status: 'approved',
      capture_id: facts.captureId,
      ...payer,
    });
    return { ok: true, order: updated ?? row, changed: Boolean(updated) };
  }

  if (facts.captureStatus === 'DECLINED' || facts.captureStatus === 'FAILED') {
    const updated = await deps.store.updateOrder(row.order_id, row.bot_id, NOT_CAPTURED, { status: 'failed', ...payer });
    return { ok: false, error: 'declined', order: updated ?? row };
  }

  console.error('[paypal] order has no usable capture', {
    orderId: row.order_id,
    orderStatus: order.status,
    captureStatus: facts.captureStatus,
  });
  return { ok: false, error: 'paypal_failed', order: row };
}

/** Buyer pressed "Cancel and return". Only an untouched order becomes `expired`. */
export async function cancelCheckout(
  store: PaymentsStore,
  input: { botId: string; orderId: string },
): Promise<OrderRow | null> {
  return store.updateOrder(input.orderId, input.botId, ['created'], { status: 'expired' });
}

/** The fixed sentence written to the conversation when a chat purchase is captured. */
export function paymentLine(order: Pick<OrderRow, 'order_id' | 'amount_cents' | 'currency'>): string {
  return `Payment received: ${formatMoney(order.amount_cents, order.currency)} (PayPal order ${order.order_id}). Thank you!`;
}

/**
 * Chat purchases (conversation_id set) get one `payment` line in the conversation. Called only
 * by the request that moved the row to `captured`, so it is written once.
 * /pricing purchases have no conversation and write nothing.
 */
export async function announcePayment(store: PaymentsStore, order: OrderRow): Promise<void> {
  if (!order.conversation_id) return;
  try {
    await store.insertPaymentResponse({
      botId: order.bot_id,
      conversationId: order.conversation_id,
      body: paymentLine(order),
    });
  } catch (err) {
    // The money part is done; a missing chat line must not turn the capture into an error.
    console.error('[paypal] payment line not saved', { orderId: order.order_id, message: (err as Error).message });
  }
}

// ── refunds and reversals → the order row (stage 4, 20261022_01) ─────────────────────────────

const PAYPAL_API_HOSTS = new Set(['api.paypal.com', 'api-m.paypal.com', 'api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);

/**
 * The capture id behind a refund resource: its `up` link, https://api(-m)(.sandbox).paypal.com/v2/payments/captures/{id}.
 * Anything else (another host, another path, no link) → null. Used on webhook bodies (as a lookup key
 * only) and on refunds re-read from PayPal (to prove which capture they belong to).
 */
export function captureIdFromRefundResource(resource: unknown): string | null {
  const links = (resource as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    const l = link as { rel?: unknown; href?: unknown };
    if (l?.rel !== 'up' || typeof l.href !== 'string') continue;
    let url: URL;
    try {
      url = new URL(l.href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !PAYPAL_API_HOSTS.has(url.hostname)) continue;
    const m = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (m) return m[1];
  }
  return null;
}

/**
 * The order state a capture's PayPal status stands for. Payments v2 lists no REVERSED capture status, so a
 * PAYMENT.CAPTURE.REVERSED event (signature-verified, so the event type is PayPal's word) is read against
 * the capture: fully refunded → `reversed` (terminal); only partly → `partially_refunded`, so a later
 * refund can still move it on. A REVERSED capture status is accepted as well should PayPal report it.
 */
function refundStateFor(captureStatus: string, reversal: boolean): RefundOrderStatus | null {
  if (captureStatus === 'REVERSED') return 'reversed';
  if (captureStatus === 'REFUNDED') return reversal ? 'reversed' : 'refunded';
  if (captureStatus === 'PARTIALLY_REFUNDED') return 'partially_refunded';
  return null;
}

const REFUND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface RefundResource {
  id?: unknown;
  status?: unknown;
  amount?: { value?: unknown; currency_code?: unknown };
  seller_payable_breakdown?: { total_refunded_amount?: { value?: unknown; currency_code?: unknown } };
  links?: unknown;
}

/**
 * The capture's refunded total to date, from a refund RE-READ from PayPal (GET /v2/payments/refunds/{id}).
 * Payments v2 puts it on the refund, not the capture: `seller_payable_breakdown.total_refunded_amount` —
 * "the total amount refunded from the original capture to date". Without it, this refund's own `amount`
 * is a lower bound (the database only ever raises refunded_cents). 0 = nothing usable: the refund is not
 * COMPLETED, belongs to another capture, is in another currency, or PayPal does not know it (404).
 * Throws on any other read failure.
 */
async function refundedTotalCents(
  deps: CaptureDeps,
  input: { captureId: string; refundId: string; currency: string; signal?: AbortSignal },
): Promise<number> {
  const { captureId, refundId, currency } = input;
  let refund: RefundResource;
  try {
    refund = (await deps.paypal.getRefund(refundId, { signal: input.signal })) as RefundResource;
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) return 0;
    throw err;
  }
  if (refund?.status !== 'COMPLETED' || captureIdFromRefundResource(refund) !== captureId) return 0;
  const total = refund.seller_payable_breakdown?.total_refunded_amount;
  const pick = total?.value !== undefined ? total : refund.amount;
  if (typeof pick?.currency_code !== 'string' || pick.currency_code.toUpperCase() !== currency) return 0;
  return valueToCents(pick.value) ?? 0;
}

export type OrderRefundSync =
  | { kind: 'updated'; order: OrderRow }
  /** Already in this state (duplicate or out-of-order event). */
  | { kind: 'unchanged'; order: OrderRow }
  | { kind: 'ignored'; reason: string };

/**
 * Moves our order row to the refund state PayPal reports for its capture, wherever the refund happened
 * (our refund.ts, the seller's PayPal dashboard, a reversal). Every fact is re-read from PayPal: the
 * capture (status, amount) and, for a partial refund, the refund named by `refundId` (its total). The
 * webhook body is only ever a lookup key. The write is one conditional UPDATE in the database
 * (applyOrderRefund) that only moves forward, so duplicates, late events and concurrent callers are safe.
 * Captures that are not one of this bot's orders cost no PayPal call. Throws when PayPal or the database
 * cannot be read (or `signal` aborts the PayPal reads); a 404 from PayPal is an answer (`ignored`).
 * A full refund or full reversal always records the capture amount; a refunded total that cannot be read
 * is sent as 0, which never lowers a known amount (the database keeps the greater).
 */
export async function syncOrderRefund(
  deps: CaptureDeps,
  input: { botId: string; captureId: string; refundId?: string | null; reversal?: boolean; signal?: AbortSignal },
): Promise<OrderRefundSync> {
  const row = await deps.store.getOrderByCapture(input.botId, input.captureId);
  if (!row) return { kind: 'ignored', reason: 'unknown capture' };

  let capture: PayPalCapture & { supplementary_data?: { related_ids?: { order_id?: string } } };
  try {
    capture = await deps.paypal.getCapture(input.captureId, { signal: input.signal });
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) return { kind: 'ignored', reason: 'unknown capture' };
    throw err;
  }
  const paypalOrderId = capture.supplementary_data?.related_ids?.order_id;
  if (paypalOrderId && paypalOrderId !== row.order_id) return { kind: 'ignored', reason: 'capture belongs to another order' };

  const status = refundStateFor(capture.status, input.reversal ?? false);
  if (!status) return { kind: 'ignored', reason: `capture ${capture.status}` };

  const captureCurrency = capture.amount?.currency_code?.toUpperCase();
  if (captureCurrency && captureCurrency !== row.currency) {
    console.error('[paypal] refund sync: capture currency differs from our order row', { orderId: row.order_id, captureCurrency });
    return { kind: 'ignored', reason: 'currency mismatch' };
  }

  // Fully refunded: the total is the capture amount itself. Partial: only the refund knows the total.
  let refundedCents = 0;
  if (capture.status === 'REFUNDED' || capture.status === 'REVERSED') {
    refundedCents = valueToCents(capture.amount?.value) ?? row.amount_cents;
  } else if (input.refundId && REFUND_ID_RE.test(input.refundId)) {
    refundedCents = await refundedTotalCents(deps, {
      captureId: input.captureId,
      refundId: input.refundId,
      currency: row.currency,
      signal: input.signal,
    });
  }

  const updated = await deps.store.applyOrderRefund({
    orderId: row.order_id,
    botId: row.bot_id,
    captureId: input.captureId,
    status,
    refundedCents,
  });
  if (updated) return { kind: 'updated', order: updated };
  return { kind: 'unchanged', order: (await deps.store.getOrder(row.order_id)) ?? row };
}

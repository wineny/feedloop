// requestRefund — a verified visitor asks for money back (design v2 §4) — and the two other ways a
// payment_actions row reaches PayPal: an operator's approval (executeApprovedAction) and
// reconciliation of a row whose answer we never saw (reconcileAction).
//
// Order of operations in requestRefund, and why:
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
//  5. Classifying what came back is the part that matters most (executeRefundCall). An HTTP success
//     carries a refund resource whose `status` is the real answer (COMPLETED | PENDING | FAILED |
//     CANCELLED, https://developer.paypal.com/api/payments/v2/definitions/refund/):
//       COMPLETED          → settle `executed`. If THAT write fails, the row stays as it was
//                            (executing/unknown): money moved, the reservation stays, the id is the key.
//                            Then paypal_orders follows from a fresh capture read (syncOrderRefund).
//       PENDING            → settle `unknown` WITH the refund id: PayPal accepted it but has not
//                            finished; reconciliation GETs the refund later. Visitor hears "processing".
//       FAILED / CANCELLED → settle `failed` (definite: no money moved, slot freed).
//       other / malformed  → settle `unknown` (we cannot read the answer).
//       4xx from PayPal    → settle `failed` (definite answer, slot freed).
//       anything else      → settle `unknown` (timeout, abort mid-flight, network, 5xx): we do not
//                            know whether PayPal refunded. The row stays live; a later retry with
//                            the same id is answered from PayPal's idempotency cache.
//     Never `failed` for a lost or unfinished answer: `failed` frees the slot and the next request
//     would open a NEW id and could refund twice.
//
// Reconciliation (reconcileAction) is how executing/unknown rows end: with a refund id we GET the
// refund; without one we re-send the same POST with the same PayPal-Request-Id, which PayPal answers
// from its idempotency cache if it did run and performs exactly once if it never arrived. It runs
// from the webhook (PAYMENT.CAPTURE.REFUNDED), from the daily cron, and lazily from the visitor
// tools when they meet a stuck row.

import { isSampleRef } from '@/lib/demo/sample-marker';
import { syncOrderRefund } from './capture';
import { isUncertainPayPalError, type PayPalClient } from './client';
import { describeError } from './checkout';
import { centsToValue, formatMoney, valueToCents } from './money';
import { refundExecutedLine, refundFailedLine, refundPendingLine, refundProcessingLine, refundRejectedLine } from './sentences';
import {
  STUCK_ACTION_STATUSES,
  isAnnouncedStatus,
  type AnnouncedStatus,
  type PaymentActionRow,
  type PaymentActionStatus,
  type PaymentsStore,
} from './store';

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
  /** The verified payer email, lower-cased. NULL/blank = the RPC waits for approval (v2). */
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
  /** The row exists and is now `failed`: PayPal said no (4xx / FAILED / CANCELLED), or we were cancelled before sending. */
  | { status: 'failed'; action: PaymentActionRow; reason: 'paypal_failed' | 'canceled' }
  /**
   * PayPal was asked and the outcome is not final: the answer was lost, or PayPal said PENDING
   * (`refundId` set). The row is `unknown` and keeps its reservation.
   */
  | { status: 'unknown'; action: PaymentActionRow; refundId?: string };

/** What executeRefundCall can report: the subset of RefundOutcome that follows a PayPal call. */
export type ExecuteOutcome = Extract<RefundOutcome, { status: 'executed' | 'failed' | 'unknown' }>;

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
    captureTotalCents: captureCents,
  });

  if (!decision.created) {
    // A repeat request is also a chance to write a sentence an earlier failure lost (idempotent in the DB).
    await announceStatus(deps.store, decision.action);
    return { status: 'already_open', action: decision.action };
  }
  if (!decision.auto) {
    await announceStatus(deps.store, decision.action, 'pending');
    return { status: 'pending', action: decision.action, amountCents, currency, checks: decision.checks ?? {} };
  }

  // 4. second gate: nothing has been sent yet, so a cancelled request can still be closed as certain.
  const action = decision.action;
  if (signal?.aborted) {
    const payload = refundPayload(amountCents, currency);
    await settle(deps.store, action, { status: 'failed', error: 'canceled_before_send', payload });
    return { status: 'failed', action, reason: 'canceled' };
  }

  // 5. execute
  return executeRefundCall(deps, action, { amountCents, currency, signal });
}

/**
 * The PayPal call for a row that is already `executing` (auto path, approval path) or `unknown`
 * (reconciliation retry), with PayPal-Request-Id = action.id and the classification described above.
 * `from` = the statuses the settle may move from.
 */
export async function executeRefundCall(
  deps: RefundDeps,
  action: PaymentActionRow,
  input: { amountCents: number; currency: string; signal?: AbortSignal; from?: readonly PaymentActionStatus[] },
): Promise<ExecuteOutcome> {
  const { amountCents, currency, signal } = input;
  const from = input.from ?? ['executing'];
  const payload = refundPayload(amountCents, currency);

  // The send gate, in the database, BEFORE the POST: refuses a row that is no longer sendable (the
  // caller's snapshot is stale — somebody closed it), records "may have been sent", and says whether
  // this is the first attempt (a definite 4xx is the answer) or a retry (a 4xx says nothing about the
  // original). If the gate itself fails, nothing is sent.
  let gate;
  try {
    gate = await deps.store.markSent(action.id);
  } catch (err) {
    console.error('[paypal] send gate failed, refund not sent', { actionId: action.id, message: (err as Error).message });
    return { status: 'unknown', action };
  }
  if (!gate.allowed) {
    console.warn('[paypal] send refused: row is no longer sendable', { actionId: action.id, status: gate.status });
    return readBack(deps, action, { status: 'unknown', action });
  }
  const first = gate.first;

  let refund;
  try {
    refund = await deps.paypal.refundCapture(action.target_id, {
      amountValue: payload.amount.value,
      currencyCode: currency,
      requestId: action.id,
      signal,
    });
  } catch (err) {
    const info = describeError(err);
    const error = String(info.name ?? info.message ?? 'paypal_failed').slice(0, MAX_ERROR_CHARS);
    if (isUncertainPayPalError(err) || !first) {
      // Lost / in progress (409) / network — or ANY error on a retry: PayPal's idempotency cache
      // answers a replay of a completed request with the resource, so an error on a replay is about
      // this request (credentials, permissions, validation), not about the original. Keep the row.
      console.error(first ? '[paypal] refundCapture: answer lost, row kept as unknown' : '[paypal] refundCapture: retry refused, row kept as unknown', {
        actionId: action.id,
        ...info,
      });
      return settleOrReadBack(deps, action, { status: 'unknown', error, payload, result: info }, from, { status: 'unknown', action });
    }
    // First attempt, definite refusal. The close applies only while no second attempt has started
    // (send_attempts = 1, checked in the UPDATE): if one has, its answer wins and this caller reads back.
    console.error('[paypal] refundCapture refused by PayPal on the first attempt', { actionId: action.id, ...info });
    return settleOrReadBack(
      deps,
      action,
      { status: 'failed', error, payload, result: info },
      from,
      { status: 'failed', action, reason: 'paypal_failed' },
      { onlyIfFirstAttempt: true },
    );
  }

  return classifyRefundResource(deps, action, refund, { amountCents, currency, payload, from, signal });
}

/** Maps a refund resource (from POST or from GET) onto the row and the outcome. */
async function classifyRefundResource(
  deps: RefundDeps,
  action: PaymentActionRow,
  refund: { id?: unknown; status?: unknown; amount?: unknown } | null | undefined,
  ctx: { amountCents: number; currency: string; payload: unknown; from: readonly PaymentActionStatus[]; signal?: AbortSignal },
): Promise<ExecuteOutcome> {
  const refundId = typeof refund?.id === 'string' && refund.id ? refund.id : null;
  const status = typeof refund?.status === 'string' ? refund.status : null;
  const result = { id: refundId, status, amount: refund?.amount ?? null };

  if (status === 'COMPLETED' && refundId) {
    // Money moved. If the settle write fails the row stays as it was (executing/unknown): still live,
    // same id, reconciliation finishes it. The outcome stays "executed" — that is what happened.
    const settled = await settle(deps.store, action, { status: 'executed', paypalRef: refundId, payload: ctx.payload, result }, ctx.from);
    if (!settled) {
      console.error('[paypal] refund completed but the row could not be settled; left for reconciliation', {
        actionId: action.id,
        refundId,
      });
    }
    await syncOrderAfterRefund(deps, action, refundId, ctx.signal);
    return { status: 'executed', action, refundId, amountCents: ctx.amountCents, currency: ctx.currency };
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    console.error('[paypal] refund resource not completed', { actionId: action.id, refundId, status });
    return settleOrReadBack(
      deps,
      action,
      { status: 'failed', error: `REFUND_${status}`, paypalRef: refundId, payload: ctx.payload, result },
      ctx.from,
      { status: 'failed', action, reason: 'paypal_failed' },
    );
  }

  if (status !== 'PENDING') {
    console.error('[paypal] refund response unrecognised; row kept as unknown', { actionId: action.id, refundId, status });
  }
  return settleOrReadBack(
    deps,
    action,
    { status: 'unknown', error: status === 'PENDING' ? null : 'REFUND_RESPONSE_UNRECOGNIZED', paypalRef: refundId, payload: ctx.payload, result },
    ctx.from,
    refundId ? { status: 'unknown', action, refundId } : { status: 'unknown', action },
  );
}

/**
 * Settles, and when the settle did not apply (a concurrent caller already moved the row), reads the
 * row back and answers with what is actually there: an `executed` row stays executed even if this
 * caller saw a 409 or a late FAILED. Two callers can never both "win" the same row.
 */
async function settleOrReadBack(
  deps: RefundDeps,
  action: PaymentActionRow,
  outcome: Parameters<PaymentsStore['settleAction']>[1],
  from: readonly PaymentActionStatus[],
  intended: ExecuteOutcome,
  opts?: { onlyIfNeverSent?: boolean; onlyIfFirstAttempt?: boolean },
): Promise<ExecuteOutcome> {
  const applied = await settle(deps.store, action, outcome, from, opts);
  if (applied) return intended;
  // Not applied: another caller moved the row (or a guard refused). Whatever the row says now is the
  // truth; a refused definite close becomes "unknown" — never "failed" on a stale basis.
  return readBack(deps, action, intended.status === 'failed' ? { status: 'unknown', action } : intended);
}

/** The row as it is now, mapped to an outcome; `fallback` when it cannot be read. */
async function readBack(deps: RefundDeps, action: PaymentActionRow, fallback: ExecuteOutcome): Promise<ExecuteOutcome> {
  let current: PaymentActionRow | null = null;
  try {
    current = await deps.store.getAction(action.id, action.bot_id);
  } catch (err) {
    console.error('[paypal] read-back failed', { actionId: action.id, message: (err as Error).message });
  }
  if (!current) return fallback;
  if (current.status === 'executed' && current.paypal_ref) {
    return {
      status: 'executed',
      action: current,
      refundId: current.paypal_ref,
      amountCents: current.amount_cents ?? 0,
      currency: current.currency ?? '',
    };
  }
  if (current.status === 'failed') return { status: 'failed', action: current, reason: 'paypal_failed' };
  return current.paypal_ref ? { status: 'unknown', action: current, refundId: current.paypal_ref } : { status: 'unknown', action: current };
}

// ── approval path ─────────────────────────────────────────────────────────────────────────────

export type ApprovedExecutionOutcome =
  | ExecuteOutcome
  /** The row was not an approved, not-yet-sent action (someone else is on it, or it was rejected). */
  | { status: 'not_executable'; action: PaymentActionRow }
  /** Re-read just before sending: the capture can no longer be refunded. Row settled failed. */
  | { status: 'capture_not_refundable'; action: PaymentActionRow };

/** Stored in `error` on a row the approval path did not send because its capture could not be re-read. Informational. */
export const NOT_SENT_CAPTURE_UNREADABLE = 'NOT_SENT_CAPTURE_UNREADABLE';

/**
 * True when the row provably never reached PayPal: `sent_at` is written before every POST and never
 * cleared. This is the caller's snapshot; the database re-checks it on the local close (onlyIfNeverSent).
 */
export function wasNeverSent(action: Pick<PaymentActionRow, 'sent_at'>): boolean {
  return action.sent_at === null;
}

type CapturePrecheck = { ok: true } | { ok: false; reason: 'unreadable' } | { ok: false; reason: 'not_refundable' };

/**
 * The pre-send check every path that may START a refund runs: the capture must still be in a
 * refundable state and the amount within its total. Re-read fresh from PayPal each time — an
 * approval may come a day after the request, a reconciliation days after a crash.
 */
async function precheckCapture(deps: RefundDeps, action: PaymentActionRow, signal?: AbortSignal): Promise<CapturePrecheck> {
  try {
    const capture = await deps.paypal.getCapture(action.target_id, { signal });
    const captureCents = valueToCents(capture.amount?.value);
    const ok = REFUNDABLE_STATUSES.has(capture.status) && captureCents !== null && (action.amount_cents ?? 0) <= captureCents;
    return ok ? { ok: true } : { ok: false, reason: 'not_refundable' };
  } catch (err) {
    console.error('[paypal] capture pre-check failed', { actionId: action.id, ...describeError(err) });
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * After `payment_action_decide(approve)` moved the row to `executing`, send the refund. The capture
 * is re-read first (the operator may be acting a day later): a capture that is no longer refundable
 * closes the row as failed without touching PayPal; an unreadable capture sends nothing and marks the
 * row `unknown` + NOT_SENT_CAPTURE_UNREADABLE so the reaper repeats this same check before it ever
 * sends. Ownership was the caller's check.
 */
export async function executeApprovedAction(deps: RefundDeps, action: PaymentActionRow): Promise<ApprovedExecutionOutcome> {
  // Seeded sample history (scripts/seed-sample-history.ts) has a fake capture id: never sent to PayPal.
  if (isSampleRef(action.target_id)) return { status: 'not_executable', action };
  if (action.status !== 'executing' || action.kind !== 'refund') return { status: 'not_executable', action };
  if (action.amount_cents === null || !action.currency) return { status: 'not_executable', action };

  const payload = refundPayload(action.amount_cents, action.currency);
  const check = await precheckCapture(deps, action);
  if (!check.ok && check.reason === 'unreadable') {
    await settle(deps.store, action, { status: 'unknown', error: NOT_SENT_CAPTURE_UNREADABLE, payload });
    return { status: 'unknown', action };
  }
  if (!check.ok) {
    await settle(deps.store, action, { status: 'failed', error: 'CAPTURE_NOT_REFUNDABLE', payload });
    return { status: 'capture_not_refundable', action };
  }
  return executeRefundCall(deps, action, { amountCents: action.amount_cents, currency: action.currency });
}

// ── reconciliation ────────────────────────────────────────────────────────────────────────────

export type ReconcileOutcome =
  | ExecuteOutcome
  /** Not a stuck row (nothing to do). */
  | { status: 'noop'; action: PaymentActionRow }
  /** PayPal still says PENDING for the refund we know about. */
  | { status: 'still_pending'; action: PaymentActionRow }
  /** PayPal could not be reached; try again later. */
  | { status: 'unreachable'; action: PaymentActionRow };

export function isStuckAction(action: Pick<PaymentActionRow, 'status'>): boolean {
  return STUCK_ACTION_STATUSES.includes(action.status);
}

/**
 * Finishes an executing/unknown row.
 *  - With a refund id: GET it and settle on its status (a fresh provider read, never a webhook body).
 *  - Without one: the same pre-send capture check as the approval path, then re-send the POST with the
 *    same PayPal-Request-Id — PayPal answers from its idempotency cache if the original ran, or
 *    performs it exactly once if it never arrived. Either way no second refund.
 *    A capture that cannot be read → nothing is sent (`unreachable`). A capture that is not
 *    refundable → `failed` only when the row provably never reached PayPal (wasNeverSent); otherwise
 *    the idempotent re-send is the only way to learn what happened, and PayPal itself refuses it if
 *    the capture really cannot be refunded.
 */
export async function reconcileAction(
  deps: RefundDeps,
  action: PaymentActionRow,
  opts: { signal?: AbortSignal } = {},
): Promise<ReconcileOutcome> {
  // Seeded sample history: no PayPal read, no re-send, no sentence into its conversation. Covers every
  // caller (sweep, webhook, visitor tools).
  if (isSampleRef(action.target_id)) return { status: 'noop', action };
  if (action.kind !== 'refund') return { status: 'noop', action };
  if (!isStuckAction(action)) {
    // A finished row met again (webhook, sweep, a visitor asking): the one thing left to check is that
    // its sentence reached the conversation. Idempotent in the database; nothing about money is touched.
    await announceStatus(deps.store, action);
    return { status: 'noop', action };
  }
  if (action.amount_cents === null || !action.currency) return { status: 'noop', action };
  const ctx = { amountCents: action.amount_cents, currency: action.currency, from: STUCK_ACTION_STATUSES };

  if (action.paypal_ref) {
    let refund;
    try {
      refund = await deps.paypal.getRefund(action.paypal_ref, { signal: opts.signal });
    } catch (err) {
      console.error('[paypal] reconcile: getRefund failed', { actionId: action.id, refundId: action.paypal_ref, ...describeError(err) });
      return { status: 'unreachable', action };
    }
    if (refund?.status === 'PENDING') return { status: 'still_pending', action };
    return classifyRefundResource(deps, action, refund, { ...ctx, payload: refundPayload(ctx.amountCents, ctx.currency), signal: opts.signal });
  }

  const check = await precheckCapture(deps, action, opts.signal);
  if (!check.ok && check.reason === 'unreadable') return { status: 'unreachable', action };
  if (!check.ok && wasNeverSent(action)) {
    // The database re-checks sent_at IS NULL: a stale snapshot of a row another caller has since
    // sent cannot close it. Three ways out, and only one leads to a send:
    //   applied → failed (certain: never sent, capture unrefundable).
    //   error   → nothing is known and nothing is sent; the row stays for the next sweep.
    //   refused → read the row back; re-send ONLY on positive persisted evidence that it was sent
    //             (sent_at set), otherwise answer with whatever the row says now.
    const payload = refundPayload(ctx.amountCents, ctx.currency);
    const closed = await settleTri(deps.store, action, { status: 'failed', error: 'CAPTURE_NOT_REFUNDABLE', payload }, STUCK_ACTION_STATUSES, {
      onlyIfNeverSent: true,
    });
    if (closed === 'applied') return { status: 'failed', action, reason: 'paypal_failed' };
    if (closed === 'error') return { status: 'unreachable', action };
    let current: PaymentActionRow | null = null;
    try {
      current = await deps.store.getAction(action.id, action.bot_id);
    } catch (err) {
      console.error('[paypal] reconcile: read-back failed', { actionId: action.id, message: (err as Error).message });
      return { status: 'unreachable', action };
    }
    if (!current || !current.sent_at) return readBack(deps, action, { status: 'unknown', action });
    // somebody sent it since our snapshot: continue with that row
    return executeRefundCall(deps, current, { ...ctx, signal: opts.signal });
  }
  return executeRefundCall(deps, action, { ...ctx, signal: opts.signal });
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/** How long a completed refund waits for the order row to follow before answering anyway. */
export const ORDER_SYNC_AFTER_REFUND_MS = 2_500;

/**
 * Our refund completed: the order row (paypal_orders) follows, from a fresh capture/refund read
 * (syncOrderRefund). Bounded by ORDER_SYNC_AFTER_REFUND_MS and the caller's signal: the PayPal reads get
 * the combined signal, and the wait itself stops at the bound even if a read or the database hangs — the
 * money moved, so the answer must not wait on bookkeeping (the agent's total budget is 30 s). Never
 * throws; the PAYMENT.CAPTURE.REFUNDED webhook runs the same sync again if this one could not finish.
 */
async function syncOrderAfterRefund(deps: RefundDeps, action: PaymentActionRow, refundId: string, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(ORDER_SYNC_AFTER_REFUND_MS);
  const bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const sync = syncOrderRefund(deps, { botId: action.bot_id, captureId: action.target_id, refundId, signal: bound });
  const stop = new Promise<never>((_, reject) => {
    const fire = () => reject(bound.reason instanceof Error ? bound.reason : new Error('order sync aborted'));
    if (bound.aborted) fire();
    else bound.addEventListener('abort', fire, { once: true });
  });
  try {
    await Promise.race([sync, stop]);
  } catch (err) {
    console.error('[paypal] order refund state not synced; the webhook will retry', { actionId: action.id, ...describeError(err) });
  }
}

function refundPayload(amountCents: number, currency: string) {
  return { amount: { value: centsToValue(amountCents), currency_code: currency } };
}

/** settleAction that never throws: a DB hiccup here must not be mistaken for a PayPal answer. */
async function settle(
  store: PaymentsStore,
  action: PaymentActionRow,
  outcome: Parameters<PaymentsStore['settleAction']>[1],
  from?: readonly PaymentActionStatus[],
  opts?: { onlyIfNeverSent?: boolean; onlyIfFirstAttempt?: boolean },
): Promise<boolean> {
  return (await settleTri(store, action, outcome, from, opts)) === 'applied';
}

/**
 * Like settle, but tells a conditional miss (the row is not in the expected state any more) from a
 * database error (nothing is known). Callers that would SEND on a miss must not send on an error.
 *
 * An APPLIED settle is also the moment the visitor is told (design §2, §5): the sentence for the new
 * status is handed to the database right after. The database, not this snapshot, decides whether it is
 * written: only while the row is still in that status (a sentence for a state the row has since left
 * is dropped) and once per (row, status) (a retry that stays `unknown` says nothing new). A sentence the
 * database could not take now is written later by the reaper (listUnannouncedActions).
 */
async function settleTri(
  store: PaymentsStore,
  action: PaymentActionRow,
  outcome: Parameters<PaymentsStore['settleAction']>[1],
  from?: readonly PaymentActionStatus[],
  opts?: { onlyIfNeverSent?: boolean; onlyIfFirstAttempt?: boolean },
): Promise<'applied' | 'refused' | 'error'> {
  let ok: boolean;
  try {
    ok = await store.settleAction(action.id, outcome, from, opts);
  } catch (err) {
    console.error('[paypal] settleAction threw', { actionId: action.id, status: outcome.status, message: (err as Error).message });
    return 'error';
  }
  if (!ok) {
    console.error('[paypal] settleAction: row was not in an expected status', { actionId: action.id, status: outcome.status });
    return 'refused';
  }
  await announceStatus(store, action, outcome.status);
  return 'applied';
}

/**
 * The server-fixed sentence for a row in `status` (sentences.ts), or null when there is nothing to say
 * (in flight, expired, or a row without an amount). Amount, currency and origin never change after the
 * row is created, so a snapshot is a safe source for them; the STATUS is checked by the database.
 */
export function sentenceFor(action: PaymentActionRow, status: AnnouncedStatus): string | null {
  if (action.amount_cents === null || !action.currency) return null;
  const amount = formatMoney(action.amount_cents, action.currency);
  switch (status) {
    case 'pending':
      return refundPendingLine(amount);
    case 'executed':
      return refundExecutedLine(amount, action.origin);
    case 'failed':
      return refundFailedLine(amount);
    case 'rejected':
      return refundRejectedLine(amount);
    case 'unknown':
      return refundProcessingLine(amount);
  }
}

/**
 * Tells the visitor the row is in `status` (default: the snapshot's status) — through the database's
 * once-per-(row, status) gate, so a stale snapshot, a retry or a concurrent caller can never write a
 * duplicate or an out-of-date sentence. true = the line was written now. Never throws: the money state
 * is already recorded, and the reaper retries missing sentences from the database's own list.
 */
export async function announceStatus(store: PaymentsStore, action: PaymentActionRow, status: PaymentActionStatus = action.status): Promise<boolean> {
  if (!action.conversation_id || !isAnnouncedStatus(status)) return false;
  const body = sentenceFor(action, status);
  if (!body) return false;
  try {
    return await store.announceAction(action.id, status, body);
  } catch (err) {
    console.error('[paypal] payment line not saved; the reaper will retry', { actionId: action.id, status, message: (err as Error).message });
    return false;
  }
}

// The tools a website visitor's payment agent gets (design v2 §2). Wrappers only — never a raw
// PayPal toolkit tool. Each one is scoped to (bot, conversation) by the server, so the model
// cannot name another conversation, another bot's order, or an amount the price table does not say.
//
//   find_my_payment(order_id, email)   both must match → recorded as this conversation's verified payment
//   get_payment_status()               the verified payment's current state, re-read from PayPal
//   create_checkout(product_id, qty)   a PayPal order at the product's listed price (stage-2 createCheckout)
//   request_refund(amount?, reason)    guardrail decision → auto refund or approval card (./refund.ts)
//
// When the bot's PayPal Agent Toolkit is passed in (`toolkit`, sandbox only), two read-only lookups
// are added. They run the toolkit's own get_order / get_refund, but only behind the verified-payment
// guard (see `guardedToolkitTools`): a visitor can read the payment they proved they own, nothing else.
//
//   paypal_get_order(order_id)         toolkit get_order, only for the verified order id
//   paypal_get_refund(refund_id?)      toolkit get_refund, only for a refund we recorded on the verified capture
//
// No list_* tool: PayPal's transaction search has no payer filter and would show a visitor the
// seller's whole month. The owner's dashboard is where those live.
//
// Tool results are plain data for the model to relay. The sentences the visitor finally reads for a
// money outcome (refunded / waiting / declined) are server-fixed and come with the card in task 5/6.

import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { PaymentToolTrace } from './agent';
import { ORDER_ID_RE, readCaptureFacts } from './capture';
import { createCheckout, describeError, MAX_QUANTITY } from './checkout';
import type { PayPalClient } from './client';
import { formatMoney } from './money';
import { isStuckAction, reconcileAction, requestRefund } from './refund';
import { checkoutLine } from './sentences';
import { parseToolkitResult } from './toolkit';
import { isCapturedOrLater, type OrderStatus, type PaymentActionRow, type PaymentsStore, type ProductRow, type VerificationRow } from './store';

/**
 * A stuck row (executing/unknown) older than this is reconciled on the spot before the visitor is
 * answered, so "any news?" gets the real state instead of "processing" until the daily sweep.
 * Younger rows may still be in flight in another request.
 */
export const LAZY_RECONCILE_AFTER_MS = 2 * 60_000;

/**
 * What the AI SDK passes to `execute` as its second argument. `abortSignal` carries the tool budget
 * (toolMs) and the request's own cancellation; every PayPal read/write below forwards it, and the
 * refund path checks it before each write. A tool that ignored it would keep moving money after the
 * model had already been told the call timed out.
 */
interface ToolCallOptions {
  abortSignal?: AbortSignal;
}

export const VISITOR_TOOL_NAMES = ['find_my_payment', 'get_payment_status', 'create_checkout', 'request_refund'] as const;

/** The guarded PayPal Agent Toolkit lookups, present only when the caller passes `toolkit`. */
export const TOOLKIT_VISITOR_TOOL_NAMES = ['paypal_get_order', 'paypal_get_refund'] as const;

export interface VisitorToolDeps {
  botId: string;
  conversationId: string;
  store: PaymentsStore;
  paypal: PayPalClient;
  /** Server origin for return URLs, resolved lazily so a missing env only breaks create_checkout. */
  origin: () => string;
  /**
   * Called once when request_refund leaves a NEW row in `pending` (the guardrail asked for a person).
   * The widget route uses it to raise the inbox badge and mail the owner (design §4). Not awaited;
   * failures are the hook's to log — the visitor's answer does not depend on it.
   */
  onPendingApproval?: (action: PaymentActionRow) => void | Promise<void>;
  /**
   * The bot's PayPal Agent Toolkit tools (toolkit.ts toolkitToolsForBot), or null/absent when the bot
   * has none. Only get_order and get_refund are used, and only through the guard; nothing in this
   * object is handed to the model as is.
   */
  toolkit?: Record<string, Tool> | null;
}

/** One answer for "wrong id", "wrong email" and "someone else's order": no hint which part failed. */
const NOT_FOUND = { found: false as const, reason: 'no_match' as const };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the visitor is told about an order row's state. */
export function describeOrderStatus(
  status: OrderStatus,
): 'paid' | 'processing' | 'not_paid' | 'expired' | 'failed' | 'partially_refunded' | 'refunded' | 'reversed' {
  if (status === 'captured') return 'paid';
  if (status === 'approved') return 'processing';
  if (status === 'created') return 'not_paid';
  return status;
}

/** What the visitor is told about a capture's state, from PayPal's own status. */
export function describeCaptureStatus(
  status: string,
): 'paid' | 'processing' | 'refunded' | 'partially_refunded' | 'reversed' | 'failed' | 'unknown' {
  switch (status) {
    case 'COMPLETED':
      return 'paid';
    case 'PENDING':
      return 'processing';
    case 'REFUNDED':
      return 'refunded';
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded';
    case 'REVERSED':
      return 'reversed';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * PayPal's refunded total so far, from our order row (the webhook / refund sync keeps it), as a field to
 * spread into a tool result — absent when nothing was refunded or the total could not be read (0).
 */
function refundedAmount(row: { refunded_cents: number; currency: string } | null): { refunded_amount?: string } {
  return row && row.refunded_cents > 0 ? { refunded_amount: formatMoney(row.refunded_cents, row.currency) } : {};
}

/** Dollars as the model says them ("9.5", 9.5) → cents, or null when it is not a sane amount. */
export function majorToCents(amount: unknown): number | null {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return Math.abs(cents - n * 100) < 1e-6 ? cents : null;
}

export function createVisitorTools(deps: VisitorToolDeps): ToolSet {
  const { botId, conversationId, store, paypal } = deps;

  const find_my_payment = tool({
    description:
      'Verify that the visitor owns a payment. Needs BOTH the PayPal order id (17 characters, e.g. 5O190127TN364715T) and the email address used to pay. Succeeds only when both match; then the payment becomes the verified payment of this conversation and the other tools can act on it.',
    inputSchema: z.object({
      order_id: z.string().min(8).max(32).describe('The PayPal order id the visitor gave'),
      email: z.string().min(3).max(254).describe('The email address the visitor says they paid with'),
    }),
    execute: async ({ order_id, email }, { abortSignal }: ToolCallOptions = {}) => {
      const orderId = order_id.trim().toUpperCase();
      const mail = email.trim().toLowerCase();
      if (!ORDER_ID_RE.test(orderId) || !mail.includes('@')) return NOT_FOUND;

      const row = await store.getOrder(orderId);
      if (!row || row.bot_id !== botId) return NOT_FOUND;

      let payerEmail = row.payer_email;
      let captureId = row.capture_id;
      const capturedAt = row.captured_at ?? null;
      let status = describeOrderStatus(row.status);
      if (!payerEmail) {
        // Our row has no payer yet (not captured, or captured by a path that did not record it):
        // the only other source of truth is PayPal's order, read by the server.
        try {
          const facts = readCaptureFacts(await paypal.getOrder(orderId, { signal: abortSignal }));
          payerEmail = facts.payerEmail;
          if (facts.captureStatus === 'COMPLETED' && facts.captureId) {
            captureId = facts.captureId;
            status = 'paid';
          }
        } catch (err) {
          console.error('[paypal] find_my_payment: getOrder failed', { orderId, ...describeError(err) });
          return { found: false as const, reason: 'unavailable' as const };
        }
      }
      if (!payerEmail || payerEmail.trim().toLowerCase() !== mail) return NOT_FOUND;

      await store.upsertVerification({
        conversation_id: conversationId,
        bot_id: botId,
        order_id: orderId,
        capture_id: captureId,
        payer_email: mail,
        amount_cents: row.amount_cents,
        currency: row.currency,
        captured_at: capturedAt,
      });
      return {
        found: true as const,
        order_id: orderId,
        amount: formatMoney(row.amount_cents, row.currency),
        currency: row.currency,
        payment_status: status,
        ...refundedAmount(row),
        paid_at: capturedAt,
        // A partly refunded payment can be refunded further; the guardrail still decides (approval).
        refundable: status === 'paid' || status === 'partially_refunded',
      };
    },
  });

  const get_payment_status = tool({
    description:
      "Current state of this conversation's verified payment (paid / processing / partially_refunded / refunded / reversed / failed) and of any refund request on it. refunded_amount, when present, is the total PayPal has refunded so far. reversed means PayPal took the payment back (for example a chargeback); it cannot be refunded again. Call find_my_payment first if nothing is verified yet.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }: ToolCallOptions = {}) => {
      const stored = await store.latestVerification(conversationId);
      if (!stored) return { verified: false as const };
      const v = await refreshVerification(stored, abortSignal);
      const base = { verified: true as const, order_id: v.order_id, amount: formatMoney(v.amount_cents, v.currency), currency: v.currency };

      if (!v.capture_id) {
        // Still not captured anywhere we can see.
        const row = await store.getOrder(v.order_id);
        return { ...base, payment_status: row ? describeOrderStatus(row.status) : 'unknown', refund: null };
      }

      // Our row (kept current by the webhook / refund sync) backs up PayPal's live capture status:
      // a full reversal reads as REFUNDED on the capture (Payments v2 has no REVERSED capture status),
      // and when PayPal cannot be read the row is the best we have.
      const row = await store.getOrder(v.order_id);
      let paymentStatus: ReturnType<typeof describeCaptureStatus> | ReturnType<typeof describeOrderStatus>;
      try {
        paymentStatus = describeCaptureStatus((await paypal.getCapture(v.capture_id, { signal: abortSignal })).status);
      } catch (err) {
        console.error('[paypal] get_payment_status: getCapture failed', { captureId: v.capture_id, ...describeError(err) });
        paymentStatus = row ? describeOrderStatus(row.status) : 'unknown';
      }
      if (row?.status === 'reversed') paymentStatus = 'reversed';
      const action = await freshenAction(await store.latestRefundAction(botId, v.capture_id), abortSignal);
      const refunded =
        paymentStatus === 'partially_refunded' || paymentStatus === 'refunded' || paymentStatus === 'reversed' ? refundedAmount(row) : {};
      return {
        ...base,
        payment_status: paymentStatus,
        ...refunded,
        refund: action
          ? {
              status: describeActionStatus(action.status),
              amount: action.amount_cents !== null && action.currency ? formatMoney(action.amount_cents, action.currency) : null,
              requested_at: action.created_at,
            }
          : null,
      };
    },
  });

  const create_checkout = tool({
    description:
      'Create a PayPal checkout for one of the listed products at its listed price. Normally a "Pay with PayPal" card with the link is shown to the visitor automatically (card_shown: true) — just tell them it is there. If the result says card_shown: false, the card could not be shown: give the visitor the approve_url as a plain link instead. Use the product_id (or sku) from the product list; the price cannot be changed.',
    inputSchema: z.object({
      product_id: z.string().min(1).max(64).describe('product_id or sku from the product list'),
      quantity: z.number().int().min(1).max(MAX_QUANTITY).default(1),
    }),
    execute: async ({ product_id, quantity }, { abortSignal }: ToolCallOptions = {}) => {
      // Creating an order moves no money, but an order opened after the model stopped waiting is
      // one nobody will show the visitor; stop before PayPal.
      if (abortSignal?.aborted) return { ok: false as const, error: 'canceled' as const };
      let origin: string;
      try {
        origin = deps.origin();
      } catch (err) {
        console.error('[paypal] create_checkout: origin unavailable', { message: (err as Error).message });
        return { ok: false as const, error: 'checkout_unavailable' as const };
      }
      const product = await resolveProduct(store, botId, product_id);
      if (!product) return { ok: false as const, error: 'product_not_found' as const };
      // The product lookup may have used up the budget; createCheckout checks again before the POST
      // and forwards the signal into it.
      if (abortSignal?.aborted) return { ok: false as const, error: 'canceled' as const };

      const r = await createCheckout(
        { store, paypal, origin },
        { botId, productId: product.id, quantity, conversationId, signal: abortSignal },
      );
      if (!r.ok) return { ok: false as const, error: r.error };
      const amount = formatMoney(r.amountCents, r.currency);
      const base = { ok: true as const, order_id: r.orderId, amount, currency: r.currency, product: r.product.name, quantity: r.quantity };
      // The "Pay with PayPal" card: server data (the approve URL createCheckout validated), written as a
      // `payment` line the widget turns into a button. The model is told the card is there instead of
      // being given the URL — unless the line could not be saved: then the order exists and the only way
      // the visitor can still reach it is the link, so the model gets it (card_shown: false). No second
      // order is created just to retry a chat write.
      try {
        await store.insertPaymentResponse({
          botId,
          conversationId,
          body: checkoutLine({ amount, product: r.product.name, quantity: r.quantity, approveUrl: r.approveUrl }),
        });
      } catch (err) {
        console.error('[paypal] checkout line not saved; link handed to the model', { orderId: r.orderId, message: (err as Error).message });
        return { ...base, card_shown: false as const, approve_url: r.approveUrl };
      }
      return { ...base, card_shown: true as const };
    },
  });

  const request_refund = tool({
    description:
      "Ask for a refund of this conversation's verified payment. Only works after find_my_payment succeeded and the payment is paid (a partially refunded payment can be refunded further). The system decides: it refunds automatically within the store's limits, otherwise the owner reviews it. The visitor is shown the result as a card automatically; add one short sentence and do not promise anything the result does not say.",
    inputSchema: z.object({
      amount: z
        .number()
        .positive()
        .optional()
        .describe('Amount to refund in the payment currency (e.g. 9.5). Omit for the whole payment.'),
      reason: z
        .string()
        .min(1)
        .max(300)
        .describe("The visitor's reason, in their words. Do not include the email address or the order id."),
    }),
    execute: async ({ amount, reason }, { abortSignal }: ToolCallOptions = {}) => {
      const stored = await store.latestVerification(conversationId);
      if (!stored) return { status: 'not_verified' as const };
      const v = await refreshVerification(stored, abortSignal);
      if (!v.capture_id) return { status: 'not_paid' as const };

      const amountCents = amount === undefined ? null : majorToCents(amount);
      if (amount !== undefined && amountCents === null) return { status: 'declined' as const, reason: 'bad_amount' as const };

      const outcome = await requestRefund(
        { store, paypal },
        { botId, conversationId, captureId: v.capture_id, amountCents, reason, customerKey: v.payer_email, signal: abortSignal },
      );
      switch (outcome.status) {
        case 'executed':
          return { status: 'refunded' as const, amount: formatMoney(outcome.amountCents, outcome.currency), refund_id: outcome.refundId };
        case 'pending':
          if (deps.onPendingApproval) {
            try {
              void Promise.resolve(deps.onPendingApproval(outcome.action)).catch((err) =>
                console.error('[paypal] onPendingApproval failed', { actionId: outcome.action.id, message: (err as Error).message }),
              );
            } catch (err) {
              console.error('[paypal] onPendingApproval threw', { actionId: outcome.action.id, message: (err as Error).message });
            }
          }
          return { status: 'waiting_for_approval' as const, amount: formatMoney(outcome.amountCents, outcome.currency) };
        case 'already_open': {
          const current = (await freshenAction(outcome.action, abortSignal)) ?? outcome.action;
          return {
            status: 'already_requested' as const,
            current: describeActionStatus(current.status),
            amount:
              current.amount_cents !== null && current.currency ? formatMoney(current.amount_cents, current.currency) : null,
          };
        }
        case 'refused':
          return outcome.reason === 'canceled'
            ? { status: 'canceled' as const }
            : { status: 'declined' as const, reason: outcome.reason };
        case 'failed':
          return outcome.reason === 'canceled' ? { status: 'canceled' as const } : { status: 'failed' as const };
        case 'unknown':
          // PayPal was asked and the answer was lost. Honest word for the visitor: it is in progress,
          // and the team will confirm. Never "refunded", never "failed".
          return { status: 'processing' as const };
      }
    },
  });

  /**
   * Reconciles a stuck action that has been stuck long enough, then returns the row as it is now.
   * Never throws: a failed reconciliation just leaves the row as it was.
   */
  async function freshenAction(action: PaymentActionRow | null, signal?: AbortSignal): Promise<PaymentActionRow | null> {
    if (!action || !isStuckAction(action)) return action;
    if (Date.now() - new Date(action.updated_at).getTime() < LAZY_RECONCILE_AFTER_MS) return action;
    try {
      await reconcileAction({ store, paypal }, action, { signal });
    } catch (err) {
      console.error('[paypal] lazy reconcile failed', { actionId: action.id, ...describeError(err) });
    }
    return (await store.getAction(action.id, botId)) ?? action;
  }

  /**
   * A payment verified before it was captured (approved, not yet paid) keeps capture_id NULL. When
   * the return URL / webhook captures it later, the verification is still valid — same order, same
   * payer, proven once — so refresh the server-owned capture facts instead of asking the visitor to
   * verify again. Our paypal_orders row first; PayPal's order only if the row still says unpaid.
   */
  async function refreshVerification(v: VerificationRow, signal?: AbortSignal): Promise<VerificationRow> {
    if (v.capture_id) return v;
    let captureId: string | null = null;
    let capturedAt: string | null = null;
    const row = await store.getOrder(v.order_id);
    if (row && row.bot_id === botId && isCapturedOrLater(row.status) && row.capture_id) {
      captureId = row.capture_id;
      capturedAt = row.captured_at;
    } else {
      try {
        const facts = readCaptureFacts(await paypal.getOrder(v.order_id, { signal }));
        if (facts.captureStatus === 'COMPLETED' && facts.captureId) captureId = facts.captureId;
      } catch (err) {
        console.error('[paypal] refreshVerification: getOrder failed', { orderId: v.order_id, ...describeError(err) });
      }
    }
    if (!captureId) return v;
    const refreshed: VerificationRow = { ...v, capture_id: captureId, captured_at: capturedAt };
    await store.upsertVerification({
      conversation_id: v.conversation_id,
      bot_id: v.bot_id,
      order_id: v.order_id,
      capture_id: captureId,
      payer_email: v.payer_email,
      amount_cents: v.amount_cents,
      currency: v.currency,
      captured_at: capturedAt,
    });
    return refreshed;
  }

  /**
   * The verified-payment guard for toolkit lookups. The toolkit tools themselves accept ANY id, and the
   * visitor is anonymous: an unguarded get_order would show anyone's payer email and amounts for a typed
   * id. So the rule is checked here, on the server, before the toolkit is called:
   *  - nothing verified in this conversation (find_my_payment)        → not_verified, no PayPal call
   *  - order id ≠ the verified order id                                → not_your_payment, no PayPal call
   *  - refund id not one we recorded on the verified capture           → not_your_payment, no PayPal call
   * The toolkit is then called with the server's id, never the model's text, and only a short summary
   * of the answer goes back (no payee / fee breakdown / payer account fields).
   */
  function guardedToolkitTools(toolkit: Record<string, Tool>): ToolSet {
    const out: ToolSet = {};
    const getOrder = toolkitExecute(toolkit.get_order);
    const getRefund = toolkitExecute(toolkit.get_refund);
    // One PayPal fetch per id per turn (this closure lives for one agent turn): parallel or repeated
    // calls by the model share the first call's promise.
    const orderLookups = new Map<string, Promise<unknown>>();
    const refundLookups = new Map<string, Promise<unknown>>();

    if (getOrder) {
      out.paypal_get_order = tool({
        description:
          "PayPal Agent Toolkit lookup of the verified payment's PayPal order: order status, when it was created and paid, what was bought, and each capture and refund with its status, amount and time. Only works for the order id verified with find_my_payment in this conversation. Use it for detail questions (\"when did I pay?\", \"what did I buy?\"); get_payment_status stays the first answer for \"is it paid / refunded?\".",
        inputSchema: z.object({
          order_id: z.string().min(8).max(32).describe('The verified PayPal order id'),
        }),
        execute: async ({ order_id }, options) => {
          try {
            const v = await store.latestVerification(conversationId);
            if (!v || v.bot_id !== botId || isToolkitVerificationExpired(v)) return TOOLKIT_NOT_VERIFIED;
            if (order_id.trim().toUpperCase() !== v.order_id) return TOOLKIT_REFUSED;
            if (options?.abortSignal?.aborted) return TOOLKIT_UNAVAILABLE;
            // Only server-side values go to the toolkit: it puts ids into the URL path unencoded.
            let lookup = orderLookups.get(v.order_id);
            if (!lookup) {
              lookup = getOrder({ id: v.order_id }, options);
              orderLookups.set(v.order_id, lookup);
            }
            const raw = await untilAborted(lookup, options?.abortSignal);
            if (raw === ABORTED) return TOOLKIT_UNAVAILABLE;
            const order = parseToolkitResult(raw);
            if (!order || order.id !== v.order_id) return TOOLKIT_UNAVAILABLE;
            return { ok: true as const, source: 'paypal_agent_toolkit' as const, ...summarizeToolkitOrder(order) };
          } catch (err) {
            console.error('[paypal] paypal_get_order failed', { message: errorText(err) });
            return TOOLKIT_UNAVAILABLE;
          }
        },
      });
    }

    if (getRefund) {
      out.paypal_get_refund = tool({
        description:
          "PayPal Agent Toolkit lookup of a refund on the verified payment: its PayPal status (COMPLETED / PENDING / FAILED / CANCELLED), amount and when it was created and last updated. Leave refund_id empty for the latest refund. Only refunds made through this chat on the verified payment can be read. Call find_my_payment first if nothing is verified yet.",
        inputSchema: z.object({
          refund_id: z.string().min(8).max(32).optional().describe('A refund id from an earlier refund result. Omit for the latest refund.'),
        }),
        execute: async ({ refund_id }, options) => {
          try {
            const stored = await store.latestVerification(conversationId);
            // Age is checked on the stored row BEFORE refreshVerification, which rewrites verified_at.
            if (!stored || stored.bot_id !== botId || isToolkitVerificationExpired(stored)) return TOOLKIT_NOT_VERIFIED;
            const v = await refreshVerification(stored, options?.abortSignal);
            const refs = v.capture_id ? await store.listRefundRefs(botId, v.capture_id) : [];
            const wanted = refund_id?.trim().toUpperCase();
            const refundId = wanted === undefined || wanted === '' ? refs[0] : refs.find((r) => r.toUpperCase() === wanted);
            if (!refundId) return wanted ? TOOLKIT_REFUSED : { ok: false as const, reason: 'no_refund' as const };
            if (options?.abortSignal?.aborted) return TOOLKIT_UNAVAILABLE;
            // Only server-side values go to the toolkit: it puts ids into the URL path unencoded.
            let lookup = refundLookups.get(refundId);
            if (!lookup) {
              lookup = getRefund({ refund_id: refundId }, options);
              refundLookups.set(refundId, lookup);
            }
            const raw = await untilAborted(lookup, options?.abortSignal);
            if (raw === ABORTED) return TOOLKIT_UNAVAILABLE;
            const refund = parseToolkitResult(raw);
            if (!refund || refund.id !== refundId) return TOOLKIT_UNAVAILABLE;
            return { ok: true as const, source: 'paypal_agent_toolkit' as const, ...summarizeToolkitRefund(refund) };
          } catch (err) {
            console.error('[paypal] paypal_get_refund failed', { message: errorText(err) });
            return TOOLKIT_UNAVAILABLE;
          }
        },
      });
    }
    return out;
  }

  return {
    find_my_payment,
    get_payment_status,
    create_checkout,
    request_refund,
    ...(deps.toolkit ? guardedToolkitTools(deps.toolkit) : {}),
  };
}

const TOOLKIT_NOT_VERIFIED = { ok: false as const, reason: 'not_verified' as const };
/** Same answer whether the id exists for someone else or not at all. */
const TOOLKIT_REFUSED = { ok: false as const, reason: 'not_your_payment' as const };
const TOOLKIT_UNAVAILABLE = { ok: false as const, reason: 'unavailable' as const };

/**
 * How long a find_my_payment verification unlocks the toolkit lookups. Only these two tools check it;
 * the other visitor tools keep their behaviour.
 *
 * Measured from `verified_at`. payment_verifications has no other timestamp, and refreshVerification
 * (and a repeat find_my_payment) rewrites verified_at. A repeat find_my_payment is a fresh proof, so
 * that is fine. refreshVerification rewrites it at most once per verification, when a payment
 * verified before capture is found captured (it returns early once capture_id is set). So the window
 * can stretch by the verify → capture gap. A strict "from the first proof" needs a first_verified_at
 * column.
 */
export const TOOLKIT_VERIFICATION_TTL_MS = 24 * 60 * 60_000;

function isToolkitVerificationExpired(v: VerificationRow, now = Date.now()): boolean {
  const at = Date.parse(v.verified_at);
  // An unreadable timestamp counts as expired: refuse rather than guess.
  return !Number.isFinite(at) || now - at > TOOLKIT_VERIFICATION_TTL_MS;
}

const ABORTED = Symbol('aborted');

/**
 * Waits for `work` or the tool's abort signal, whichever comes first. The toolkit's ai@4 wrapper drops
 * the AI SDK's abortSignal and its axios calls have no timeout, so without this a hung PayPal read
 * would hold the tool past toolMs / totalMs. On abort the request itself is NOT cancelled; the socket
 * stays open until PayPal answers or the function ends. That is harmless for a read, so no global
 * axios timeout is set for it.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Message only, never a stack or the raw DB / PayPal error object. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ToolkitExecute = (input: unknown, options: unknown) => Promise<unknown>;

function toolkitExecute(t: Tool | undefined): ToolkitExecute | null {
  const run = (t as { execute?: ToolkitExecute } | undefined)?.execute;
  return typeof run === 'function' ? run : null;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? v.flatMap((x) => (asObject(x) ? [x as Json] : [])) : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** PayPal's `{ value, currency_code }` as "29.00 USD", or null. */
function money(v: unknown): string | null {
  const m = asObject(v);
  const value = str(m?.value);
  const currency = str(m?.currency_code);
  return value && currency ? `${value} ${currency}` : null;
}

/**
 * The parts of a PayPal order a buyer would see on their own receipt. Left out on purpose: payee
 * (merchant email / id), seller_receivable_breakdown (fees, net), seller_protection, custom_id,
 * payer / payment_source account fields, links.
 */
export function summarizeToolkitOrder(order: Json): Json {
  return {
    order_id: str(order.id),
    status: str(order.status),
    created_at: str(order.create_time),
    updated_at: str(order.update_time),
    purchases: asArray(order.purchase_units).map((pu) => {
      const payments = asObject(pu.payments);
      return {
        description: str(pu.description),
        amount: money(pu.amount),
        items: asArray(pu.items).map((i) => ({ name: str(i.name), quantity: str(i.quantity), unit_amount: money(i.unit_amount) })),
        captures: asArray(payments?.captures).map((c) => ({
          status: str(c.status),
          amount: money(c.amount),
          created_at: str(c.create_time),
          updated_at: str(c.update_time),
        })),
        refunds: asArray(payments?.refunds).map((r) => ({
          status: str(r.status),
          amount: money(r.amount),
          created_at: str(r.create_time),
          updated_at: str(r.update_time),
        })),
      };
    }),
  };
}

/** A PayPal refund without seller_payable_breakdown (fees), payer / merchant ids, invoice or custom ids, links. */
export function summarizeToolkitRefund(refund: Json): Json {
  return {
    refund_id: str(refund.id),
    status: str(refund.status),
    status_reason: str(asObject(refund.status_details)?.reason),
    amount: money(refund.amount),
    created_at: str(refund.create_time),
    updated_at: str(refund.update_time),
  };
}

/**
 * request_refund results that leave a live payment_actions row (executed / pending / unknown). While
 * that row lives, a repeat call answers already_requested, so one problem is filed once. Everything
 * else is left out: calls turned away before any row (not verified, not paid, declined, canceled)
 * and `failed`, whose row frees the slot — the visitor's retry would come back with the same reason
 * and file it a second time.
 */
const REFUND_TAKEN_UP = new Set(['refunded', 'waiting_for_approval', 'processing']);

/**
 * The visitor's reason from this turn's last refund request that the system took up, or null.
 * The widget route runs it through the ordinary feedback classifier (design §7), so a product problem
 * behind a refund ("the receipt showed the wrong currency") joins insights → grouping → fix PR, and
 * "changed my mind" lands in a category that is never grouped. Plain questions never call the tool.
 */
export function refundReasonFromTrace(trace: readonly PaymentToolTrace[]): string | null {
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i];
    if (t.toolName !== 'request_refund' || t.error !== undefined) continue;
    const status = (t.output as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string' || !REFUND_TAKEN_UP.has(status)) continue;
    const reason = (t.input as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  }
  return null;
}

/**
 * What the visitor is told about a payment_actions row. `executing` and `unknown` are "processing":
 * PayPal has not confirmed (or we lost the answer); only `executed` is a refund the visitor can count on.
 */
export function describeActionStatus(
  status: string,
): 'waiting_for_approval' | 'processing' | 'refunded' | 'declined' | 'failed' | 'unknown' {
  switch (status) {
    case 'pending':
      return 'waiting_for_approval';
    case 'executing':
    case 'unknown':
      return 'processing';
    case 'executed':
      return 'refunded';
    case 'rejected':
    case 'expired':
      return 'declined';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

async function resolveProduct(store: PaymentsStore, botId: string, ref: string): Promise<ProductRow | null> {
  const key = ref.trim();
  if (UUID_RE.test(key)) {
    const p = await store.getProduct(botId, key.toLowerCase());
    return p && p.active ? p : null;
  }
  const products = await store.listActiveProducts(botId);
  return products.find((p) => p.sku.toLowerCase() === key.toLowerCase()) ?? null;
}

/**
 * Lines for the system prompt: what the agent may sell, with the ids create_checkout accepts.
 * Prices are display strings from the rows; the model never sends an amount anywhere.
 */
export function formatProductList(products: readonly ProductRow[]): string {
  if (products.length === 0) return '';
  return [
    'Products you can sell (pass product_id to create_checkout):',
    ...products.map((p) => `- ${p.name} (sku ${p.sku}) — ${formatMoney(p.amount_cents, p.currency)} ${p.currency}; product_id ${p.id}`),
  ].join('\n');
}

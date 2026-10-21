// The four tools a website visitor's payment agent gets (design v2 §2). Wrappers only — never the
// PayPal toolkit's own tools. Each one is scoped to (bot, conversation) by the server, so the model
// cannot name another conversation, another bot's order, or an amount the price table does not say.
//
//   find_my_payment(order_id, email)   both must match → recorded as this conversation's verified payment
//   get_payment_status()               the verified payment's current state, re-read from PayPal
//   create_checkout(product_id, qty)   a PayPal order at the product's listed price (stage-2 createCheckout)
//   request_refund(amount?, reason)    guardrail decision → auto refund or approval card (./refund.ts)
//
// No list_* tool: PayPal's transaction search has no payer filter and would show a visitor the
// seller's whole month. The owner's dashboard is where those live.
//
// Tool results are plain data for the model to relay. The sentences the visitor finally reads for a
// money outcome (refunded / waiting / declined) are server-fixed and come with the card in task 5/6.

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { ORDER_ID_RE, readCaptureFacts } from './capture';
import { createCheckout, describeError, MAX_QUANTITY } from './checkout';
import type { PayPalClient } from './client';
import { formatMoney } from './money';
import { isStuckAction, reconcileAction, requestRefund } from './refund';
import { checkoutLine } from './sentences';
import type { OrderStatus, PaymentActionRow, PaymentsStore, ProductRow, VerificationRow } from './store';

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
}

/** One answer for "wrong id", "wrong email" and "someone else's order": no hint which part failed. */
const NOT_FOUND = { found: false as const, reason: 'no_match' as const };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the visitor is told about an order row's state. */
export function describeOrderStatus(status: OrderStatus): 'paid' | 'processing' | 'not_paid' | 'expired' | 'failed' {
  if (status === 'captured') return 'paid';
  if (status === 'approved') return 'processing';
  if (status === 'created') return 'not_paid';
  return status;
}

/** What the visitor is told about a capture's state, from PayPal's own status. */
export function describeCaptureStatus(status: string): 'paid' | 'processing' | 'refunded' | 'partially_refunded' | 'failed' | 'unknown' {
  switch (status) {
    case 'COMPLETED':
      return 'paid';
    case 'PENDING':
      return 'processing';
    case 'REFUNDED':
      return 'refunded';
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
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
        paid_at: capturedAt,
        refundable: status === 'paid',
      };
    },
  });

  const get_payment_status = tool({
    description:
      "Current state of this conversation's verified payment (paid / processing / refunded / failed) and of any refund request on it. Call find_my_payment first if nothing is verified yet.",
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

      let paymentStatus: ReturnType<typeof describeCaptureStatus> = 'unknown';
      try {
        paymentStatus = describeCaptureStatus((await paypal.getCapture(v.capture_id, { signal: abortSignal })).status);
      } catch (err) {
        console.error('[paypal] get_payment_status: getCapture failed', { captureId: v.capture_id, ...describeError(err) });
      }
      const action = await freshenAction(await store.latestRefundAction(botId, v.capture_id), abortSignal);
      return {
        ...base,
        payment_status: paymentStatus,
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
      "Ask for a refund of this conversation's verified payment. Only works after find_my_payment succeeded and the payment is paid. The system decides: it refunds automatically within the store's limits, otherwise the owner reviews it. The visitor is shown the result as a card automatically; add one short sentence and do not promise anything the result does not say.",
    inputSchema: z.object({
      amount: z
        .number()
        .positive()
        .optional()
        .describe('Amount to refund in the payment currency (e.g. 9.5). Omit for the whole payment.'),
      reason: z.string().min(1).max(300).describe("The visitor's reason, in their words"),
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
    if (row && row.bot_id === botId && row.status === 'captured' && row.capture_id) {
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

  return { find_my_payment, get_payment_status, create_checkout, request_refund };
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

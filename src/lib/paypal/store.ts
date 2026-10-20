// The database side of checkout, capture and webhooks, behind one narrow interface.
//
// Why an interface: checkout/capture/webhook logic is where money rules live, and its tests
// must run without Supabase. The routes pass `supabasePaymentsStore()`; tests pass an
// in-memory store. Every method throws on a database error — callers decide the HTTP status.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/supabase';

export type OrderStatus = 'created' | 'approved' | 'captured' | 'expired' | 'failed';

export interface ProductRow {
  id: string;
  bot_id: string;
  sku: string;
  name: string;
  description: string | null;
  amount_cents: number;
  currency: string;
  active: boolean;
  sort_order: number;
}

export interface OrderRow {
  order_id: string;
  bot_id: string;
  conversation_id: string | null;
  product_id: string | null;
  quantity: number;
  amount_cents: number;
  currency: string;
  status: OrderStatus;
  capture_id: string | null;
  payer_email: string | null;
  payer_id: string | null;
  approve_url: string | null;
  created_at: string;
  captured_at: string | null;
}

export type NewOrderRow = Pick<
  OrderRow,
  'order_id' | 'bot_id' | 'conversation_id' | 'product_id' | 'quantity' | 'amount_cents' | 'currency' | 'approve_url'
> & { status: 'created' };

export type OrderPatch = Partial<
  Pick<OrderRow, 'status' | 'capture_id' | 'payer_email' | 'payer_id' | 'captured_at'>
>;

export interface NewWebhookEvent {
  event_id: string;
  bot_id: string;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  payload: unknown;
}

/** `inserted` = first delivery. `duplicate` carries whether the earlier delivery finished. */
export type WebhookInsertResult = { inserted: true } | { inserted: false; processed: boolean };

/** A payment this conversation proved it owns (find_my_payment matched order id AND payer email). */
export interface VerificationRow {
  conversation_id: string;
  bot_id: string;
  order_id: string;
  capture_id: string | null;
  /** Lower-cased. The guardrail's per-customer key. */
  payer_email: string;
  amount_cents: number;
  currency: string;
  captured_at: string | null;
  verified_at: string;
}

export type NewVerificationRow = Omit<VerificationRow, 'verified_at'>;

/**
 * `unknown` = PayPal was asked and the answer was lost (timeout, abort, network, 5xx, or our settle
 * write failed). Still LIVE: blocks a second action for the capture and counts toward the caps; a
 * retry reuses the row id as PayPal-Request-Id. See 20261020_01.
 */
export type PaymentActionStatus = 'pending' | 'executing' | 'unknown' | 'executed' | 'failed' | 'rejected' | 'expired';

/** One row of payment_actions — every move of money, auto or approved. */
export interface PaymentActionRow {
  id: string;
  bot_id: string;
  conversation_id: string | null;
  kind: 'refund' | 'accept_dispute';
  target_id: string;
  amount_cents: number | null;
  currency: string | null;
  customer_key: string | null;
  origin: 'auto' | 'approval';
  status: PaymentActionStatus;
  reason: string | null;
  guardrail: Record<string, boolean> | null;
  paypal_ref: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Inputs to the guardrail RPC `payment_action_open_refund`. Every value here is something the
 * SERVER read from PayPal or from our own rows — never model output. See 20261019_01.
 */
export interface OpenRefundInput {
  botId: string;
  conversationId: string | null;
  captureId: string;
  amountCents: number;
  currency: string;
  capturedAt: string | null;
  captureHasRefund: boolean;
  /** null = unknown (the disputes read failed); the RPC treats unknown as "has one" and waits for approval. */
  hasDispute: boolean | null;
  customerKey: string | null;
  reason: string;
}

/** What the RPC returns: the decision and the write-ahead row, in one statement. */
export interface OpenRefundResult {
  created: boolean;
  auto: boolean;
  action: PaymentActionRow;
  checks?: Record<string, boolean>;
}

export interface PaymentsStore {
  /** Active products of a bot in display order — the price table the agent may sell from. */
  listActiveProducts(botId: string): Promise<ProductRow[]>;
  getProduct(botId: string, productId: string): Promise<ProductRow | null>;
  /**
   * Unpaid (`created`) orders this bot opened since `sinceIso` — the per-bot checkout cap. Paid,
   * canceled and older orders drop out, so a burst of abandoned checkouts clears itself quickly.
   */
  countOpenOrdersSince(botId: string, sinceIso: string): Promise<number>;
  insertOrder(row: NewOrderRow): Promise<void>;
  getOrder(orderId: string): Promise<OrderRow | null>;
  /**
   * Applies `patch` only while the row is in one of `fromStatuses`. Returns the updated row, or
   * null when no row matched (wrong bot, or another request already moved it). This conditional
   * write is what makes "captured" happen exactly once when the return URL and a webhook race.
   */
  updateOrder(
    orderId: string,
    botId: string,
    fromStatuses: readonly OrderStatus[],
    patch: OrderPatch,
  ): Promise<OrderRow | null>;
  insertWebhookEvent(row: NewWebhookEvent): Promise<WebhookInsertResult>;
  finishWebhookEvent(eventId: string, error: string | null): Promise<void>;
  /** One `response_type='payment'` line in the conversation. Body is server-fixed text. */
  insertPaymentResponse(input: { botId: string; conversationId: string; body: string }): Promise<void>;

  // ── stage 3: verified payments and refunds ──
  /** Records (or refreshes) a successful find_my_payment match. */
  upsertVerification(row: NewVerificationRow): Promise<void>;
  /** The payment this conversation verified most recently, or null. */
  latestVerification(conversationId: string): Promise<VerificationRow | null>;
  /** Guardrail decision + write-ahead row in one RPC. Throws on a database error. */
  openRefund(input: OpenRefundInput): Promise<OpenRefundResult>;
  /**
   * Moves an `executing` row to executed / failed / unknown after the PayPal call. Returns false when
   * the row was not in `executing` (someone else settled it) — the caller logs, never retries PayPal.
   * `failed` is only for a definite "no" from PayPal (4xx) or a cancellation BEFORE the call was sent.
   */
  settleAction(
    actionId: string,
    outcome:
      | { status: 'executed'; paypalRef: string; payload: unknown; result: unknown }
      | { status: 'failed'; error: string; paypalRef?: string | null; payload: unknown; result?: unknown }
      /** `paypalRef` = the refund id when PayPal answered PENDING: reconciliation GETs it later. */
      | { status: 'unknown'; error: string | null; paypalRef?: string | null; payload: unknown; result?: unknown },
  ): Promise<boolean>;
  /** The most recent refund action for a capture, any status, or null. */
  latestRefundAction(botId: string, captureId: string): Promise<PaymentActionRow | null>;
}

const ORDER_COLUMNS =
  'order_id, bot_id, conversation_id, product_id, quantity, amount_cents, currency, status, capture_id, payer_email, payer_id, approve_url, created_at, captured_at';

const PRODUCT_COLUMNS = 'id, bot_id, sku, name, description, amount_cents, currency, active, sort_order';

const VERIFICATION_COLUMNS =
  'conversation_id, bot_id, order_id, capture_id, payer_email, amount_cents, currency, captured_at, verified_at';

const ACTION_COLUMNS =
  'id, bot_id, conversation_id, kind, target_id, amount_cents, currency, customer_key, origin, status, reason, guardrail, paypal_ref, error, created_at';

function fail(what: string, error: { message: string; code?: string }): never {
  throw new Error(`[paypal-store] ${what}: ${error.code ?? ''} ${error.message}`.trim());
}

export function supabasePaymentsStore(db: SupabaseClient = getServiceRoleClient()): PaymentsStore {
  return {
    async listActiveProducts(botId) {
      const { data, error } = await db
        .from('products')
        .select(PRODUCT_COLUMNS)
        .eq('bot_id', botId)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (error) fail('listActiveProducts', error);
      return (data as ProductRow[] | null) ?? [];
    },

    async getProduct(botId, productId) {
      const { data, error } = await db
        .from('products')
        .select(PRODUCT_COLUMNS)
        .eq('bot_id', botId)
        .eq('id', productId)
        .maybeSingle();
      if (error) fail('getProduct', error);
      return (data as ProductRow | null) ?? null;
    },

    async countOpenOrdersSince(botId, sinceIso) {
      const { count, error } = await db
        .from('paypal_orders')
        .select('order_id', { count: 'exact', head: true })
        .eq('bot_id', botId)
        .eq('status', 'created')
        .gte('created_at', sinceIso);
      if (error) fail('countOpenOrdersSince', error);
      return count ?? 0;
    },

    async insertOrder(row) {
      const { error } = await db.from('paypal_orders').insert(row);
      if (error) fail('insertOrder', error);
    },

    async getOrder(orderId) {
      const { data, error } = await db
        .from('paypal_orders')
        .select(ORDER_COLUMNS)
        .eq('order_id', orderId)
        .maybeSingle();
      if (error) fail('getOrder', error);
      return (data as OrderRow | null) ?? null;
    },

    async updateOrder(orderId, botId, fromStatuses, patch) {
      const { data, error } = await db
        .from('paypal_orders')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('order_id', orderId)
        .eq('bot_id', botId)
        .in('status', [...fromStatuses])
        .select(ORDER_COLUMNS)
        .maybeSingle();
      if (error) fail('updateOrder', error);
      return (data as OrderRow | null) ?? null;
    },

    async insertWebhookEvent(row) {
      const { error } = await db.from('paypal_webhook_events').insert(row);
      if (!error) return { inserted: true };
      if (error.code !== '23505') fail('insertWebhookEvent', error);
      const { data, error: readErr } = await db
        .from('paypal_webhook_events')
        .select('processed_at')
        .eq('event_id', row.event_id)
        .maybeSingle();
      if (readErr) fail('insertWebhookEvent(read)', readErr);
      return { inserted: false, processed: Boolean(data?.processed_at) };
    },

    async finishWebhookEvent(eventId, err) {
      const patch = err === null ? { processed_at: new Date().toISOString(), error: null } : { error: err };
      const { error } = await db.from('paypal_webhook_events').update(patch).eq('event_id', eventId);
      if (error) fail('finishWebhookEvent', error);
    },

    async insertPaymentResponse({ botId, conversationId, body }) {
      const { error } = await db.from('responses').insert({
        bot_id: botId,
        conversation_id: conversationId,
        response_type: 'payment',
        response_body: body,
        delivered_at: new Date().toISOString(),
      });
      if (error) fail('insertPaymentResponse', error);
    },

    async upsertVerification(row) {
      const { error } = await db
        .from('payment_verifications')
        .upsert({ ...row, verified_at: new Date().toISOString() }, { onConflict: 'conversation_id,order_id' });
      if (error) fail('upsertVerification', error);
    },

    async latestVerification(conversationId) {
      const { data, error } = await db
        .from('payment_verifications')
        .select(VERIFICATION_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('verified_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail('latestVerification', error);
      return (data as VerificationRow | null) ?? null;
    },

    async openRefund(input) {
      const { data, error } = await db.rpc('payment_action_open_refund', {
        p_bot_id: input.botId,
        p_conversation_id: input.conversationId,
        p_capture_id: input.captureId,
        p_amount_cents: input.amountCents,
        p_currency: input.currency,
        p_captured_at: input.capturedAt,
        p_capture_has_refund: input.captureHasRefund,
        p_has_dispute: input.hasDispute,
        p_customer_key: input.customerKey,
        p_reason: input.reason,
      });
      if (error) fail('openRefund', error);
      const r = data as Partial<OpenRefundResult> | null;
      if (!r || typeof r.created !== 'boolean' || typeof r.auto !== 'boolean' || !r.action) {
        throw new Error('[paypal-store] openRefund: RPC returned an unexpected shape');
      }
      return r as OpenRefundResult;
    },

    async settleAction(actionId, outcome) {
      const patch =
        outcome.status === 'executed'
          ? {
              status: 'executed',
              paypal_ref: outcome.paypalRef,
              payload: outcome.payload,
              result: outcome.result,
              error: null,
              executed_at: new Date().toISOString(),
            }
          : {
              status: outcome.status,
              error: outcome.error,
              payload: outcome.payload,
              result: outcome.result ?? null,
              ...(outcome.paypalRef ? { paypal_ref: outcome.paypalRef } : {}),
            };
      const { data, error } = await db
        .from('payment_actions')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', actionId)
        .eq('status', 'executing')
        .select('id')
        .maybeSingle();
      if (error) fail('settleAction', error);
      return data !== null;
    },

    async latestRefundAction(botId, captureId) {
      const { data, error } = await db
        .from('payment_actions')
        .select(ACTION_COLUMNS)
        .eq('bot_id', botId)
        .eq('kind', 'refund')
        .eq('target_id', captureId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail('latestRefundAction', error);
      return (data as PaymentActionRow | null) ?? null;
    },
  };
}

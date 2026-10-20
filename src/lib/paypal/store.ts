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

export interface PaymentsStore {
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
}

const ORDER_COLUMNS =
  'order_id, bot_id, conversation_id, product_id, quantity, amount_cents, currency, status, capture_id, payer_email, payer_id, approve_url, created_at, captured_at';

const PRODUCT_COLUMNS = 'id, bot_id, sku, name, description, amount_cents, currency, active, sort_order';

function fail(what: string, error: { message: string; code?: string }): never {
  throw new Error(`[paypal-store] ${what}: ${error.code ?? ''} ${error.message}`.trim());
}

export function supabasePaymentsStore(db: SupabaseClient = getServiceRoleClient()): PaymentsStore {
  return {
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
  };
}

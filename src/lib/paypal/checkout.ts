// createCheckout — one PayPal order for (product, quantity), shared by the /pricing page and
// (stage 3) the agent's `create_checkout` tool.
//
// Rules this file holds:
//  - The amount comes from the `products` row. Callers (and the LLM) only pick product + quantity.
//  - return_url / cancel_url are built here from the server origin. Nothing from the request
//    reaches them, so a visitor cannot send a buyer back to someone else's site.
//  - The approve URL we hand out must be https on paypal.com — checked here, not in the UI.
//  - PayPal-Request-Id is a fresh uuid per call, so a retried POST cannot open two orders.

import { randomUUID } from 'node:crypto';
import { PayPalApiError, type PayPalClient } from './client';
import { centsToValue, isPayPalUrl } from './money';
import type { PaymentsStore, ProductRow } from './store';

export const MAX_QUANTITY = 10;

// PayPal's zero-decimal currencies. Our rows store cents, which would be wrong for these.
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

export interface CheckoutInput {
  botId: string;
  productId: string;
  quantity: number;
  conversationId?: string | null;
}

export interface CheckoutDeps {
  store: PaymentsStore;
  paypal: PayPalClient;
  /** Server origin, e.g. https://feedloop-demo.vercel.app. See `appOrigin()`. */
  origin: string;
  newRequestId?: () => string;
}

export type CheckoutError =
  | 'bad_quantity'
  | 'product_not_found'
  | 'product_inactive'
  | 'unsupported_currency'
  | 'paypal_failed'
  | 'bad_approve_url'
  | 'store_failed';

export type CheckoutResult =
  | {
      ok: true;
      orderId: string;
      approveUrl: string;
      amountCents: number;
      currency: string;
      product: Pick<ProductRow, 'id' | 'sku' | 'name'>;
      quantity: number;
    }
  | { ok: false; error: CheckoutError };

export function checkoutUrls(origin: string, botId: string): { returnUrl: string; cancelUrl: string } {
  const base = origin.replace(/\/+$/, '');
  const id = encodeURIComponent(botId);
  return {
    returnUrl: `${base}/api/paypal/return/${id}`,
    cancelUrl: `${base}/api/paypal/cancel/${id}`,
  };
}

/**
 * The server's own origin for return/cancel URLs: WEBHOOK_BASE_URL (the public origin widget
 * snippets and emails already use), else NEXTAUTH_URL. Never the request's Host header.
 */
export function appOrigin(): string {
  const raw = process.env.WEBHOOK_BASE_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (!raw) throw new Error('WEBHOOK_BASE_URL or NEXTAUTH_URL must be set (needed for PayPal return URLs)');
  return new URL(raw).origin;
}

export async function createCheckout(deps: CheckoutDeps, input: CheckoutInput): Promise<CheckoutResult> {
  const { quantity } = input;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return { ok: false, error: 'bad_quantity' };
  }

  const product = await deps.store.getProduct(input.botId, input.productId);
  if (!product) return { ok: false, error: 'product_not_found' };
  if (!product.active) return { ok: false, error: 'product_inactive' };

  const currency = product.currency.toUpperCase();
  if (ZERO_DECIMAL.has(currency)) return { ok: false, error: 'unsupported_currency' };

  const amountCents = product.amount_cents * quantity;
  const { returnUrl, cancelUrl } = checkoutUrls(deps.origin, input.botId);

  let order: { id: string; approveUrl: string | null };
  try {
    order = await deps.paypal.createOrder({
      amountValue: centsToValue(amountCents),
      currencyCode: currency,
      description: quantity > 1 ? `${product.name} × ${quantity}` : product.name,
      customId: product.sku,
      returnUrl,
      cancelUrl,
      // English for judges (design v2 §10); every product here is digital, so no address step.
      locale: 'en-US',
      shippingPreference: 'NO_SHIPPING',
      requestId: (deps.newRequestId ?? randomUUID)(),
    });
  } catch (err) {
    console.error('[paypal] createOrder failed', describeError(err));
    return { ok: false, error: 'paypal_failed' };
  }

  if (!isPayPalUrl(order.approveUrl)) {
    console.error('[paypal] createOrder returned no usable approve link', { orderId: order.id });
    return { ok: false, error: 'bad_approve_url' };
  }

  try {
    await deps.store.insertOrder({
      order_id: order.id,
      bot_id: input.botId,
      conversation_id: input.conversationId ?? null,
      product_id: product.id,
      quantity,
      amount_cents: amountCents,
      currency,
      status: 'created',
      approve_url: order.approveUrl,
    });
  } catch (err) {
    // The PayPal order exists but we have no row. That is safe: the return route only captures
    // orders it knows, so this one can never be charged. The buyer just sees an error and retries.
    console.error('[paypal] insertOrder failed', { orderId: order.id, message: (err as Error).message });
    return { ok: false, error: 'store_failed' };
  }

  return {
    ok: true,
    orderId: order.id,
    approveUrl: order.approveUrl,
    amountCents,
    currency,
    product: { id: product.id, sku: product.sku, name: product.name },
    quantity,
  };
}

/** Log-safe summary: PayPal's status/name/debug id, never request headers. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof PayPalApiError) {
    return { status: err.status, name: err.paypalName, message: err.message, debugId: err.debugId };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

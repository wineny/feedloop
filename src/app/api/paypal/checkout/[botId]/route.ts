// POST /api/paypal/checkout/[botId] — opens a PayPal order for one product of this bot.
// Public (the /pricing page calls it without login), so three limits:
//  - the widget's IP limit (60 requests/min, in memory),
//  - 10 checkouts per IP per 10 minutes (in memory) — one script cannot fill the bot's cap alone,
//  - per bot, at most 100 unpaid orders opened in the last 10 minutes (counted in the database).
//    Paid and canceled orders do not count, and abandoned ones age out after 10 minutes.
// Body: { product_id, quantity? }.
// Answers { order_id, approve_url }; the page then sends the buyer to approve_url.

import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJson } from '@/lib/http/body';
import { checkReadRate, clientIp, isUuid } from '@/lib/widget/http';
import { resolvePayPalBot } from '@/lib/paypal/bot';
import { appOrigin, createCheckout, type CheckoutError } from '@/lib/paypal/checkout';
import { supabasePaymentsStore } from '@/lib/paypal/store';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;
const WINDOW_MS = 10 * 60_000;
/** Unpaid orders a bot may have opened within WINDOW_MS. Each one is a PayPal API call on our credentials. */
const BOT_OPEN_ORDER_LIMIT = 100;
const IP_CHECKOUT_LIMIT = 10;
const ipCheckouts = new Map<string, number[]>();

function ipCheckoutExceeded(req: NextRequest): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (ipCheckouts.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
  hits.push(now);
  ipCheckouts.set(ip, hits);
  if (ipCheckouts.size > 5000) ipCheckouts.clear();
  return hits.length > IP_CHECKOUT_LIMIT;
}

const ERROR_STATUS: Record<CheckoutError, number> = {
  bad_quantity: 400,
  product_not_found: 404,
  product_inactive: 409,
  unsupported_currency: 500,
  paypal_failed: 502,
  bad_approve_url: 502,
  store_failed: 500,
  // Only the agent passes a cancellation signal; this page never does, so this is unreachable here.
  canceled: 400,
};

const ERROR_TEXT: Record<CheckoutError, string> = {
  bad_quantity: 'Quantity must be a whole number from 1 to 10.',
  product_not_found: 'That product does not exist.',
  product_inactive: 'That product is no longer for sale.',
  unsupported_currency: 'This product is priced in a currency we cannot charge yet.',
  paypal_failed: 'PayPal did not accept the order. Please try again.',
  bad_approve_url: 'PayPal did not return a checkout link. Please try again.',
  store_failed: 'We could not save your order. Please try again.',
  canceled: 'The checkout was cancelled before PayPal was contacted.',
};

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  if (!isUuid(botId)) return error('Unknown bot.', 404);

  if (checkReadRate(req) || ipCheckoutExceeded(req)) return error('Too many requests. Please wait a moment.', 429);

  const body = await readBoundedJson<{ product_id?: unknown; quantity?: unknown }>(req, MAX_BODY_BYTES);
  if (!body.ok) return error(body.reason === 'too_large' ? 'Request too large.' : 'Invalid request.', body.status);
  const productId = body.value?.product_id;
  const quantity = body.value?.quantity ?? 1;
  if (!isUuid(productId)) return error('product_id is required.', 400);
  if (typeof quantity !== 'number') return error(ERROR_TEXT.bad_quantity, 400);

  const resolved = await resolvePayPalBot(botId);
  if (!resolved.ok) {
    return resolved.reason === 'not_found'
      ? error('Unknown bot.', 404)
      : error('This shop has not connected PayPal yet.', 409);
  }

  const store = supabasePaymentsStore();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  if ((await store.countOpenOrdersSince(botId, since)) >= BOT_OPEN_ORDER_LIMIT) {
    return error('Checkout is busy right now. Please try again later.', 429);
  }

  const result = await createCheckout(
    { store, paypal: resolved.bot.client, origin: appOrigin() },
    { botId, productId, quantity },
  );
  if (!result.ok) return error(ERROR_TEXT[result.error], ERROR_STATUS[result.error]);

  return NextResponse.json({
    order_id: result.orderId,
    approve_url: result.approveUrl,
    amount_cents: result.amountCents,
    currency: result.currency,
  });
}

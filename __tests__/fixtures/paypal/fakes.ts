// Test doubles for the PayPal checkout/capture/webhook tests:
//  - memoryStore(): PaymentsStore over plain arrays, with the same conditional-update semantics.
//  - fakePayPal(): a PayPalClient whose fetch is a tiny in-memory PayPal (orders, captures, idempotency).
//  - signer(): a test RSA key that signs webhook transmissions the way PayPal does.

import { createSign, generateKeyPairSync } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { PayPalClient } from '@/lib/paypal/client';
import type {
  NewOrderRow,
  OrderRow,
  PaymentsStore,
  ProductRow,
  WebhookInsertResult,
} from '@/lib/paypal/store';

export const BOT = '11111111-1111-4111-8111-111111111111';
export const OTHER_BOT = '22222222-2222-4222-8222-222222222222';
export const PRO = '33333333-3333-4333-8333-333333333333';
export const RETIRED = '44444444-4444-4444-8444-444444444444';
export const OTHER_BOT_PRODUCT = '55555555-5555-4555-8555-555555555555';
export const CONVERSATION = '66666666-6666-4666-8666-666666666666';

export function products(): ProductRow[] {
  return [
    { id: PRO, bot_id: BOT, sku: 'pro', name: 'Pro', description: null, amount_cents: 2900, currency: 'USD', active: true, sort_order: 2 },
    { id: RETIRED, bot_id: BOT, sku: 'old', name: 'Old', description: null, amount_cents: 500, currency: 'USD', active: false, sort_order: 9 },
    { id: OTHER_BOT_PRODUCT, bot_id: OTHER_BOT, sku: 'pro', name: 'Pro', description: null, amount_cents: 100, currency: 'USD', active: true, sort_order: 1 },
  ];
}

export interface MemoryStore extends PaymentsStore {
  orders: OrderRow[];
  events: { event_id: string; event_type: string; processed_at: string | null; error: string | null }[];
  responses: { botId: string; conversationId: string; body: string }[];
}

export function memoryStore(initial: { products?: ProductRow[]; orders?: OrderRow[] } = {}): MemoryStore {
  const productRows = initial.products ?? products();
  const store: MemoryStore = {
    orders: [...(initial.orders ?? [])],
    events: [],
    responses: [],
    async getProduct(botId, productId) {
      return productRows.find((p) => p.bot_id === botId && p.id === productId) ?? null;
    },
    async countOpenOrdersSince(botId) {
      return store.orders.filter((o) => o.bot_id === botId && o.status === 'created').length;
    },
    async insertOrder(row: NewOrderRow) {
      if (store.orders.some((o) => o.order_id === row.order_id)) throw new Error('duplicate order');
      store.orders.push({
        ...row,
        capture_id: null,
        payer_email: null,
        payer_id: null,
        created_at: new Date().toISOString(),
        captured_at: null,
      });
    },
    async getOrder(orderId) {
      const o = store.orders.find((r) => r.order_id === orderId);
      return o ? { ...o } : null;
    },
    async updateOrder(orderId, botId, fromStatuses, patch) {
      const o = store.orders.find((r) => r.order_id === orderId && r.bot_id === botId && fromStatuses.includes(r.status));
      if (!o) return null;
      Object.assign(o, patch);
      return { ...o };
    },
    async insertWebhookEvent(row): Promise<WebhookInsertResult> {
      const seen = store.events.find((e) => e.event_id === row.event_id);
      if (seen) return { inserted: false, processed: seen.processed_at !== null };
      store.events.push({ event_id: row.event_id, event_type: row.event_type, processed_at: null, error: null });
      return { inserted: true };
    },
    async finishWebhookEvent(eventId, error) {
      const e = store.events.find((r) => r.event_id === eventId);
      if (!e) return;
      if (error === null) {
        e.processed_at = new Date().toISOString();
        e.error = null;
      } else {
        e.error = error;
      }
    },
    async insertPaymentResponse(input) {
      store.responses.push(input);
    },
  };
  return store;
}

export function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    order_id: 'ORDER0000001',
    bot_id: BOT,
    conversation_id: null,
    product_id: PRO,
    quantity: 1,
    amount_cents: 2900,
    currency: 'USD',
    status: 'created',
    capture_id: null,
    payer_email: null,
    payer_id: null,
    approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER0000001',
    created_at: '2026-10-19T00:00:00.000Z',
    captured_at: null,
    ...overrides,
  };
}

// ── fake PayPal ──────────────────────────────────────────────────────────────

interface FakeOrder {
  id: string;
  value: string;
  currency: string;
  approved: boolean;
  captureId: string | null;
  captureStatus: string;
  captureRequestId: string | null;
}

type Call = { method: string; path: string; requestId: string | null; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function unprocessable(issue: string) {
  return json({ name: 'UNPROCESSABLE_ENTITY', message: issue, details: [{ issue }] }, 422);
}

export function fakePayPal(opts: { approveHost?: string; failCreate?: boolean } = {}) {
  const flags = { captureThenFail: false, nextCaptureStatus: 'COMPLETED' };
  const orders = new Map<string, FakeOrder>();
  const calls: Call[] = [];
  let seq = 0;

  const orderBody = (o: FakeOrder) => ({
    id: o.id,
    status: o.captureId ? 'COMPLETED' : o.approved ? 'APPROVED' : 'CREATED',
    payer: o.approved ? { email_address: 'buyer@example.com', payer_id: 'PAYER123' } : undefined,
    purchase_units: [
      {
        payments: o.captureId
          ? { captures: [{ id: o.captureId, status: o.captureStatus, amount: { value: o.value, currency_code: o.currency } }] }
          : undefined,
      },
    ],
  });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
    if (url.pathname === '/v1/oauth2/token') return json({ access_token: 't', expires_in: 3600, scope: '' });
    calls.push({ method, path: url.pathname, requestId: headers['PayPal-Request-Id'] ?? null, body });

    let m: RegExpMatchArray | null;
    if (method === 'POST' && url.pathname === '/v2/checkout/orders') {
      if (opts.failCreate) return json({ name: 'INTERNAL_SERVER_ERROR', message: 'boom' }, 500);
      const id = `FAKEORDER${String(++seq).padStart(4, '0')}`;
      const amount = body.purchase_units[0].amount;
      orders.set(id, {
        id,
        value: amount.value,
        currency: amount.currency_code,
        approved: false,
        captureId: null,
        captureStatus: 'COMPLETED',
        captureRequestId: null,
      });
      const host = opts.approveHost ?? 'www.sandbox.paypal.com';
      return json({ id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://${host}/checkoutnow?token=${id}` }] }, 201);
    }
    if ((m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/)) && method === 'POST') {
      const o = orders.get(m[1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no order' }, 404);
      if (!o.approved) return unprocessable('ORDER_NOT_APPROVED');
      if (o.captureId) {
        // PayPal answers a repeated Request-Id from its cache; a new one gets ORDER_ALREADY_CAPTURED.
        return o.captureRequestId === headers['PayPal-Request-Id'] ? json(orderBody(o), 201) : unprocessable('ORDER_ALREADY_CAPTURED');
      }
      o.captureId = `CAP${o.id}`;
      o.captureStatus = flags.nextCaptureStatus;
      o.captureRequestId = headers['PayPal-Request-Id'] ?? null;
      if (flags.captureThenFail) {
        // PayPal captured, but this caller only sees an error (e.g. a racing duplicate request).
        flags.captureThenFail = false;
        return json({ name: 'INTERNAL_SERVER_ERROR', message: 'try again' }, 500);
      }
      return json(orderBody(o), 201);
    }
    if ((m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === 'GET') {
      const o = orders.get(m[1]);
      return o ? json(orderBody(o)) : json({ name: 'RESOURCE_NOT_FOUND', message: 'no order' }, 404);
    }
    if ((m = url.pathname.match(/^\/v2\/payments\/captures\/([^/]+)$/)) && method === 'GET') {
      const o = [...orders.values()].find((x) => x.captureId === m![1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no capture' }, 404);
      return json({ id: o.captureId, status: o.captureStatus, supplementary_data: { related_ids: { order_id: o.id } } });
    }
    return json({ name: 'NOT_FOUND', message: `${method} ${url.pathname}` }, 404);
  };

  const client = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', fetch: fetchImpl as typeof fetch });

  return {
    client,
    calls,
    orders,
    /** Seeds an order PayPal knows about (as if created earlier). */
    addOrder(id: string, value = '29.00', currency = 'USD') {
      orders.set(id, { id, value, currency, approved: false, captureId: null, captureStatus: 'COMPLETED', captureRequestId: null });
    },
    /** The buyer approved on paypal.com. */
    approve(id: string) {
      const o = orders.get(id);
      if (o) o.approved = true;
    },
    captureCalls: () => calls.filter((c) => c.path.endsWith('/capture')),
    /** The next capture succeeds at PayPal but answers this caller with a 500. */
    captureThenFail() {
      flags.captureThenFail = true;
    },
    /** Status of the next capture (e.g. PENDING for a held payment). */
    nextCaptureStatus(status: string) {
      flags.nextCaptureStatus = status;
    },
    /** PayPal changes an existing capture's status (e.g. PENDING → DENIED). */
    setCaptureStatus(orderId: string, status: string) {
      const o = orders.get(orderId);
      if (o) o.captureStatus = status;
    },
  };
}

// ── webhook signing ──────────────────────────────────────────────────────────

export const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test-0001';

export function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicPem,
    /** Headers PayPal would send for `raw`, signed for `webhookId`. */
    headers(raw: string | Buffer, webhookId: string, overrides: Record<string, string> = {}) {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      const transmissionId = 'b2c4e8f0-1343-11ef-ac58-e32457403f67';
      const transmissionTime = '2026-10-19T05:19:23Z';
      const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(bytes) >>> 0}`;
      const sig = createSign('SHA256').update(message).sign(privateKey).toString('base64');
      return {
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': transmissionTime,
        'paypal-transmission-sig': sig,
        'paypal-cert-url': CERT_URL,
        'paypal-auth-algo': 'SHA256withRSA',
        ...overrides,
      };
    },
  };
}

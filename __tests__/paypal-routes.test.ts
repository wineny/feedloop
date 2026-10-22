import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BOT, CERT_URL, PRO, fakePayPal, memoryStore, orderRow, signer, type MemoryStore } from './fixtures/paypal/fakes';

// Routes under src/app/api/paypal/** with the database and PayPal replaced:
// resolvePayPalBot → a bot whose client is the in-memory fake PayPal; supabasePaymentsStore → memory store.

const WEBHOOK_ID = '1JJ51368KS439463F';
const ORDER = 'ORDER0000001';

const state = vi.hoisted(() => ({
  store: null as unknown as MemoryStore,
  pp: null as unknown as ReturnType<typeof import('./fixtures/paypal/fakes').fakePayPal>,
  webhookId: '1JJ51368KS439463F' as string | null,
}));

vi.mock('@/lib/paypal/bot', () => ({
  resolvePayPalBot: vi.fn(async (botId: string) =>
    botId === '11111111-1111-4111-8111-111111111111'
      ? { ok: true, bot: { id: botId, isDemo: true, sandbox: true, webhookId: state.webhookId, client: state.pp.client } }
      : { ok: false, reason: 'not_found' },
  ),
}));
// Keep the module's constants and helpers (capture.ts / webhook.ts use them); only the store is replaced.
vi.mock('@/lib/paypal/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/paypal/store')>();
  return { ...actual, supabasePaymentsStore: () => state.store };
});

const key = signer();

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubEnv('WEBHOOK_BASE_URL', 'https://shop.test');
  state.store = memoryStore({ orders: [orderRow({ order_id: ORDER })] });
  state.pp = fakePayPal();
  state.pp.addOrder(ORDER, '29.00');
  state.webhookId = WEBHOOK_ID;
  // The cert download is the only global fetch the webhook route makes.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (String(url) === CERT_URL ? new Response(key.publicPem) : new Response('nope', { status: 404 }))),
  );
});

const ctx = (botId = BOT) => ({ params: Promise.resolve({ botId }) });

function approvedEvent(id = 'WH-APPROVED-1', orderId = ORDER) {
  return JSON.stringify({ id, event_type: 'CHECKOUT.ORDER.APPROVED', resource_type: 'checkout-order', resource: { id: orderId } });
}

function webhookReq(raw: string, headers: Record<string, string> = key.headers(raw, WEBHOOK_ID)) {
  return new NextRequest(`https://shop.test/api/paypal/webhook/${BOT}`, { method: 'POST', headers, body: raw });
}

describe('POST /api/paypal/webhook/[botId]', () => {
  const route = () => import('@/app/api/paypal/webhook/[botId]/route');

  it('wrong signature → 401 and nothing is stored', async () => {
    const raw = approvedEvent();
    const headers = key.headers(raw, 'SOME-OTHER-WEBHOOK');
    const res = await (await route()).POST(webhookReq(raw, headers), ctx());
    expect(res.status).toBe(401);
    expect(state.store.events).toHaveLength(0);
    expect(state.pp.calls).toHaveLength(0);
  });

  it('missing signature headers → 401', async () => {
    const res = await (await route()).POST(webhookReq(approvedEvent(), {}), ctx());
    expect(res.status).toBe(401);
  });

  it('body over 2 MB → 413 before anything else', async () => {
    const res = await (await route()).POST(
      new NextRequest(`https://shop.test/api/paypal/webhook/${BOT}`, {
        method: 'POST',
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        body: '{}',
      }),
      ctx(),
    );
    expect(res.status).toBe(413);
  });

  it('bot without a webhook id → 503', async () => {
    state.webhookId = null;
    const res = await (await route()).POST(webhookReq(approvedEvent()), ctx());
    expect(res.status).toBe(503);
  });

  it('APPROVED → captured once; the same event again is ignored', async () => {
    state.pp.approve(ORDER);
    const r = await route();
    const first = await r.POST(webhookReq(approvedEvent()), ctx());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, outcome: { kind: 'captured' } });

    const again = await r.POST(webhookReq(approvedEvent()), ctx());
    expect(await again.json()).toEqual({ ok: true, duplicate: true });

    expect(state.pp.captureCalls()).toHaveLength(1);
    expect(state.store.orders[0].status).toBe('captured');
    expect(state.store.events).toEqual([expect.objectContaining({ event_id: 'WH-APPROVED-1', processed_at: expect.any(String) })]);
  });

  it('signed PAYMENT.CAPTURE.REFUNDED from a dashboard refund → order refunded once; the redelivery is a duplicate', async () => {
    const captureId = state.pp.seedCaptured(ORDER, '29.00');
    Object.assign(state.store.orders[0], { status: 'captured', capture_id: captureId });
    const refundId = state.pp.sellerRefund(ORDER, '29.00');
    const raw = JSON.stringify({
      id: 'WH-REFUNDED-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource_type: 'refund',
      resource: {
        id: refundId,
        status: 'COMPLETED',
        amount: { value: '1.00', currency_code: 'USD' },
        links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, method: 'GET' }],
      },
    });
    const r = await route();
    const first = await r.POST(webhookReq(raw), ctx());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, outcome: { kind: 'order_updated', status: 'refunded', refundedCents: 2900 } });
    const again = await r.POST(webhookReq(raw), ctx());
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(state.store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900 });
  });

  it('a delivery that failed half-way is processed again on retry', async () => {
    state.pp.approve(ORDER);
    const r = await route();
    const realGetOrder = state.store.getOrder;
    state.store.getOrder = async () => {
      throw new Error('db down');
    };
    expect((await r.POST(webhookReq(approvedEvent()), ctx())).status).toBe(500);
    expect(state.store.events[0]).toMatchObject({ processed_at: null, error: expect.any(String) });

    state.store.getOrder = realGetOrder;
    const retry = await r.POST(webhookReq(approvedEvent()), ctx());
    expect(await retry.json()).toMatchObject({ outcome: { kind: 'captured' } });
    expect(state.pp.captureCalls()).toHaveLength(1);
  });
});

describe('GET /api/paypal/return/[botId]', () => {
  const route = () => import('@/app/api/paypal/return/[botId]/route');
  const req = (token: string) => new NextRequest(`https://shop.test/api/paypal/return/${BOT}?token=${token}&PayerID=PAYER123`);

  it('captures and redirects to the receipt; refreshing does not capture twice', async () => {
    state.pp.approve(ORDER);
    const r = await route();
    const res = await r.GET(req(ORDER), ctx());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://shop.test/pricing/receipt/${ORDER}`);
    const again = await r.GET(req(ORDER), ctx());
    expect(again.status).toBe(303);
    expect(state.pp.captureCalls()).toHaveLength(1);
    expect(state.store.orders[0].status).toBe('captured');
  });

  it('unknown order → 404 and no PayPal call', async () => {
    const res = await (await route()).GET(req('UNKNOWN00001'), ctx());
    expect(res.status).toBe(404);
    expect(state.pp.calls).toHaveLength(0);
  });

  it('malformed token or bot → 404', async () => {
    const r = await route();
    expect((await r.GET(req('../../etc'), ctx())).status).toBe(404);
    expect((await r.GET(req(ORDER), ctx('not-a-uuid'))).status).toBe(404);
  });
});

describe('GET /api/paypal/cancel/[botId]', () => {
  it('marks the order expired and goes back to /pricing', async () => {
    const { GET } = await import('@/app/api/paypal/cancel/[botId]/route');
    const res = await GET(new NextRequest(`https://shop.test/api/paypal/cancel/${BOT}?token=${ORDER}`), ctx());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://shop.test/pricing?canceled=1');
    expect(state.store.orders[0].status).toBe('expired');
  });
});

describe('POST /api/paypal/checkout/[botId]', () => {
  const route = () => import('@/app/api/paypal/checkout/[botId]/route');
  const req = (body: unknown) =>
    new NextRequest(`https://shop.test/api/paypal/checkout/${BOT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns the PayPal approve URL for a valid product', async () => {
    const res = await (await route()).POST(req({ product_id: PRO }), ctx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ amount_cents: 2900, currency: 'USD' });
    expect(data.approve_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it('400 without a product id, 400 for quantity 0, 404 for an unknown bot', async () => {
    const r = await route();
    expect((await r.POST(req({}), ctx())).status).toBe(400);
    expect((await r.POST(req({ product_id: PRO, quantity: 0 }), ctx())).status).toBe(400);
    expect((await r.POST(req({ product_id: PRO }), ctx('99999999-9999-4999-8999-999999999999'))).status).toBe(404);
    expect(state.pp.calls).toHaveLength(0);
  });

  it('one IP gets at most 10 checkouts per 10 minutes', async () => {
    const r = await route();
    const fromIp = () =>
      new NextRequest(`https://shop.test/api/paypal/checkout/${BOT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.9' },
        body: JSON.stringify({ product_id: PRO }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await r.POST(fromIp(), ctx())).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('ignores a client-sent amount', async () => {
    await (await route()).POST(req({ product_id: PRO, amount: 1, amount_cents: 1 }), ctx());
    const create = state.pp.calls.find((c) => c.path === '/v2/checkout/orders')!;
    expect((create.body as { purchase_units: { amount: { value: string } }[] }).purchase_units[0].amount.value).toBe('29.00');
  });
});

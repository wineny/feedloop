import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  handleWebhookEvent,
  isAllowedCertUrl,
  parseWebhookEvent,
  readTransmissionHeaders,
  signedMessage,
  verifyTransmission,
  webhookIdsFor,
  SIMULATOR_WEBHOOK_ID,
  type TransmissionHeaders,
} from '@/lib/paypal/webhook';
import { ORDER_SYNC_AFTER_REFUND_MS, requestRefund } from '@/lib/paypal/refund';
import { BOT, BUYER_EMAIL, CERT_URL, CONVERSATION, OTHER_BOT, fakePayPal, memoryStore, orderRow, signer } from './fixtures/paypal/fakes';

const WEBHOOK_ID = '1JJ51368KS439463F';
const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures/paypal', `${name}.json`), 'utf8')) as Record<string, unknown>;

const key = signer();
const loadCert = vi.fn(async () => key.publicPem);

function transmission(raw: string, webhookId = WEBHOOK_ID, overrides: Record<string, string> = {}): TransmissionHeaders {
  return readTransmissionHeaders(new Headers(key.headers(raw, webhookId, overrides)))!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  loadCert.mockClear();
});

describe('signature', () => {
  const raw = JSON.stringify(fixture('checkout-order-approved'));

  it('signs transmissionId|time|webhookId|crc32 (decimal, unsigned)', () => {
    const h = transmission('hello');
    // zlib crc32("hello") = 0x3610a686
    expect(signedMessage(h, 'W', Buffer.from('hello'))).toBe(`${h.transmissionId}|${h.transmissionTime}|W|907060870`);
  });

  it('accepts a correctly signed body', async () => {
    expect(await verifyTransmission({ headers: transmission(raw), raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], loadCert })).toBe(true);
  });

  it('rejects a changed body, a different webhook id, and a bad algorithm', async () => {
    const h = transmission(raw);
    expect(await verifyTransmission({ headers: h, raw: Buffer.from(raw + ' '), webhookIds: [WEBHOOK_ID], loadCert })).toBe(false);
    expect(await verifyTransmission({ headers: h, raw: Buffer.from(raw), webhookIds: ['OTHERWEBHOOK'], loadCert })).toBe(false);
    expect(
      await verifyTransmission({ headers: { ...h, authAlgo: 'SHA1withRSA' }, raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], loadCert }),
    ).toBe(false);
  });

  it('rejects a signature made with another key', async () => {
    const other = signer();
    const h = readTransmissionHeaders(new Headers(other.headers(raw, WEBHOOK_ID)))!;
    expect(await verifyTransmission({ headers: h, raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], loadCert })).toBe(false);
  });

  it('never downloads a cert from outside PayPal', async () => {
    for (const certUrl of [
      'http://api.sandbox.paypal.com/v1/notifications/certs/X',
      'https://evil.test/v1/notifications/certs/X',
      'https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/X',
      'https://api.sandbox.paypal.com:8443/v1/notifications/certs/X',
      'https://api.sandbox.paypal.com/v2/other',
    ]) {
      expect(isAllowedCertUrl(certUrl)).toBe(false);
      const h = transmission(raw, WEBHOOK_ID, { 'paypal-cert-url': certUrl });
      expect(await verifyTransmission({ headers: h, raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], loadCert })).toBe(false);
    }
    expect(loadCert).not.toHaveBeenCalled();
    expect(isAllowedCertUrl(CERT_URL)).toBe(true);
    expect(isAllowedCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d')).toBe(true);
    expect(isAllowedCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-1/../x')).toBe(false);
    expect(isAllowedCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-1?x=1')).toBe(false);
  });

  it('pins the cert host to the bot\'s environment', async () => {
    expect(isAllowedCertUrl(CERT_URL, { sandbox: true })).toBe(true);
    expect(isAllowedCertUrl(CERT_URL, { sandbox: false })).toBe(false);
    expect(await verifyTransmission({ headers: transmission(raw), raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], sandbox: false, loadCert })).toBe(false);
    expect(await verifyTransmission({ headers: transmission(raw), raw: Buffer.from(raw), webhookIds: [WEBHOOK_ID], sandbox: true, loadCert })).toBe(true);
  });

  it('missing headers → null', () => {
    expect(readTransmissionHeaders(new Headers({ 'paypal-transmission-id': 'x' }))).toBeNull();
  });

  it('simulator events (webhook id "WEBHOOK_ID") only when opted in, and only in sandbox', () => {
    expect(webhookIdsFor(WEBHOOK_ID, { sandbox: true })).toEqual([WEBHOOK_ID]);
    vi.stubEnv('PAYPAL_WEBHOOK_ALLOW_SIMULATOR', '1');
    expect(webhookIdsFor(WEBHOOK_ID, { sandbox: true })).toEqual([WEBHOOK_ID, SIMULATOR_WEBHOOK_ID]);
    expect(webhookIdsFor(WEBHOOK_ID, { sandbox: false })).toEqual([WEBHOOK_ID]);
  });

  it('parses the saved simulator payloads', () => {
    for (const name of ['checkout-order-approved', 'payment-capture-completed']) {
      const e = parseWebhookEvent(Buffer.from(JSON.stringify(fixture(name))));
      expect(e?.id).toMatch(/^WH-/);
    }
    expect(parseWebhookEvent(Buffer.from('{"id":1}'))).toBeNull();
    expect(parseWebhookEvent(Buffer.from('not json'))).toBeNull();
  });
});

describe('handleWebhookEvent', () => {
  const ORDER = 'ORDER0000001';

  function setup() {
    const store = memoryStore({ orders: [orderRow({ order_id: ORDER })] });
    const pp = fakePayPal();
    pp.addOrder(ORDER, '29.00');
    return { store, pp, deps: { store, paypal: pp.client } };
  }

  function approvedEvent(orderId: string) {
    const e = fixture('checkout-order-approved') as { resource: { id: string } };
    e.resource.id = orderId;
    return parseWebhookEvent(Buffer.from(JSON.stringify(e)))!;
  }

  it('CHECKOUT.ORDER.APPROVED captures once, however often it arrives', async () => {
    const { store, pp, deps } = setup();
    pp.approve(ORDER);
    expect(await handleWebhookEvent(deps, BOT, approvedEvent(ORDER))).toEqual({ kind: 'captured' });
    expect(await handleWebhookEvent(deps, BOT, approvedEvent(ORDER))).toEqual({ kind: 'already_captured' });
    expect(pp.captureCalls()).toHaveLength(1);
    expect(store.orders[0].status).toBe('captured');
  });

  it('CHECKOUT.ORDER.APPROVED for an order we never created is ignored (no PayPal call)', async () => {
    const { pp, deps } = setup();
    expect(await handleWebhookEvent(deps, BOT, approvedEvent('5O190127TN364715T'))).toEqual({ kind: 'ignored', reason: 'unknown order' });
    expect(pp.calls).toHaveLength(0);
  });

  it('PAYMENT.CAPTURE.COMPLETED re-reads the capture and order from PayPal before writing', async () => {
    const { store, pp, deps } = setup();
    pp.approve(ORDER);
    await pp.client.captureOrder(ORDER, ORDER); // captured at PayPal, our row still says created
    const e = fixture('payment-capture-completed') as { resource: { id: string; amount: { value: string } } };
    e.resource.id = `CAP${ORDER}`;
    e.resource.amount.value = '0.01'; // body amounts are never trusted
    const out = await handleWebhookEvent(deps, BOT, parseWebhookEvent(Buffer.from(JSON.stringify(e)))!);
    expect(out).toEqual({ kind: 'captured' });
    expect(pp.calls.some((c) => c.method === 'GET' && c.path === `/v2/payments/captures/CAP${ORDER}`)).toBe(true);
    expect(store.orders[0]).toMatchObject({ status: 'captured', capture_id: `CAP${ORDER}`, amount_cents: 2900 });
  });

  it('PAYMENT.CAPTURE.COMPLETED for a capture PayPal does not know (404) is ignored, not retried', async () => {
    const { deps } = setup();
    const e = parseWebhookEvent(Buffer.from(JSON.stringify(fixture('payment-capture-completed'))))!;
    expect(await handleWebhookEvent(deps, BOT, e)).toEqual({ kind: 'ignored', reason: 'unknown capture' });
  });

  it('PAYMENT.CAPTURE.DENIED moves a held order to failed after re-reading the capture', async () => {
    const { store, pp, deps } = setup();
    pp.approve(ORDER);
    pp.nextCaptureStatus('PENDING');
    await handleWebhookEvent(deps, BOT, approvedEvent(ORDER));
    expect(store.orders[0].status).toBe('approved');

    const denied = { id: 'WH-DENIED-1', event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: `CAP${ORDER}` } };
    // PayPal has not denied it yet → body is not trusted, nothing changes.
    expect(await handleWebhookEvent(deps, BOT, denied)).toEqual({ kind: 'ignored', reason: 'capture PENDING' });
    pp.setCaptureStatus(ORDER, 'DECLINED');
    expect(await handleWebhookEvent(deps, BOT, denied)).toEqual({ kind: 'failed' });
    expect(store.orders[0].status).toBe('failed');
  });

  it('a refund event without a usable capture link, and disputes, are recorded only', async () => {
    const { pp, deps } = setup();
    for (const event_type of ['PAYMENT.CAPTURE.REFUNDED', 'CUSTOMER.DISPUTE.CREATED']) {
      expect(await handleWebhookEvent(deps, BOT, { id: 'WH-1', event_type, resource: { id: 'X' } })).toEqual({ kind: 'recorded' });
    }
    expect(pp.calls).toHaveLength(0);
  });
});

describe('refunds and reversals → paypal_orders (stage 4)', () => {
  const ORDER = 'ORDER0000001';
  const CAP = `CAP${ORDER}`;

  function setup(order: Parameters<typeof orderRow>[0] = {}) {
    const store = memoryStore({
      orders: [orderRow({ order_id: ORDER, status: 'captured', capture_id: CAP, payer_email: BUYER_EMAIL, captured_at: '2026-10-18T10:00:00Z', ...order })],
    });
    const pp = fakePayPal();
    pp.seedCaptured(ORDER, '29.00', 'USD', { captureTime: '2026-10-18T10:00:00Z' });
    return { store, pp, deps: { store, paypal: pp.client } };
  }

  /** PAYMENT.CAPTURE.REFUNDED / REVERSED as PayPal sends it: the resource is the refund, the capture its `up` link. */
  function refundEvent(id: string, refundId: string, opts: { type?: string; captureId?: string; host?: string } = {}) {
    const host = opts.host ?? 'api.sandbox.paypal.com';
    return {
      id,
      event_type: opts.type ?? 'PAYMENT.CAPTURE.REFUNDED',
      resource_type: 'refund',
      resource: {
        id: refundId,
        // body amounts and statuses are never trusted
        status: 'COMPLETED',
        amount: { value: '0.01', currency_code: 'USD' },
        seller_payable_breakdown: { total_refunded_amount: { value: '0.01', currency_code: 'USD' } },
        links: [
          { rel: 'self', href: `https://${host}/v2/payments/refunds/${refundId}`, method: 'GET' },
          { rel: 'up', href: `https://${host}/v2/payments/captures/${opts.captureId ?? CAP}`, method: 'GET' },
        ],
      },
    };
  }

  it('the seller refunds everything in the PayPal dashboard → refunded, total from the capture re-read', async () => {
    const { store, pp, deps } = setup();
    const refundId = pp.sellerRefund(ORDER, '29.00');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-RF-1', refundId))).toEqual({
      kind: 'order_updated',
      status: 'refunded',
      refundedCents: 2900,
    });
    expect(store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900, refunded_at: expect.any(String) });
    expect(pp.calls.some((c) => c.method === 'GET' && c.path === `/v2/payments/captures/${CAP}`)).toBe(true);
  });

  it('partial refunds → partially_refunded with PayPal\'s running total, then refunded', async () => {
    const { store, pp, deps } = setup();
    const first = pp.sellerRefund(ORDER, '5.00');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-P-1', first))).toEqual({
      kind: 'order_updated',
      status: 'partially_refunded',
      refundedCents: 500,
    });
    // the total comes from the refund re-read (seller_payable_breakdown.total_refunded_amount), not the body
    expect(pp.refundReads().map((c) => c.path)).toEqual([`/v2/payments/refunds/${first}`]);

    const second = pp.sellerRefund(ORDER, '7.50');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-P-2', second))).toEqual({
      kind: 'order_updated',
      status: 'partially_refunded',
      refundedCents: 1250,
    });
    const rest = pp.sellerRefund(ORDER, '16.50');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-P-3', rest))).toMatchObject({ status: 'refunded', refundedCents: 2900 });
    expect(store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900 });
  });

  it('the same event twice changes the order once', async () => {
    const { store, pp, deps } = setup();
    const refundId = pp.sellerRefund(ORDER, '10.00');
    const event = refundEvent('WH-DUP', refundId);
    expect(await handleWebhookEvent(deps, BOT, event)).toMatchObject({ kind: 'order_updated', status: 'partially_refunded' });
    const after = { ...store.orders[0] };
    expect(await handleWebhookEvent(deps, BOT, event)).toEqual({ kind: 'order_unchanged', status: 'partially_refunded' });
    expect(store.orders[0]).toEqual(after);
  });

  it('out of order: an older partial refund arriving last never lowers the total', async () => {
    const { store, pp, deps } = setup();
    const older = pp.sellerRefund(ORDER, '5.00');
    const newer = pp.sellerRefund(ORDER, '7.50');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-N', newer))).toMatchObject({ refundedCents: 1250 });
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-O', older))).toEqual({ kind: 'order_unchanged', status: 'partially_refunded' });
    expect(store.orders[0]).toMatchObject({ status: 'partially_refunded', refunded_cents: 1250 });
  });

  it('a late PAYMENT.CAPTURE.COMPLETED or CHECKOUT.ORDER.APPROVED does not undo refunded', async () => {
    const { store, pp, deps } = setup();
    await handleWebhookEvent(deps, BOT, refundEvent('WH-RF', pp.sellerRefund(ORDER, '29.00')));
    expect(store.orders[0].status).toBe('refunded');

    const completed = fixture('payment-capture-completed') as { resource: { id: string } };
    completed.resource.id = CAP;
    expect(await handleWebhookEvent(deps, BOT, parseWebhookEvent(Buffer.from(JSON.stringify(completed)))!)).toEqual({ kind: 'already_captured' });
    const approved = fixture('checkout-order-approved') as { resource: { id: string } };
    approved.resource.id = ORDER;
    expect(await handleWebhookEvent(deps, BOT, parseWebhookEvent(Buffer.from(JSON.stringify(approved)))!)).toEqual({ kind: 'already_captured' });
    expect(pp.captureCalls()).toHaveLength(0);
    expect(store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900 });
  });

  it('PAYMENT.CAPTURE.REVERSED → reversed, and reversed is terminal', async () => {
    const { store, pp, deps } = setup();
    const reversalId = pp.sellerRefund(ORDER, '29.00'); // PayPal takes the money back off the capture
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-REV', reversalId, { type: 'PAYMENT.CAPTURE.REVERSED' }))).toEqual({
      kind: 'order_updated',
      status: 'reversed',
      refundedCents: 2900,
    });
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-RF-LATE', reversalId))).toEqual({ kind: 'order_unchanged', status: 'reversed' });
    expect(store.orders[0].status).toBe('reversed');
  });

  it('a reversal of part of the capture → partially_refunded (not terminal), total from the re-read', async () => {
    const { store, pp, deps } = setup();
    const reversalId = pp.sellerRefund(ORDER, '10.00');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-REV-P', reversalId, { type: 'PAYMENT.CAPTURE.REVERSED' }))).toEqual({
      kind: 'order_updated',
      status: 'partially_refunded',
      refundedCents: 1000,
    });
    // a later refund of the rest can still move it on
    const rest = pp.sellerRefund(ORDER, '19.00');
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-RF-REST', rest))).toMatchObject({ status: 'refunded', refundedCents: 2900 });
    expect(store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900 });
  });

  it('a reversal whose refund id PayPal does not know (404): full → capture amount; partial → known total kept', async () => {
    const full = setup();
    full.pp.sellerRefund(ORDER, '29.00');
    expect(await handleWebhookEvent(full.deps, BOT, refundEvent('WH-REV-404', 'REF-missing', { type: 'PAYMENT.CAPTURE.REVERSED' }))).toEqual({
      kind: 'order_updated',
      status: 'reversed',
      refundedCents: 2900,
    });

    const part = setup({ status: 'partially_refunded', refunded_cents: 500 });
    part.pp.sellerRefund(ORDER, '5.00');
    expect(await handleWebhookEvent(part.deps, BOT, refundEvent('WH-REV-404P', 'REF-missing', { type: 'PAYMENT.CAPTURE.REVERSED' }))).toEqual({
      kind: 'order_unchanged',
      status: 'partially_refunded',
    });
    expect(part.store.orders[0].refunded_cents).toBe(500);
  });

  it('a reversal event for a capture PayPal still reports COMPLETED changes nothing', async () => {
    const { store, deps } = setup();
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-REV-X', 'REF-forged', { type: 'PAYMENT.CAPTURE.REVERSED' }))).toEqual({
      kind: 'recorded',
    });
    expect(store.orders[0]).toMatchObject({ status: 'captured', refunded_cents: 0 });
  });

  it('our own refund (refund.ts) moves the order too; its webhook then finds nothing new', async () => {
    const { store, pp, deps } = setup();
    const base = { botId: BOT, conversationId: CONVERSATION, captureId: CAP, reason: 'double charged', customerKey: BUYER_EMAIL };
    const out = await requestRefund(deps, { ...base, amountCents: 1000 });
    expect(out.status).toBe('executed');
    expect(store.orders[0]).toMatchObject({ status: 'partially_refunded', refunded_cents: 1000 });

    const refundId = pp.refunds[0].id;
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-OURS', refundId))).toEqual({ kind: 'order_unchanged', status: 'partially_refunded' });
    expect(pp.refundCalls()).toHaveLength(1);
  });

  it('our full refund → refunded', async () => {
    const { store, deps } = setup();
    const out = await requestRefund(deps, { botId: BOT, conversationId: CONVERSATION, captureId: CAP, reason: 'x', customerKey: BUYER_EMAIL });
    expect(out.status).toBe('executed');
    expect(store.orders[0]).toMatchObject({ status: 'refunded', refunded_cents: 2900 });
  });

  it('a hanging order sync does not hold our refund answer beyond the bound', async () => {
    const { store, deps } = setup();
    store.getOrderByCapture = () => new Promise(() => {}); // never answers
    const started = Date.now();
    const out = await requestRefund(deps, { botId: BOT, conversationId: CONVERSATION, captureId: CAP, reason: 'x', customerKey: BUYER_EMAIL });
    const elapsed = Date.now() - started;
    expect(out.status).toBe('executed');
    expect(store.actions[0].status).toBe('executed');
    expect(elapsed).toBeGreaterThanOrEqual(ORDER_SYNC_AFTER_REFUND_MS - 100);
    expect(elapsed).toBeLessThan(ORDER_SYNC_AFTER_REFUND_MS + 1_500);
    expect(store.orders[0].status).toBe('captured'); // the webhook finishes it
  });

  it('the caller\'s cancellation also ends the order sync early, result unchanged', async () => {
    const { store, deps } = setup();
    const ac = new AbortController();
    store.getOrderByCapture = () => {
      ac.abort(); // the tool's budget runs out right after the money moved
      return new Promise(() => {});
    };
    const started = Date.now();
    const out = await requestRefund(deps, { botId: BOT, conversationId: CONVERSATION, captureId: CAP, reason: 'x', customerKey: BUYER_EMAIL, signal: ac.signal });
    expect(out.status).toBe('executed');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a failed order sync never turns our completed refund into an error', async () => {
    const { store, deps } = setup();
    store.getOrderByCapture = async () => {
      throw new Error('db down');
    };
    const out = await requestRefund(deps, { botId: BOT, conversationId: CONVERSATION, captureId: CAP, reason: 'x', customerKey: BUYER_EMAIL });
    expect(out.status).toBe('executed');
    expect(store.actions[0].status).toBe('executed');
    expect(store.orders[0].status).toBe('captured');
  });

  it('another bot\'s order, an unknown capture or a forged link: recorded, no PayPal call', async () => {
    const { store, pp, deps } = setup({ bot_id: OTHER_BOT });
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-OB', 'REF-1'))).toEqual({ kind: 'recorded' });
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-UK', 'REF-1', { captureId: 'CAP-unknown' }))).toEqual({ kind: 'recorded' });
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-EV', 'REF-1', { host: 'evil.example.com' }))).toEqual({ kind: 'recorded' });
    expect(pp.calls).toHaveLength(0);
    expect(store.orders[0].status).toBe('captured');
  });

  it('PayPal unreachable while syncing → throws, so the route answers 500 and PayPal retries', async () => {
    const { pp, deps } = setup();
    const refundId = pp.sellerRefund(ORDER, '29.00');
    pp.failCaptureRead();
    await expect(handleWebhookEvent(deps, BOT, refundEvent('WH-DOWN', refundId))).rejects.toThrow();
    pp.failCaptureRead(false);
    expect(await handleWebhookEvent(deps, BOT, refundEvent('WH-DOWN', refundId))).toMatchObject({ kind: 'order_updated', status: 'refunded' });
  });
});

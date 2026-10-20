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
import { BOT, CERT_URL, fakePayPal, memoryStore, orderRow, signer } from './fixtures/paypal/fakes';

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

  it('refunds and disputes are recorded only (stage 4)', async () => {
    const { pp, deps } = setup();
    for (const event_type of ['PAYMENT.CAPTURE.REFUNDED', 'CUSTOMER.DISPUTE.CREATED']) {
      expect(await handleWebhookEvent(deps, BOT, { id: 'WH-1', event_type, resource: { id: 'X' } })).toEqual({ kind: 'recorded' });
    }
    expect(pp.calls).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { cancelCheckout, captureCheckout, paymentLine } from '@/lib/paypal/capture';
import { BOT, CONVERSATION, OTHER_BOT, fakePayPal, memoryStore, orderRow } from './fixtures/paypal/fakes';

const ID = 'ORDER0000001';

function setup(row = orderRow()) {
  const store = memoryStore({ orders: [row] });
  const pp = fakePayPal();
  pp.addOrder(row.order_id, '29.00');
  const deps = { store, paypal: pp.client, now: () => new Date('2026-10-19T01:02:03.000Z') };
  return { store, pp, deps };
}

describe('captureCheckout', () => {
  it('refuses an order we did not create, without calling PayPal', async () => {
    const { pp, deps } = setup();
    expect(await captureCheckout(deps, { botId: BOT, orderId: 'NOTOURS00001' })).toEqual({ ok: false, error: 'not_found' });
    expect(await captureCheckout(deps, { botId: OTHER_BOT, orderId: ID })).toEqual({ ok: false, error: 'not_found' });
    expect(pp.calls).toHaveLength(0);
  });

  it('captures an approved order with Request-Id = order id and records the payer', async () => {
    const { pp, deps, store } = setup();
    pp.approve(ID);
    const r = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(pp.captureCalls()).toHaveLength(1);
    expect(pp.captureCalls()[0].requestId).toBe(ID);
    expect(store.orders[0]).toMatchObject({
      status: 'captured',
      capture_id: `CAP${ID}`,
      payer_email: 'buyer@example.com',
      payer_id: 'PAYER123',
      captured_at: '2026-10-19T01:02:03.000Z',
    });
  });

  it('is safe to repeat: an already captured row does not call PayPal again', async () => {
    const { pp, deps } = setup();
    pp.approve(ID);
    await captureCheckout(deps, { botId: BOT, orderId: ID });
    const again = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(pp.captureCalls()).toHaveLength(1);
  });

  it('two racing captures move the row once and write the chat line once', async () => {
    const { pp, deps, store } = setup(orderRow({ conversation_id: CONVERSATION }));
    pp.approve(ID);
    const [a, b] = await Promise.all([
      captureCheckout(deps, { botId: BOT, orderId: ID }),
      captureCheckout(deps, { botId: BOT, orderId: ID }),
    ]);
    expect([a, b].filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect([a, b].every((r) => r.ok && r.order.status === 'captured')).toBe(true);
    expect(store.responses).toEqual([{ botId: BOT, conversationId: CONVERSATION, body: paymentLine(store.orders[0]) }]);
  });

  it('treats ORDER_ALREADY_CAPTURED as "read the order and record it"', async () => {
    const { pp, deps, store } = setup();
    pp.approve(ID);
    // Someone captured it at PayPal under another request id (e.g. an earlier deployment).
    await pp.client.captureOrder(ID, 'other-request');
    const r = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(store.orders[0].status).toBe('captured');
    expect(pp.calls.some((c) => c.method === 'GET' && c.path.endsWith(`/orders/${ID}`))).toBe(true);
  });

  it('if PayPal errors but the capture went through, reads the order and records it', async () => {
    const { pp, deps, store } = setup();
    pp.approve(ID);
    pp.captureThenFail();
    const r = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(store.orders[0].status).toBe('captured');
  });

  it('a held (PENDING) capture leaves the row approved with its capture id', async () => {
    const { pp, deps, store } = setup();
    pp.approve(ID);
    pp.nextCaptureStatus('PENDING');
    const r = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(r).toMatchObject({ ok: true });
    expect(store.orders[0]).toMatchObject({ status: 'approved', capture_id: `CAP${ID}` });
  });

  it('leaves an unapproved order alone', async () => {
    const { deps, store } = setup();
    const r = await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(r).toMatchObject({ ok: false, error: 'not_approved' });
    expect(store.orders[0].status).toBe('created');
  });

  it('writes no chat line for a /pricing purchase (no conversation)', async () => {
    const { pp, deps, store } = setup();
    pp.approve(ID);
    await captureCheckout(deps, { botId: BOT, orderId: ID });
    expect(store.responses).toHaveLength(0);
  });

  it('the chat line is server text with the amount from our row', () => {
    expect(paymentLine(orderRow({ amount_cents: 2900, currency: 'USD' }))).toBe(
      `Payment received: $29 (PayPal order ${ID}). Thank you!`,
    );
  });
});

describe('cancelCheckout', () => {
  it('expires an untouched order', async () => {
    const { store } = setup();
    expect(await cancelCheckout(store, { botId: BOT, orderId: ID })).toMatchObject({ status: 'expired' });
  });
  it('never touches a captured order', async () => {
    const { store } = setup(orderRow({ status: 'captured', capture_id: 'C1' }));
    expect(await cancelCheckout(store, { botId: BOT, orderId: ID })).toBeNull();
    expect(store.orders[0].status).toBe('captured');
  });
});

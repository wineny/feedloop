import { describe, expect, it } from 'vitest';
import { checkoutUrls, createCheckout } from '@/lib/paypal/checkout';
import { centsToValue, formatMoney, isPayPalUrl } from '@/lib/paypal/money';
import { BOT, CONVERSATION, OTHER_BOT_PRODUCT, PRO, RETIRED, fakePayPal, memoryStore } from './fixtures/paypal/fakes';

const ORIGIN = 'https://shop.test';

function setup(opts: Parameters<typeof fakePayPal>[0] = {}) {
  const store = memoryStore();
  const pp = fakePayPal(opts);
  const deps = { store, paypal: pp.client, origin: ORIGIN, newRequestId: () => 'req-fixed' };
  return { store, pp, deps };
}

describe('money helpers', () => {
  it('turns cents into PayPal values with integer math', () => {
    expect(centsToValue(900)).toBe('9.00');
    expect(centsToValue(2950)).toBe('29.50');
    expect(centsToValue(7)).toBe('0.07');
    expect(centsToValue(23700)).toBe('237.00');
  });
  it('formats display prices', () => {
    expect(formatMoney(900, 'USD')).toBe('$9');
    expect(formatMoney(2950, 'USD')).toBe('$29.50');
  });
  it('accepts only https paypal.com approve links', () => {
    expect(isPayPalUrl('https://www.sandbox.paypal.com/checkoutnow?token=X')).toBe(true);
    expect(isPayPalUrl('https://www.paypal.com/checkoutnow?token=X')).toBe(true);
    expect(isPayPalUrl('http://www.paypal.com/checkoutnow')).toBe(false);
    expect(isPayPalUrl('https://paypal.com.evil.test/x')).toBe(false);
    expect(isPayPalUrl('https://evilpaypal.com/x')).toBe(false);
    expect(isPayPalUrl('javascript:alert(1)')).toBe(false);
    expect(isPayPalUrl(null)).toBe(false);
  });
});

describe('createCheckout', () => {
  it('rejects quantity 0, fractions and more than 10 without calling PayPal', async () => {
    const { pp, deps, store } = setup();
    for (const quantity of [0, -1, 1.5, 11, Number.NaN]) {
      const r = await createCheckout(deps, { botId: BOT, productId: PRO, quantity });
      expect(r).toEqual({ ok: false, error: 'bad_quantity' });
    }
    expect(pp.calls).toHaveLength(0);
    expect(store.orders).toHaveLength(0);
  });

  it('rejects an unknown product and another bot\'s product', async () => {
    const { pp, deps } = setup();
    expect(await createCheckout(deps, { botId: BOT, productId: '99999999-9999-4999-8999-999999999999', quantity: 1 })).toEqual({
      ok: false,
      error: 'product_not_found',
    });
    expect(await createCheckout(deps, { botId: BOT, productId: OTHER_BOT_PRODUCT, quantity: 1 })).toEqual({
      ok: false,
      error: 'product_not_found',
    });
    expect(pp.calls).toHaveLength(0);
  });

  it('rejects an inactive product', async () => {
    const { pp, deps } = setup();
    expect(await createCheckout(deps, { botId: BOT, productId: RETIRED, quantity: 1 })).toEqual({
      ok: false,
      error: 'product_inactive',
    });
    expect(pp.calls).toHaveLength(0);
  });

  it('charges the DB price × quantity, with server-fixed return URLs and a request id', async () => {
    const { pp, deps, store } = setup();
    const r = await createCheckout(deps, { botId: BOT, productId: PRO, quantity: 2, conversationId: CONVERSATION });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amountCents).toBe(5800);
    expect(r.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    const [create] = pp.calls;
    expect(create.requestId).toBe('req-fixed');
    const body = create.body as {
      intent: string;
      purchase_units: { amount: { value: string; currency_code: string } }[];
      payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string } } };
    };
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0].amount).toEqual({ value: '58.00', currency_code: 'USD' });
    expect(body.payment_source.paypal.experience_context.return_url).toBe(`${ORIGIN}/api/paypal/return/${BOT}`);
    expect(body.payment_source.paypal.experience_context.cancel_url).toBe(`${ORIGIN}/api/paypal/cancel/${BOT}`);
    expect(body.payment_source.paypal.experience_context).toMatchObject({
      brand_name: 'Feedloop',
      locale: 'en-US',
      shipping_preference: 'NO_SHIPPING',
    });

    expect(store.orders).toHaveLength(1);
    expect(store.orders[0]).toMatchObject({
      order_id: r.orderId,
      bot_id: BOT,
      conversation_id: CONVERSATION,
      product_id: PRO,
      quantity: 2,
      amount_cents: 5800,
      currency: 'USD',
      status: 'created',
      approve_url: r.approveUrl,
    });
  });

  it('refuses an approve link that is not on paypal.com and stores nothing', async () => {
    const { deps, store } = setup({ approveHost: 'evil.test' });
    expect(await createCheckout(deps, { botId: BOT, productId: PRO, quantity: 1 })).toEqual({ ok: false, error: 'bad_approve_url' });
    expect(store.orders).toHaveLength(0);
  });

  it('reports a PayPal failure and stores nothing', async () => {
    const { deps, store } = setup({ failCreate: true });
    expect(await createCheckout(deps, { botId: BOT, productId: PRO, quantity: 1 })).toEqual({ ok: false, error: 'paypal_failed' });
    expect(store.orders).toHaveLength(0);
  });

  it('builds return URLs from the origin only', () => {
    expect(checkoutUrls('https://a.test/', BOT)).toEqual({
      returnUrl: `https://a.test/api/paypal/return/${BOT}`,
      cancelUrl: `https://a.test/api/paypal/cancel/${BOT}`,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PayPalApiError, PayPalClient } from '@/lib/paypal/client';

const SECRET = 'super-secret-value';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/v1/oauth2/token')) {
      return json({ access_token: 'tok-1', expires_in: 3600, scope: 'a b c' });
    }
    return handler(url, init);
  });
  const client = new PayPalClient({ clientId: 'cid', clientSecret: SECRET, fetch: f.fetch });
  return { client, calls: f.calls };
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('PayPalClient', () => {
  it('fetches the token once and reuses it, exposing scope', async () => {
    const { client, calls } = makeClient(() => json({ id: 'O1', status: 'CREATED' }));
    await client.getOrder('O1');
    await client.getOrder('O1');
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(1);
    expect((await client.getAccessToken()).scope.split(' ')).toHaveLength(3);
    expect(header(calls[1], 'Authorization')).toBe('Bearer tok-1');
  });

  it('refreshes the token after it expires', async () => {
    let t = 0;
    const f = fakeFetch((url) =>
      url.endsWith('/v1/oauth2/token')
        ? json({ access_token: 'tok', expires_in: 100, scope: '' })
        : json({}),
    );
    const client = new PayPalClient({ clientId: 'c', clientSecret: 's', fetch: f.fetch, now: () => t });
    await client.getAccessToken();
    t = 30_000;
    await client.getAccessToken();
    t = 50_000; // past expires_in minus the 60s skew
    await client.getAccessToken();
    expect(f.calls).toHaveLength(2);
  });

  it('sends PayPal-Request-Id on createOrder, captureOrder and refundCapture', async () => {
    const { client, calls } = makeClient(() => json({ id: 'X', status: 'COMPLETED' }));
    await client.createOrder({
      amountValue: '1.00',
      currencyCode: 'USD',
      returnUrl: 'https://a/r',
      cancelUrl: 'https://a/c',
      requestId: 'req-order',
    });
    await client.captureOrder('O1', 'req-capture');
    await client.refundCapture('C1', { amountValue: '1.00', currencyCode: 'USD', requestId: 'req-refund' });
    const ids = calls.slice(1).map((c) => header(c, 'PayPal-Request-Id'));
    expect(ids.filter(Boolean)).toEqual(['req-order', 'req-capture', 'req-refund']);
  });

  it('always includes an explicit amount in the refund body', async () => {
    const { client, calls } = makeClient(() => json({ id: 'R1', status: 'COMPLETED' }));
    await client.refundCapture('C1', { amountValue: '2.50', currencyCode: 'USD', requestId: 'r' });
    const call = calls[1];
    expect(call.url).toContain('/v2/payments/captures/C1/refund');
    expect(JSON.parse(String(call.init.body)).amount).toEqual({ value: '2.50', currency_code: 'USD' });
  });

  it('turns non-2xx into PayPalApiError without leaking secrets', async () => {
    const { client } = makeClient(() =>
      json({ name: 'UNPROCESSABLE_ENTITY', message: 'Refund not allowed' }, 422, {
        'paypal-debug-id': 'dbg123',
      }),
    );
    const err = await client
      .refundCapture('C1', { amountValue: '1.00', currencyCode: 'USD', requestId: 'r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    const e = err as PayPalApiError;
    expect([e.status, e.paypalName, e.debugId]).toEqual([422, 'UNPROCESSABLE_ENTITY', 'dbg123']);
    const dump = JSON.stringify({ m: e.message, d: e.details, s: e.stack });
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain('tok-1');
  });

  it('extracts approveUrl from approve or payer-action links', async () => {
    for (const rel of ['approve', 'payer-action']) {
      const { client } = makeClient(() =>
        json({
          id: 'O9',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: 'https://x/self' },
            { rel, href: 'https://x/approve' },
          ],
        }),
      );
      const out = await client.createOrder({
        amountValue: '1.00',
        currencyCode: 'USD',
        returnUrl: 'https://a/r',
        cancelUrl: 'https://a/c',
        requestId: 'r',
      });
      expect(out).toEqual({ id: 'O9', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://x/approve' });
    }
  });
});

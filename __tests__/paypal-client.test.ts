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

  it('validates PayPal-Request-Id before any network call', async () => {
    const { client, calls } = makeClient(() => json({ id: 'R1', status: 'COMPLETED' }));
    await expect(
      client.refundCapture('C1', { amountValue: '1.00', currencyCode: 'USD', requestId: '' }),
    ).rejects.toThrow(/PayPal-Request-Id/);
    await expect(
      client.refundCapture('C1', { amountValue: '1.00', currencyCode: 'USD', requestId: 'x'.repeat(109) }),
    ).rejects.toThrow(/PayPal-Request-Id/);
    expect(calls).toHaveLength(0);
  });

  it('puts a timeout signal on every fetch, token included', async () => {
    const { client, calls } = makeClient(() => json({ id: 'O1', status: 'CREATED' }));
    await client.getOrder('O1');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('concurrent first calls share one token request', async () => {
    const { client, calls } = makeClient(() => json({ id: 'O1', status: 'CREATED' }));
    await Promise.all([client.getOrder('O1'), client.getOrder('O1'), client.getOrder('O1')]);
    expect(calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(1);
  });

  it('rejects a token response without access_token instead of caching garbage', async () => {
    const f = fakeFetch((url) => (url.endsWith('/v1/oauth2/token') ? json({ error: 'nope' }) : json({})));
    const client = new PayPalClient({ clientId: 'c', clientSecret: 's', fetch: f.fetch });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(PayPalApiError);
  });

  it('turns a non-JSON error body into PayPalApiError with the raw text as details', async () => {
    const { client } = makeClient(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const err = (await client.getOrder('O1').then(
      () => null,
      (e: unknown) => e,
    )) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(502);
    expect(err.details).toEqual({ raw: '<html>502 Bad Gateway</html>' });
    expect(err.message).not.toContain(SECRET);
  });
});

describe('PayPalClient webhooks', () => {
  it('createWebhook posts the url and event types', async () => {
    const { client, calls } = makeClient(() => json({ id: 'WH-1', url: 'https://x.test/h' }, 201));
    const created = await client.createWebhook('https://x.test/h', ['A.B', 'C.D']);
    expect(created.id).toBe('WH-1');
    const call = calls[1];
    expect(call.url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/webhooks');
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(String(call.init.body))).toEqual({
      url: 'https://x.test/h',
      event_types: [{ name: 'A.B' }, { name: 'C.D' }],
    });
  });

  it('listWebhooks returns the webhooks array (empty when PayPal sends none)', async () => {
    const { client } = makeClient(() => json({ webhooks: [{ id: 'WH-1', url: 'u' }] }));
    expect(await client.listWebhooks()).toEqual([{ id: 'WH-1', url: 'u' }]);
    const empty = makeClient(() => json({}));
    expect(await empty.client.listWebhooks()).toEqual([]);
  });

  it('updateWebhookEvents PATCHes /event_types with a JSON Patch replace', async () => {
    const { client, calls } = makeClient(() => json({ id: 'WH-1' }));
    await client.updateWebhookEvents('WH-1', ['A.B']);
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[1].url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/webhooks/WH-1');
    expect(JSON.parse(String(calls[1].init.body))).toEqual([{ op: 'replace', path: '/event_types', value: [{ name: 'A.B' }] }]);
  });

  it('deleteWebhook sends DELETE to the encoded id and surfaces 404 as PayPalApiError', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }));
    await client.deleteWebhook('WH/1');
    expect(calls[1].init.method).toBe('DELETE');
    expect(calls[1].url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/webhooks/WH%2F1');

    const gone = makeClient(() => json({ name: 'INVALID_RESOURCE_ID', message: 'not found' }, 404));
    const err = await gone.client.deleteWebhook('WH-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).status).toBe(404);
  });
});

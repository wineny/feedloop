import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { PAYPAL_WEBHOOK_EVENT_TYPES } from '@/lib/paypal/settings';

// Per-bot PayPal settings route (stage 5, item 4). PayPal HTTP is a stubbed global fetch; the
// database is an in-memory row. What matters: owner only, the secret never comes back, nothing is
// saved for keys PayPal rejects, and the webhook is registered with the right URL and events.

const { resolveOwnedBots, encrypt, decrypt, db } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  db: {
    row: {} as Record<string, unknown>,
    updates: [] as Record<string, unknown>[],
    failUpdate: false,
  },
}));

const SAVED_SECRET = 'SAVEDSECRETvalue0000000000000000wxyz';

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/utils/crypto', () => ({ encrypt, decrypt }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      let pending: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.update = vi.fn((values: Record<string, unknown>) => {
        pending = values;
        return chain;
      });
      chain.single = vi.fn(async () => {
        if (!pending) return { data: db.row, error: null };
        if (db.failUpdate) return { data: null, error: { message: 'boom' } };
        db.updates.push(pending);
        db.row = { ...db.row, ...pending };
        return { data: db.row, error: null };
      });
      return chain;
    },
  }),
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'AaBbCcDdEeFfGgHh0123456789clientid';
const SECRET = 'EeSecretTyped0000000000000000abcd';
const TOKEN_URL = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
const WEBHOOKS_URL = 'https://api-m.sandbox.paypal.com/v1/notifications/webhooks';
const ALL_EVENTS = PAYPAL_WEBHOOK_EVENT_TYPES.map((name) => ({ name }));
const LISTENER = `https://feedloop.test/api/paypal/webhook/${BOT_ID}`;

const BASE_ROW = {
  id: BOT_ID,
  status: 'active',
  is_demo: false,
  paypal_client_id: null,
  paypal_secret_encrypted: null,
  paypal_secret_last4: null,
  paypal_env: 'sandbox',
  paypal_verified_at: null,
  paypal_failed_at: null,
  paypal_failed_reason: null,
  paypal_scopes: null,
  paypal_webhook_id: null,
  paypal_paused: false,
  propose_only: false,
  refund_auto_max_cents: 2000,
  refund_auto_days: 14,
  refund_daily_cap_cents: 10000,
  refund_per_customer_30d: 1,
  currency: 'USD',
};

const CONNECTED_ROW = {
  ...BASE_ROW,
  paypal_client_id: CLIENT_ID,
  paypal_secret_encrypted: 'enc:SAVEDCIPHER',
  paypal_secret_last4: 'wxyz',
  paypal_verified_at: '2026-10-20T00:00:00.000Z',
  paypal_scopes: ['https://uri.paypal.com/services/payments/refund'],
  paypal_webhook_id: 'WH-OLD',
};

type Call = { url: string; method: string; body: unknown; auth: string | undefined };
let calls: Call[] = [];
let handler: (url: string, method: string) => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const okToken = () => json({ access_token: 'tok', expires_in: 3600, scope: 'scope-a scope-b' });

let userSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh user per test: the 5-per-minute check limit is per user and lives in module memory.
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: `user-${++userSeq}`, botIds: [BOT_ID] });
  encrypt.mockReset().mockReturnValue('enc:CIPHERTEXT');
  decrypt.mockReset().mockReturnValue(SAVED_SECRET);
  db.row = { ...BASE_ROW };
  db.updates = [];
  db.failUpdate = false;
  calls = [];
  handler = (url, method) => {
    if (url === TOKEN_URL) return okToken();
    if (url === WEBHOOKS_URL && method === 'POST') return json({ id: 'WH-NEW', url: LISTENER }, 201);
    if (url === WEBHOOKS_URL && method === 'GET') return json({ webhooks: [] });
    return json({}, 404);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      let body: unknown = init?.body;
      if (typeof body === 'string' && /^[[{]/.test(body)) body = JSON.parse(body);
      calls.push({ url, method, body, auth: headers.Authorization });
      return handler(url, method);
    }),
  );
  vi.stubEnv('WEBHOOK_BASE_URL', 'https://feedloop.test');
  vi.stubEnv('NEXTAUTH_URL', '');
  vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-ENV');
  vi.stubEnv('PAYPAL_ENVIRONMENT', 'SANDBOX');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Whatever a test did, nothing secret reached the logs: no typed or saved secret, no Basic header.
  for (const spy of [console.warn, console.error]) {
    for (const args of vi.mocked(spy).mock.calls) {
      const text = inspect(args, { depth: 5 });
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SAVED_SECRET);
      expect(text).not.toContain('Basic ');
    }
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ctx = { params: Promise.resolve({ id: BOT_ID }) };

async function call(method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown) {
  const route = await import('@/app/api/bots/[id]/paypal/route');
  const req = new Request(`https://feedloop.test/api/bots/${BOT_ID}/paypal`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await route[method](req, { params: Promise.resolve({ id: BOT_ID }) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function retry() {
  const { POST } = await import('@/app/api/bots/[id]/paypal/webhook/route');
  const res = await POST(new Request(`https://feedloop.test/api/bots/${BOT_ID}/paypal/webhook`, { method: 'POST' }), ctx);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const webhookCalls = () => calls.filter((c) => c.url.startsWith(WEBHOOKS_URL));

describe('PayPal settings — owner only', () => {
  it('every method answers the ownership error and touches neither PayPal nor the row', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: 'forbidden' });
    db.row = { ...CONNECTED_ROW };
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await call(method, method === 'GET' || method === 'DELETE' ? undefined : { clientId: CLIENT_ID, secret: SECRET, paused: true });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('forbidden');
    }
    expect((await retry()).status).toBe(403);
    expect(resolveOwnedBots).toHaveBeenCalledTimes(5);
    for (const args of resolveOwnedBots.mock.calls) expect(args).toEqual([BOT_ID]);
    expect(calls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });
});

describe('GET', () => {
  it('never returns the secret or its ciphertext', async () => {
    db.row = { ...CONNECTED_ROW };
    const r = await call('GET');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('enc:');
    expect(r.text).not.toContain('SAVEDCIPHER');
    expect(r.text).not.toContain(SAVED_SECRET);
    expect(r.text).not.toContain('secret_encrypted');
    expect(r.body).toMatchObject({
      status: 'connected',
      botPaused: false,
      clientId: CLIENT_ID,
      secretLast4: 'wxyz',
      env: 'sandbox',
      verifiedAt: '2026-10-20T00:00:00.000Z',
      webhook: { registered: true, id: 'WH-OLD' },
      limits: { refundAutoMaxCents: 2000, refundAutoDays: 14, refundDailyCapCents: 10000, refundPerCustomer30d: 1 },
      switches: { paused: false, proposeOnly: false },
      currency: 'USD',
    });
    expect(calls).toHaveLength(0);
  });

  it('demo bot without keys is demo_default with the deployment webhook id; others are not_connected', async () => {
    db.row = { ...BASE_ROW, is_demo: true };
    const demo = await call('GET');
    expect(demo.body).toMatchObject({ status: 'demo_default', clientId: null, secretLast4: null, webhook: { registered: true, id: 'WH-ENV' } });

    db.row = { ...BASE_ROW };
    const none = await call('GET');
    expect(none.body).toMatchObject({ status: 'not_connected', clientId: null, webhook: { registered: false } });
  });

  it('a failure newer than the last verification is `failed`', async () => {
    db.row = { ...CONNECTED_ROW, paypal_failed_at: '2026-10-21T00:00:00.000Z', paypal_failed_reason: 'invalid_credentials' };
    const r = await call('GET');
    expect(r.body).toMatchObject({ status: 'failed', failedReason: 'invalid_credentials' });
  });
});

describe('PUT — save keys', () => {
  it('rejected keys (401 invalid_client) → 400 invalid_credentials and nothing saved', async () => {
    handler = (url) => (url === TOKEN_URL ? json({ error: 'invalid_client', error_description: 'Client Authentication failed' }, 401) : json({}, 500));
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid_credentials' });
    expect(db.updates).toHaveLength(0);
    expect(webhookCalls()).toHaveLength(0);
  });

  it('PayPal down → 502 paypal_unreachable and nothing saved', async () => {
    handler = () => json({}, 503);
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('paypal_unreachable');
    expect(db.updates).toHaveLength(0);
  });

  it('valid keys → saved encrypted with last4 and scopes, webhook registered with the listener URL and handled events', async () => {
    const r = await call('PUT', { clientId: `  ${CLIENT_ID} `, secret: SECRET });
    expect(r.status).toBe(200);

    const token = calls.find((c) => c.url === TOKEN_URL)!;
    expect(token.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);

    const [create] = webhookCalls();
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({ url: LISTENER, event_types: PAYPAL_WEBHOOK_EVENT_TYPES.map((name) => ({ name })) });
    expect(PAYPAL_WEBHOOK_EVENT_TYPES).toEqual(
      expect.arrayContaining(['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.CREATED']),
    );

    expect(db.updates).toHaveLength(1);
    const saved = db.updates[0];
    expect(saved).toMatchObject({
      paypal_client_id: CLIENT_ID,
      paypal_secret_encrypted: 'enc:CIPHERTEXT',
      paypal_secret_last4: 'abcd',
      paypal_env: 'sandbox',
      paypal_failed_at: null,
      paypal_failed_reason: null,
      paypal_scopes: ['scope-a', 'scope-b'],
      paypal_webhook_id: 'WH-NEW',
    });
    expect(typeof saved.paypal_verified_at).toBe('string');
    expect(JSON.stringify(saved)).not.toContain(SECRET);

    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain('enc:');
    expect(r.body).toMatchObject({ status: 'connected', clientId: CLIENT_ID, secretLast4: 'abcd', webhook: { registered: true, id: 'WH-NEW' } });
  });

  it('http base URL (local dev) → keys saved, webhook not registered, reason https_required', async () => {
    vi.stubEnv('WEBHOOK_BASE_URL', 'http://localhost:3400');
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(webhookCalls()).toHaveLength(0);
    expect(db.updates[0]).toMatchObject({ paypal_client_id: CLIENT_ID, paypal_webhook_id: null });
    expect(r.body).toMatchObject({ status: 'connected', webhook: { registered: false, reason: 'https_required' } });
  });

  it('no base URL at all → keys saved, reason no_base_url', async () => {
    vi.stubEnv('WEBHOOK_BASE_URL', '');
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(r.body.webhook).toEqual({ registered: false, reason: 'no_base_url' });
  });

  it('WEBHOOK_URL_ALREADY_EXISTS → reuses the id whose url matches', async () => {
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === WEBHOOKS_URL && method === 'POST') return json({ name: 'WEBHOOK_URL_ALREADY_EXISTS', message: 'exists' }, 400);
      if (url === WEBHOOKS_URL && method === 'GET') {
        return json({ webhooks: [{ id: 'WH-OTHER', url: 'https://elsewhere.test/hook' }, { id: 'WH-EXISTING', url: LISTENER }] });
      }
      return json({}, 404);
    };
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(db.updates[0].paypal_webhook_id).toBe('WH-EXISTING');
    expect(r.body.webhook).toEqual({ registered: true, id: 'WH-EXISTING' });
  });

  it('other PayPal webhook errors keep the keys and report the reason', async () => {
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === WEBHOOKS_URL && method === 'POST') return json({ name: 'WEBHOOK_NUMBER_LIMIT_EXCEEDED', message: 'max' }, 400);
      return json({}, 404);
    };
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(db.updates[0]).toMatchObject({ paypal_client_id: CLIENT_ID, paypal_webhook_id: null });
    expect(r.body.webhook).toEqual({ registered: false, reason: 'webhook_limit_reached' });
  });

  it('a new client id drops the old app’s webhook id', async () => {
    db.row = { ...CONNECTED_ROW };
    vi.stubEnv('WEBHOOK_BASE_URL', 'http://localhost:3400');
    const r = await call('PUT', { clientId: 'ZzOtherAppClientId000000000000000', secret: SECRET });
    expect(r.status).toBe(200);
    expect(db.updates[0]).toMatchObject({ paypal_client_id: 'ZzOtherAppClientId000000000000000', paypal_webhook_id: null });
    expect(r.body.webhook).toEqual({ registered: false, reason: 'https_required' });
    // The old app's webhook is still deleted (404 here: already gone — ignored).
    expect(webhookCalls().map((c) => c.method)).toEqual(['DELETE']);
  });

  it('a new client id with an https origin registers a fresh webhook', async () => {
    db.row = { ...CONNECTED_ROW };
    await call('PUT', { clientId: 'ZzOtherAppClientId000000000000000', secret: SECRET });
    expect(webhookCalls().filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(db.updates[0].paypal_webhook_id).toBe('WH-NEW');
  });

  it('the same app re-saved keeps a webhook id PayPal still lists for this listener', async () => {
    db.row = { ...CONNECTED_ROW };
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === WEBHOOKS_URL && method === 'GET') return json({ webhooks: [{ id: 'WH-OLD', url: LISTENER, event_types: ALL_EVENTS }] });
      return json({}, 500);
    };
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(webhookCalls().map((c) => c.method)).toEqual(['GET']);
    expect(db.updates[0].paypal_webhook_id).toBe('WH-OLD');
  });

  it('a stale stored id (gone from PayPal, or for another URL) is registered again', async () => {
    for (const listed of [[], [{ id: 'WH-OLD', url: 'https://old-origin.test/api/paypal/webhook/x', event_types: ALL_EVENTS }]]) {
      db.row = { ...CONNECTED_ROW };
      db.updates = [];
      calls = [];
      handler = (url, method) => {
        if (url === TOKEN_URL) return okToken();
        if (url === WEBHOOKS_URL && method === 'GET') return json({ webhooks: listed });
        if (url === WEBHOOKS_URL && method === 'POST') return json({ id: 'WH-NEW', url: LISTENER }, 201);
        return json({}, 500);
      };
      const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
      expect(webhookCalls().map((c) => c.method)).toEqual(['GET', 'POST']);
      expect(db.updates[0].paypal_webhook_id).toBe('WH-NEW');
      expect(r.body.webhook).toEqual({ registered: true, id: 'WH-NEW' });
    }
  });

  it('same app re-saved from an http or unset origin keeps the stored webhook id, unchecked', async () => {
    for (const origin of ['http://localhost:3400', '']) {
      db.row = { ...CONNECTED_ROW };
      db.updates = [];
      calls = [];
      vi.stubEnv('WEBHOOK_BASE_URL', origin);
      const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
      expect(r.status).toBe(200);
      expect(webhookCalls()).toHaveLength(0);
      expect(db.updates[0]).toMatchObject({ paypal_secret_encrypted: 'enc:CIPHERTEXT', paypal_webhook_id: 'WH-OLD' });
      expect(r.body.webhook).toEqual({
        registered: true,
        id: 'WH-OLD',
        reason: origin ? 'https_required' : 'no_base_url',
      });
    }
  });

  it('a saved row that is not sandbox is never treated as the same app', async () => {
    vi.stubEnv('PAYPAL_ALLOW_LIVE', '');
    db.row = { ...CONNECTED_ROW, paypal_env: 'live' };
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    // No list check of the old id; the old live app's webhook is not touched without the flag.
    expect(webhookCalls().map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${WEBHOOKS_URL}`]);
    expect(calls.some((c) => c.url.startsWith('https://api-m.paypal.com'))).toBe(false);
    expect(db.updates[0]).toMatchObject({ paypal_env: 'sandbox', paypal_webhook_id: 'WH-NEW' });
  });

  it('a new client id deletes the old app’s webhook with the OLD saved keys', async () => {
    db.row = { ...CONNECTED_ROW };
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === `${WEBHOOKS_URL}/WH-OLD` && method === 'DELETE') return new Response(null, { status: 204 });
      if (url === WEBHOOKS_URL && method === 'POST') return json({ id: 'WH-NEW', url: LISTENER }, 201);
      return json({}, 500);
    };
    const NEW_ID = 'ZzOtherAppClientId000000000000000';
    const r = await call('PUT', { clientId: NEW_ID, secret: SECRET });
    expect(r.status).toBe(200);
    const tokens = calls.filter((c) => c.url === TOKEN_URL).map((c) => c.auth);
    expect(tokens).toEqual([
      `Basic ${Buffer.from(`${NEW_ID}:${SECRET}`).toString('base64')}`,
      `Basic ${Buffer.from(`${CLIENT_ID}:${SAVED_SECRET}`).toString('base64')}`,
    ]);
    expect(webhookCalls().map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${WEBHOOKS_URL}/WH-OLD`, `POST ${WEBHOOKS_URL}`]);
    expect(db.updates[0]).toMatchObject({ paypal_client_id: NEW_ID, paypal_webhook_id: 'WH-NEW' });
  });

  it('rejected new keys never delete the old webhook', async () => {
    db.row = { ...CONNECTED_ROW };
    handler = (url) => (url === TOKEN_URL ? json({ error: 'invalid_client' }, 401) : json({}, 500));
    await call('PUT', { clientId: 'ZzOtherAppClientId000000000000000', secret: SECRET });
    expect(webhookCalls()).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('WEBHOOK_URL_ALREADY_EXISTS with an outdated event list → PATCHes the events', async () => {
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === WEBHOOKS_URL && method === 'POST') return json({ name: 'WEBHOOK_URL_ALREADY_EXISTS', message: 'exists' }, 400);
      if (url === WEBHOOKS_URL && method === 'GET') {
        return json({ webhooks: [{ id: 'WH-EXISTING', url: LISTENER, event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }] }] });
      }
      if (url === `${WEBHOOKS_URL}/WH-EXISTING` && method === 'PATCH') return json({ id: 'WH-EXISTING' });
      return json({}, 500);
    };
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.body.webhook).toEqual({ registered: true, id: 'WH-EXISTING' });
    const patch = webhookCalls().find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual([{ op: 'replace', path: '/event_types', value: ALL_EVENTS }]);
  });

  it('a missing encryption key fails before any PayPal call', async () => {
    encrypt.mockImplementation(() => {
      throw Object.assign(new Error('AES key is not set'), { name: 'CryptoKeyError' });
    });
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'server_error' });
    expect(calls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('a demo bot with its own keys: PUT stores its own webhook, GET never shows the deployment one', async () => {
    db.row = { ...BASE_ROW, is_demo: true };
    vi.stubEnv('WEBHOOK_BASE_URL', 'http://localhost:3400');
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'connected', clientId: CLIENT_ID, webhook: { registered: false, reason: 'https_required' } });
    const g = await call('GET');
    expect(g.body).toMatchObject({ status: 'connected', webhook: { registered: false } });
    expect(g.text).not.toContain('WH-ENV');
  });

  it('live is rejected before any PayPal call', async () => {
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET, env: 'live' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'live_not_allowed', field: 'env' });
    expect(calls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('shape errors: missing secret, bad characters, unknown field, non-object body', async () => {
    expect((await call('PUT', { clientId: CLIENT_ID })).body).toEqual({ error: 'secret_invalid', field: 'secret' });
    expect((await call('PUT', { clientId: 'has spaces in it but long enough', secret: SECRET })).body.error).toBe('client_id_invalid');
    expect((await call('PUT', { clientId: CLIENT_ID, secret: 'x'.repeat(300) })).body.error).toBe('secret_invalid');
    expect((await call('PUT', { clientId: CLIENT_ID, secret: SECRET, webhookId: 'W' })).body).toEqual({ error: 'unknown_field', field: 'webhookId' });
    expect((await call('PUT', '[1]')).body).toEqual({ error: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('the sixth key check in a minute is 429 and never reaches PayPal', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('PUT', { clientId: CLIENT_ID, secret: SECRET })).status).toBe(200);
    }
    const before = calls.length;
    const sixth = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('too_many_checks');
    expect(calls.length).toBe(before);
  });

  it('the webhook retry shares the same per-user limit', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('PUT', { clientId: CLIENT_ID, secret: SECRET })).status).toBe(200);
    }
    const before = calls.length;
    const r = await retry();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('too_many_checks');
    expect(calls.length).toBe(before);
  });

  it('a failed write answers save_failed', async () => {
    db.failUpdate = true;
    const r = await call('PUT', { clientId: CLIENT_ID, secret: SECRET });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'save_failed' });
  });
});

describe('DELETE — disconnect', () => {
  it('deletes the webhook with the saved keys, then clears keys/webhook/check columns but not limits', async () => {
    db.row = { ...CONNECTED_ROW, paypal_failed_at: '2026-10-21T00:00:00.000Z', paypal_failed_reason: 'invalid_credentials' };
    handler = (url) => (url === TOKEN_URL ? okToken() : new Response(null, { status: 204 }));
    const r = await call('DELETE');
    expect(r.status).toBe(200);

    const del = webhookCalls()[0];
    expect(del).toMatchObject({ method: 'DELETE', url: `${WEBHOOKS_URL}/WH-OLD` });
    const token = calls.find((c) => c.url === TOKEN_URL)!;
    expect(token.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SAVED_SECRET}`).toString('base64')}`);

    expect(db.updates[0]).toEqual({
      paypal_client_id: null,
      paypal_secret_encrypted: null,
      paypal_secret_last4: null,
      paypal_env: 'sandbox',
      paypal_verified_at: null,
      paypal_failed_at: null,
      paypal_failed_reason: null,
      paypal_scopes: null,
      paypal_webhook_id: null,
    });
    expect(r.body).toMatchObject({ status: 'not_connected', webhook: { registered: false }, limits: { refundAutoMaxCents: 2000 } });
  });

  it('a webhook PayPal no longer has (404) does not block the disconnect', async () => {
    db.row = { ...CONNECTED_ROW };
    handler = (url) => (url === TOKEN_URL ? okToken() : json({ name: 'INVALID_RESOURCE_ID' }, 404));
    const r = await call('DELETE');
    expect(r.status).toBe(200);
    expect(db.updates[0].paypal_client_id).toBeNull();
  });

  it('a demo bot falls back to demo_default and keeps a webhook id that is not its keys’', async () => {
    db.row = { ...BASE_ROW, is_demo: true, paypal_webhook_id: 'WH-DEMO' };
    const r = await call('DELETE');
    expect(calls).toHaveLength(0);
    expect(db.updates[0]).not.toHaveProperty('paypal_webhook_id');
    expect(r.body).toMatchObject({ status: 'demo_default', webhook: { registered: true, id: 'WH-DEMO' } });
  });
});

describe('DELETE — more', () => {
  it('saved keys that cannot be used (savedKeysClient throws) skip the webhook delete, not the disconnect', async () => {
    db.row = { ...CONNECTED_ROW };
    decrypt.mockImplementation(() => {
      throw Object.assign(new Error('AES key is not set'), { name: 'CryptoKeyError' });
    });
    const r = await call('DELETE');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(db.updates[0]).toMatchObject({ paypal_client_id: null, paypal_secret_encrypted: null, paypal_webhook_id: null });
  });

  it('a demo bot with its own keys: deletes its webhook, clears it, falls back to demo_default', async () => {
    db.row = { ...CONNECTED_ROW, is_demo: true };
    handler = (url) => (url === TOKEN_URL ? okToken() : new Response(null, { status: 204 }));
    const r = await call('DELETE');
    expect(webhookCalls()[0]).toMatchObject({ method: 'DELETE', url: `${WEBHOOKS_URL}/WH-OLD` });
    expect(db.updates[0]).toMatchObject({ paypal_client_id: null, paypal_webhook_id: null });
    expect(r.body).toMatchObject({ status: 'demo_default', clientId: null, webhook: { registered: true, id: 'WH-ENV' } });
  });
});

describe('PATCH — limits and switches', () => {
  it('partial update writes only the given columns', async () => {
    const r = await call('PATCH', { refundAutoMaxCents: 500, proposeOnly: true });
    expect(r.status).toBe(200);
    expect(db.updates[0]).toEqual({ refund_auto_max_cents: 500, propose_only: true });
    expect(r.body).toMatchObject({ limits: { refundAutoMaxCents: 500, refundAutoDays: 14 }, switches: { proposeOnly: true, paused: false } });
    expect(calls).toHaveLength(0);
  });

  it('all six fields at once', async () => {
    const r = await call('PATCH', {
      refundAutoMaxCents: 0,
      refundAutoDays: 0,
      refundDailyCapCents: 100_000_000,
      refundPerCustomer30d: 0,
      paused: true,
      proposeOnly: false,
    });
    expect(r.status).toBe(200);
    expect(db.updates[0]).toEqual({
      refund_auto_max_cents: 0,
      refund_auto_days: 0,
      refund_daily_cap_cents: 100_000_000,
      refund_per_customer_30d: 0,
      paypal_paused: true,
      propose_only: false,
    });
  });

  it.each([
    [{ refundAutoMaxCents: 12.5 }, 'invalid_value', 'refundAutoMaxCents'],
    [{ refundAutoMaxCents: '500' }, 'invalid_value', 'refundAutoMaxCents'],
    [{ refundAutoMaxCents: -1 }, 'out_of_range', 'refundAutoMaxCents'],
    [{ refundDailyCapCents: 100_000_001 }, 'out_of_range', 'refundDailyCapCents'],
    [{ refundAutoDays: -1 }, 'out_of_range', 'refundAutoDays'],
    [{ refundAutoDays: 181 }, 'out_of_range', 'refundAutoDays'],
    [{ refundPerCustomer30d: 101 }, 'out_of_range', 'refundPerCustomer30d'],
    [{ paused: 'true' }, 'invalid_value', 'paused'],
    [{ proposeOnly: 1 }, 'invalid_value', 'proposeOnly'],
    [{ currency: 'EUR' }, 'unknown_field', 'currency'],
    [{ paused: true, refund_auto_days: 3 }, 'unknown_field', 'refund_auto_days'],
    // Object.prototype names must not pass as known fields.
    [{ toString: 5 }, 'unknown_field', 'toString'],
    [{ constructor: true }, 'unknown_field', 'constructor'],
    ['{"__proto__":5}', 'unknown_field', '__proto__'],
    ['{"hasOwnProperty":false}', 'unknown_field', 'hasOwnProperty'],
  ])('%j → 400 %s', async (body, code, field) => {
    const r = await call('PATCH', body);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: code, field });
    expect(db.updates).toHaveLength(0);
  });

  it('refundAutoDays upper bound is 180 (PayPal refund window)', async () => {
    expect((await call('PATCH', { refundAutoDays: 180 })).status).toBe(200);
    expect((await call('PATCH', { refundAutoDays: 181 })).body).toEqual({ error: 'out_of_range', field: 'refundAutoDays' });
  });

  it('GET says when the whole bot is paused', async () => {
    db.row = { ...CONNECTED_ROW, status: 'paused' };
    expect((await call('GET')).body.botPaused).toBe(true);
  });

  it('empty body → nothing_to_change', async () => {
    const r = await call('PATCH', {});
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'nothing_to_change' });
  });
});

describe('POST /webhook — retry registration', () => {
  it('needs own saved keys', async () => {
    db.row = { ...BASE_ROW, is_demo: true };
    const r = await retry();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_connected');
    expect(calls).toHaveLength(0);
  });

  it('a stored webhook id PayPal still lists for this listener is kept without a write', async () => {
    db.row = { ...CONNECTED_ROW };
    handler = (url, method) => {
      if (url === TOKEN_URL) return okToken();
      if (url === WEBHOOKS_URL && method === 'GET') return json({ webhooks: [{ id: 'WH-OLD', url: LISTENER, event_types: ALL_EVENTS }] });
      return json({}, 500);
    };
    const r = await retry();
    expect(r.status).toBe(200);
    expect(webhookCalls().map((c) => c.method)).toEqual(['GET']);
    expect(db.updates).toHaveLength(0);
    expect(r.body.webhook).toEqual({ registered: true, id: 'WH-OLD' });
  });

  it('a stale stored id is registered again and the new id stored', async () => {
    db.row = { ...CONNECTED_ROW };
    const r = await retry();
    expect(webhookCalls().map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(db.updates[0]).toEqual({ paypal_webhook_id: 'WH-NEW' });
    expect(r.body.webhook).toEqual({ registered: true, id: 'WH-NEW' });
  });

  it('a live row without PAYPAL_ALLOW_LIVE → live_not_allowed; an unusable encryption key → 500 server_error', async () => {
    vi.stubEnv('PAYPAL_ALLOW_LIVE', '');
    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null, paypal_env: 'live' };
    const live = await retry();
    expect(live.status).toBe(400);
    expect(live.body).toEqual({ error: 'live_not_allowed' });

    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null };
    decrypt.mockImplementation(() => {
      throw Object.assign(new Error('AES key is not set'), { name: 'CryptoKeyError' });
    });
    const broken = await retry();
    expect(broken.status).toBe(500);
    expect(broken.body).toEqual({ error: 'server_error' });
    expect(calls).toHaveLength(0);
  });

  it('a secret that no longer decrypts → 409 secret_unreadable', async () => {
    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null };
    decrypt.mockReturnValue('');
    const r = await retry();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'secret_unreadable' });
  });

  it('registers with the saved keys and stores the id', async () => {
    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null };
    const r = await retry();
    expect(r.status).toBe(200);
    expect(webhookCalls()[0].body).toMatchObject({ url: LISTENER });
    expect(db.updates[0]).toEqual({ paypal_webhook_id: 'WH-NEW' });
    expect(r.body.webhook).toEqual({ registered: true, id: 'WH-NEW' });
    expect(r.text).not.toContain(SAVED_SECRET);
  });

  it('saved keys PayPal now rejects → recorded as failed', async () => {
    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null };
    handler = (url) => (url === TOKEN_URL ? json({ error: 'invalid_client' }, 401) : json({}, 500));
    const r = await retry();
    expect(r.status).toBe(200);
    expect(db.updates[0]).toMatchObject({ paypal_failed_reason: 'invalid_credentials' });
    expect(r.body).toMatchObject({ status: 'failed', webhook: { registered: false, reason: 'invalid_credentials' } });
  });

  it('http origin → reported, nothing written', async () => {
    db.row = { ...CONNECTED_ROW, paypal_webhook_id: null };
    vi.stubEnv('WEBHOOK_BASE_URL', 'http://localhost:3400');
    const r = await retry();
    expect(r.body.webhook).toEqual({ registered: false, reason: 'https_required' });
    expect(db.updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

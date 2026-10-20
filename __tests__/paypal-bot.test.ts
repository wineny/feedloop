import { afterEach, describe, expect, it, vi } from 'vitest';
import { toPayPalBot } from '@/lib/paypal/bot';

// The AES key is read when crypto.ts loads, so the decrypt step is replaced instead.
vi.mock('@/lib/utils/crypto', () => ({ decrypt: (v: string) => (v === 'enc:ok' ? 'per-bot-secret' : '') }));

const row = (o: Partial<Parameters<typeof toPayPalBot>[0]> = {}) => ({
  id: 'b1',
  status: 'active',
  is_demo: false,
  paypal_client_id: null,
  paypal_secret_encrypted: null,
  paypal_env: 'sandbox',
  paypal_webhook_id: null,
  ...o,
});

afterEach(() => vi.unstubAllEnvs());

describe('toPayPalBot', () => {
  it('a paused bot looks like a missing one', () => {
    expect(toPayPalBot(row({ status: 'paused', is_demo: true }))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a normal bot without credentials is not connected', () => {
    expect(toPayPalBot(row())).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('the demo bot falls back to the deployment PAYPAL_* env and PAYPAL_WEBHOOK_ID', () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'cid');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'sec');
    vi.stubEnv('PAYPAL_ENVIRONMENT', 'SANDBOX');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-ENV');
    const r = toPayPalBot(row({ is_demo: true }));
    expect(r.ok && r.bot).toMatchObject({ isDemo: true, sandbox: true, webhookId: 'WH-ENV' });
  });

  it('saved credentials win, and a live bot is refused unless PAYPAL_ALLOW_LIVE=1', () => {
    const secret = 'enc:ok';
    const ok = toPayPalBot(row({ paypal_client_id: 'own', paypal_secret_encrypted: secret, paypal_webhook_id: 'WH-OWN' }));
    expect(ok.ok && ok.bot).toMatchObject({ sandbox: true, webhookId: 'WH-OWN' });
    expect(() => toPayPalBot(row({ paypal_client_id: 'own', paypal_secret_encrypted: secret, paypal_env: 'live' }))).toThrow(/live/);
  });

  it('an unreadable saved secret is "not connected", never a client with an empty secret', () => {
    expect(toPayPalBot(row({ paypal_client_id: 'own', paypal_secret_encrypted: 'garbage' }))).toEqual({ ok: false, reason: 'not_connected' });
  });
});

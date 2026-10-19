import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAYPAL_LIVE_BASE_URL, PAYPAL_SANDBOX_BASE_URL, readPayPalEnv } from '@/lib/paypal/env';

// The one rule in env.ts: we never talk to live PayPal by accident. Pins the default, the
// case/padding tolerance, the explicit opt-in and the missing-variable message (names only).

const KEYS = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENVIRONMENT', 'PAYPAL_ALLOW_LIVE'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.PAYPAL_CLIENT_ID = 'id';
  process.env.PAYPAL_CLIENT_SECRET = 'secret';
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('readPayPalEnv', () => {
  it('defaults to sandbox when PAYPAL_ENVIRONMENT is unset', () => {
    const env = readPayPalEnv();
    expect(env.sandbox).toBe(true);
    expect(env.baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
  });

  it('accepts sandbox in any case with padding', () => {
    process.env.PAYPAL_ENVIRONMENT = '  sandbox ';
    expect(readPayPalEnv().sandbox).toBe(true);
  });

  it('refuses anything else without PAYPAL_ALLOW_LIVE=1 (including typos)', () => {
    for (const v of ['LIVE', 'production', 'sandbx']) {
      process.env.PAYPAL_ENVIRONMENT = v;
      expect(() => readPayPalEnv()).toThrow(/PAYPAL_ALLOW_LIVE/);
    }
  });

  it('allows live only with the explicit opt-in', () => {
    process.env.PAYPAL_ENVIRONMENT = 'LIVE';
    process.env.PAYPAL_ALLOW_LIVE = '1';
    const env = readPayPalEnv();
    expect(env.sandbox).toBe(false);
    expect(env.baseUrl).toBe(PAYPAL_LIVE_BASE_URL);
  });

  it('names the missing variables, never their values', () => {
    delete process.env.PAYPAL_CLIENT_SECRET;
    expect(() => readPayPalEnv()).toThrow(/PAYPAL_CLIENT_SECRET/);
    expect(() => readPayPalEnv()).not.toThrow(/secret/);
  });
});

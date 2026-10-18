// Shared PayPal environment rules for the toolkit adapter, the REST client and scripts.
//
// One rule lives here: we never talk to the live PayPal API by accident. The hackathon
// build moves (sandbox) money, so anything other than SANDBOX needs an explicit opt-in.

export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_LIVE_BASE_URL = 'https://api-m.paypal.com';

export interface PayPalEnvConfig {
  clientId: string;
  clientSecret: string;
  sandbox: boolean;
  baseUrl: string;
}

/** Throws unless sandbox, or the caller opted in to live with PAYPAL_ALLOW_LIVE=1. */
export function assertLiveAllowed(sandbox: boolean): void {
  if (!sandbox && process.env.PAYPAL_ALLOW_LIVE !== '1') {
    throw new Error(
      'Refusing to use the live PayPal environment. Set PAYPAL_ALLOW_LIVE=1 to opt in explicitly.',
    );
  }
}

/**
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENVIRONMENT.
 * Missing ids fail loudly with the variable names (never the values).
 * An unset PAYPAL_ENVIRONMENT is treated as SANDBOX; any other value is live and gated.
 */
export function readPayPalEnv(): PayPalEnvConfig {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const missing = [
    !clientId && 'PAYPAL_CLIENT_ID',
    !clientSecret && 'PAYPAL_CLIENT_SECRET',
  ].filter(Boolean);
  if (!clientId || !clientSecret) {
    throw new Error(`Missing PayPal environment variables: ${missing.join(', ')}`);
  }
  const environment = (process.env.PAYPAL_ENVIRONMENT ?? 'SANDBOX').trim().toUpperCase();
  const sandbox = environment === 'SANDBOX';
  assertLiveAllowed(sandbox);
  return {
    clientId,
    clientSecret,
    sandbox,
    baseUrl: sandbox ? PAYPAL_SANDBOX_BASE_URL : PAYPAL_LIVE_BASE_URL,
  };
}

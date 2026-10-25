// Which PayPal credentials and webhook id a bot uses.
//
// Order of preference:
//  1. The bot's own saved credentials (bots.paypal_client_id + paypal_secret_encrypted).
//  2. The demo bot (bots.is_demo) falls back to the deployment-wide PAYPAL_* env and
//     PAYPAL_WEBHOOK_ID — that is how the hosted hackathon demo runs.
//  3. Anyone else is "not connected": no checkout, webhooks rejected.

import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt } from '@/lib/utils/crypto';
import { PayPalClient, paypalClientFromEnv, type FetchLike } from './client';
import { assertLiveAllowed, PAYPAL_LIVE_BASE_URL, PAYPAL_SANDBOX_BASE_URL, readPayPalEnv } from './env';

export interface PayPalBot {
  id: string;
  isDemo: boolean;
  sandbox: boolean;
  /** Needed to verify webhook signatures. null = webhooks for this bot are rejected. */
  webhookId: string | null;
  client: PayPalClient;
}

export type PayPalBotResult =
  | { ok: true; bot: PayPalBot }
  | { ok: false; reason: 'not_found' | 'not_connected' };

interface BotPayPalRow {
  id: string;
  status: string;
  is_demo: boolean;
  paypal_client_id: string | null;
  paypal_secret_encrypted: string | null;
  paypal_env: string;
  paypal_webhook_id: string | null;
}

/**
 * "Is this bot PayPal-connected?" without decrypting anything — for screens (the dashboard) that
 * only need the yes/no. Same rule as `toPayPalBot`: not paused, and either its own saved keys or
 * the demo bot's env keys. One difference by design: a saved secret that no longer decrypts counts
 * as connected here (keys are saved) while `toPayPalBot` says not_connected — only a real call can
 * tell, and the settings screen's OAuth check is where that shows up.
 *
 * Live mode: a bot with saved keys and `paypal_env='live'` (demo or not) counts as connected here, but
 * `toPayPalBot` throws for it unless PAYPAL_ALLOW_LIVE=1 (`assertLiveAllowed`). The settings route keeps
 * `paypal_env` at sandbox, so this only matters if someone flips the column by hand. A demo bot WITHOUT
 * saved keys ignores `paypal_env` — the deployment env (PAYPAL_ENVIRONMENT) decides sandbox vs live.
 */
export function isPayPalConnected(
  row: Pick<BotPayPalRow, 'status' | 'is_demo' | 'paypal_client_id' | 'paypal_secret_encrypted'>,
): boolean {
  if (row.status === 'paused') return false;
  return Boolean(row.paypal_client_id && row.paypal_secret_encrypted) || row.is_demo;
}

/** Pure decision, exported for tests. */
export function toPayPalBot(row: BotPayPalRow, opts: { fetch?: FetchLike } = {}): PayPalBotResult {
  if (row.status === 'paused') return { ok: false, reason: 'not_found' };

  if (row.paypal_client_id && row.paypal_secret_encrypted) {
    const secret = decrypt(row.paypal_secret_encrypted);
    if (!secret) return { ok: false, reason: 'not_connected' };
    const sandbox = row.paypal_env !== 'live';
    assertLiveAllowed(sandbox);
    return {
      ok: true,
      bot: {
        id: row.id,
        isDemo: row.is_demo,
        sandbox,
        // Own keys = own PayPal app: the deployment's PAYPAL_WEBHOOK_ID belongs to another app and
        // would never verify its events, so a demo bot with its own keys does not borrow it.
        webhookId: row.paypal_webhook_id,
        client: new PayPalClient({
          clientId: row.paypal_client_id,
          clientSecret: secret,
          baseUrl: sandbox ? PAYPAL_SANDBOX_BASE_URL : PAYPAL_LIVE_BASE_URL,
          fetch: opts.fetch,
        }),
      },
    };
  }

  if (row.is_demo) {
    return {
      ok: true,
      bot: {
        id: row.id,
        isDemo: true,
        sandbox: readPayPalEnv().sandbox,
        webhookId: row.paypal_webhook_id ?? envWebhookId(),
        client: paypalClientFromEnv({ fetch: opts.fetch }),
      },
    };
  }

  return { ok: false, reason: 'not_connected' };
}

function envWebhookId(): string | null {
  const v = process.env.PAYPAL_WEBHOOK_ID?.trim();
  return v ? v : null;
}

export async function resolvePayPalBot(botId: string): Promise<PayPalBotResult> {
  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .select('id, status, is_demo, paypal_client_id, paypal_secret_encrypted, paypal_env, paypal_webhook_id')
    .eq('id', botId)
    .maybeSingle();
  if (error) {
    console.error('[paypal] bot lookup failed', { botId, code: error.code, message: error.message });
    throw new Error('bot lookup failed');
  }
  if (!data) return { ok: false, reason: 'not_found' };
  return toPayPalBot(data as BotPayPalRow);
}

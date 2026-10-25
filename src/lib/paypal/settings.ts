// Per-bot PayPal settings (design §3): what the settings tab reads, how saved keys are checked,
// and how the bot's webhook gets registered. The route (`api/bots/[id]/paypal`) does auth and DB.
//
// Rules this module keeps:
//  - The secret never leaves: `presentPayPalSettings` has no field for it, only `secretLast4`.
//  - Keys are checked against PayPal (a real OAuth token) before anything is saved.
//  - Always sandbox. The live API is never reached from this screen (`assertLiveAllowed` guards
//    any saved row someone flipped to 'live' by hand).
//  - Nothing here logs a secret, an Authorization header or PayPal's error body.

import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt } from '@/lib/utils/crypto';
import { isUncertainPayPalError, PayPalApiError, PayPalClient, type PayPalWebhook } from './client';
import { assertLiveAllowed, PAYPAL_LIVE_BASE_URL, PAYPAL_SANDBOX_BASE_URL } from './env';
import { appOrigin } from './checkout';

/** Event types the webhook route handles (`handleWebhookEvent` in webhook.ts). Also used by scripts/paypal-register-webhook.ts. */
export const PAYPAL_WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;

export const PAYPAL_SETTINGS_SELECT =
  'id, status, is_demo, paypal_client_id, paypal_secret_encrypted, paypal_secret_last4, paypal_env, paypal_verified_at, ' +
  'paypal_failed_at, paypal_failed_reason, paypal_scopes, paypal_webhook_id, paypal_paused, propose_only, ' +
  'refund_auto_max_cents, refund_auto_days, refund_daily_cap_cents, refund_per_customer_30d, currency';

export interface PayPalSettingsRow {
  id: string;
  /** bots.status — 'paused' turns PayPal off for the bot (isPayPalConnected), keys or not. */
  status: string;
  is_demo: boolean;
  paypal_client_id: string | null;
  paypal_secret_encrypted: string | null;
  paypal_secret_last4: string | null;
  paypal_env: string;
  paypal_verified_at: string | null;
  paypal_failed_at: string | null;
  paypal_failed_reason: string | null;
  paypal_scopes: string[] | null;
  paypal_webhook_id: string | null;
  paypal_paused: boolean;
  propose_only: boolean;
  refund_auto_max_cents: number;
  refund_auto_days: number;
  refund_daily_cap_cents: number;
  refund_per_customer_30d: number;
  currency: string;
}

export type PayPalConnectionStatus = 'connected' | 'demo_default' | 'not_connected' | 'failed';

function hasOwnKeys(row: PayPalSettingsRow): boolean {
  return Boolean(row.paypal_client_id && row.paypal_secret_encrypted);
}

/**
 * - connected / failed: the bot has its own saved keys; `failed` when the last recorded failure is
 *   newer than the last successful check (the webhook retry records one when PayPal rejects the keys).
 * - demo_default: the demo bot without its own keys runs on the deployment's PAYPAL_* env.
 * - not_connected: anyone else.
 */
export function connectionStatus(row: PayPalSettingsRow): PayPalConnectionStatus {
  if (hasOwnKeys(row)) {
    const failedAt = row.paypal_failed_at ? Date.parse(row.paypal_failed_at) : NaN;
    const verifiedAt = row.paypal_verified_at ? Date.parse(row.paypal_verified_at) : NaN;
    if (!Number.isNaN(failedAt) && (Number.isNaN(verifiedAt) || failedAt >= verifiedAt)) return 'failed';
    return 'connected';
  }
  return row.is_demo ? 'demo_default' : 'not_connected';
}

function envWebhookId(): string | null {
  const v = process.env.PAYPAL_WEBHOOK_ID?.trim();
  return v ? v : null;
}

function deploymentEnv(): 'sandbox' | 'live' {
  return (process.env.PAYPAL_ENVIRONMENT ?? 'SANDBOX').trim().toUpperCase() === 'SANDBOX' ? 'sandbox' : 'live';
}

/**
 * The settings tab's view. **`paypal_secret_encrypted` is not in here** — not even as ciphertext.
 * The demo bot on deployment keys shows no client id: those keys are not the bot's own.
 */
export function presentPayPalSettings(row: PayPalSettingsRow) {
  const status = connectionStatus(row);
  const own = status === 'connected' || status === 'failed';
  // Same webhook id the webhook route verifies with (toPayPalBot), except a demo bot's own keys
  // never borrow the deployment's PAYPAL_WEBHOOK_ID here — that id belongs to another app.
  const webhookId = own ? row.paypal_webhook_id : status === 'demo_default' ? (row.paypal_webhook_id ?? envWebhookId()) : null;
  return {
    status,
    // The whole bot is paused: the dashboard says "not connected" whatever the keys. The tab explains why.
    botPaused: row.status === 'paused',
    clientId: own ? row.paypal_client_id : null,
    secretLast4: own ? row.paypal_secret_last4 : null,
    env: own ? (row.paypal_env === 'live' ? 'live' : 'sandbox') : status === 'demo_default' ? deploymentEnv() : 'sandbox',
    verifiedAt: own ? row.paypal_verified_at : null,
    failedAt: own ? row.paypal_failed_at : null,
    // Our own short code (see WebhookFailReason), never PayPal's text.
    failedReason: own ? row.paypal_failed_reason : null,
    scopes: own ? (row.paypal_scopes ?? []) : [],
    webhook: webhookId ? { registered: true as const, id: webhookId } : { registered: false as const },
    limits: {
      refundAutoMaxCents: row.refund_auto_max_cents,
      refundAutoDays: row.refund_auto_days,
      refundDailyCapCents: row.refund_daily_cap_cents,
      refundPerCustomer30d: row.refund_per_customer_30d,
    },
    switches: { paused: row.paypal_paused, proposeOnly: row.propose_only },
    currency: row.currency,
  };
}

/**
 * The view after a save. A registration that just failed adds its reason (GET cannot know it later)
 * to the webhook state actually stored — `registered` stays true when a stored id was kept.
 */
export function presentWithWebhook(row: PayPalSettingsRow, webhook?: WebhookOutcome) {
  const view = presentPayPalSettings(row);
  return webhook && !webhook.registered ? { ...view, webhook: { ...view.webhook, reason: webhook.reason } } : view;
}

export async function loadPayPalSettings(id: string): Promise<PayPalSettingsRow | null> {
  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .select(PAYPAL_SETTINGS_SELECT)
    .eq('id', id)
    .single();
  return error || !data ? null : (data as unknown as PayPalSettingsRow);
}

/** One UPDATE, returning the saved row; null on failure (logged without the values — they hold ciphertext). */
export async function updatePayPalSettings(id: string, values: Record<string, unknown>): Promise<PayPalSettingsRow | null> {
  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .update(values)
    .eq('id', id)
    .select(PAYPAL_SETTINGS_SELECT)
    .single();
  if (error || !data) {
    console.error(`[paypal-settings] save failed for ${id}:`, error?.message);
    return null;
  }
  return data as unknown as PayPalSettingsRow;
}

// ── PUT body ────────────────────────────────────────

// PayPal client ids and secrets are ~80 URL-safe characters. The bounds only stop garbage and
// oversized bodies before a network call; PayPal's OAuth answer is the real check.
const CREDENTIAL_RE = /^[A-Za-z0-9_.-]{16,256}$/;
const CREDENTIAL_FIELDS = new Set(['clientId', 'secret', 'env']);

export type CredentialsParse =
  | { ok: true; clientId: string; secret: string }
  | { ok: false; code: 'unknown_field' | 'client_id_invalid' | 'secret_invalid' | 'live_not_allowed' | 'env_invalid'; field: string };

/**
 * `{ clientId, secret, env? }` — both keys every time: saving re-enters the secret, so a client id
 * change can never pair with the old app's secret. `env` may only be 'sandbox'; this screen never
 * saves live keys, with or without PAYPAL_ALLOW_LIVE.
 */
export function parseCredentialsBody(body: Record<string, unknown>): CredentialsParse {
  for (const key of Object.keys(body)) {
    if (!CREDENTIAL_FIELDS.has(key)) return { ok: false, code: 'unknown_field', field: key };
  }
  if ('env' in body && body.env !== 'sandbox') {
    return body.env === 'live'
      ? { ok: false, code: 'live_not_allowed', field: 'env' }
      : { ok: false, code: 'env_invalid', field: 'env' };
  }
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  if (!CREDENTIAL_RE.test(clientId)) return { ok: false, code: 'client_id_invalid', field: 'clientId' };
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  if (!CREDENTIAL_RE.test(secret)) return { ok: false, code: 'secret_invalid', field: 'secret' };
  return { ok: true, clientId, secret };
}

export function secretLast4(secret: string): string {
  return secret.slice(-4);
}

// ── PATCH body ──────────────────────────────────────

// Ranges agree with bots_refund_limits_check (all ≥ 0) and stay well inside INTEGER.
//  - cents: up to $1,000,000.
//  - days: 0–180. PayPal refunds a capture for up to 180 days; a longer auto window would only
//    produce refunds PayPal rejects. 0 = no automatic refunds by age (the window is empty).
//  - per customer: 0–100 auto refunds per customer per 30 days; 0 = none (the RPC checks count < cap).
// No cross-field rule (e.g. daily cap ≥ auto max): payment_action_open_refund checks each limit on
// its own at execution time, so a daily cap below the per-refund max just sends more to approval.
const LIMIT_FIELDS = {
  refundAutoMaxCents: { column: 'refund_auto_max_cents', min: 0, max: 100_000_000 },
  refundAutoDays: { column: 'refund_auto_days', min: 0, max: 180 },
  refundDailyCapCents: { column: 'refund_daily_cap_cents', min: 0, max: 100_000_000 },
  refundPerCustomer30d: { column: 'refund_per_customer_30d', min: 0, max: 100 },
} as const;
const SWITCH_FIELDS = { paused: 'paypal_paused', proposeOnly: 'propose_only' } as const;

export type LimitsParse =
  | { ok: true; values: Record<string, number | boolean> }
  | { ok: false; code: 'unknown_field' | 'invalid_value' | 'out_of_range' | 'nothing_to_change'; field?: string };

/** Partial update of the four limits and two switches. Currency is not editable here. */
export function parseLimitsPatch(body: Record<string, unknown>): LimitsParse {
  const values: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(body)) {
    // Own keys only: `in` would let Object.prototype names (toString, constructor…) through.
    if (Object.hasOwn(LIMIT_FIELDS, key)) {
      const rule = LIMIT_FIELDS[key as keyof typeof LIMIT_FIELDS];
      if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, code: 'invalid_value', field: key };
      if (value < rule.min || value > rule.max) return { ok: false, code: 'out_of_range', field: key };
      values[rule.column] = value;
    } else if (Object.hasOwn(SWITCH_FIELDS, key)) {
      if (typeof value !== 'boolean') return { ok: false, code: 'invalid_value', field: key };
      values[SWITCH_FIELDS[key as keyof typeof SWITCH_FIELDS]] = value;
    } else {
      return { ok: false, code: 'unknown_field', field: key };
    }
  }
  if (Object.keys(values).length === 0) return { ok: false, code: 'nothing_to_change' };
  return { ok: true, values };
}

// ── PayPal calls ────────────────────────────────────

/** A client for keys typed into the form. Always sandbox. */
export function sandboxClient(clientId: string, secret: string): PayPalClient {
  return new PayPalClient({ clientId, clientSecret: secret, baseUrl: PAYPAL_SANDBOX_BASE_URL });
}

/**
 * A client for the bot's saved keys, or null when there are none or the secret no longer decrypts.
 * Throws (assertLiveAllowed) for a row flipped to 'live' by hand without PAYPAL_ALLOW_LIVE=1.
 */
export function savedKeysClient(row: PayPalSettingsRow): PayPalClient | null {
  if (!row.paypal_client_id || !row.paypal_secret_encrypted) return null;
  const secret = decrypt(row.paypal_secret_encrypted);
  if (!secret) return null;
  const sandbox = row.paypal_env !== 'live';
  assertLiveAllowed(sandbox);
  return new PayPalClient({
    clientId: row.paypal_client_id,
    clientSecret: secret,
    baseUrl: sandbox ? PAYPAL_SANDBOX_BASE_URL : PAYPAL_LIVE_BASE_URL,
  });
}

export type VerifyResult = { ok: true; scopes: string[] } | { ok: false; code: 'invalid_credentials' | 'paypal_unreachable' };

/**
 * One client-credentials token request. A definite 4xx (401 invalid_client and friends) means the
 * keys are wrong; a timeout, network error, 5xx or 429 means we could not tell.
 */
export async function verifyCredentials(client: PayPalClient): Promise<VerifyResult> {
  try {
    const { scope } = await client.getAccessToken();
    return { ok: true, scopes: scope.split(/\s+/).filter(Boolean) };
  } catch (err) {
    logPayPalError('verify', err);
    return { ok: false, code: err instanceof PayPalApiError && !isUncertainPayPalError(err) ? 'invalid_credentials' : 'paypal_unreachable' };
  }
}

export type WebhookFailReason =
  | 'no_base_url'
  | 'https_required'
  | 'invalid_credentials'
  | 'webhook_limit_reached'
  | 'paypal_unreachable'
  | 'paypal_error';

export type WebhookOutcome = { registered: true; id: string } | { registered: false; reason: WebhookFailReason };

/** The public origin PayPal posts to (WEBHOOK_BASE_URL, else NEXTAUTH_URL), or null when neither is set. */
export function webhookOrigin(): string | null {
  try {
    return appOrigin();
  } catch {
    return null;
  }
}

export function webhookListenerUrl(origin: string, botId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/paypal/webhook/${encodeURIComponent(botId)}`;
}

/**
 * Makes sure this bot's listener is registered on the app behind `client`. PayPal delivers only to
 * https, so a local http origin is reported, not attempted.
 *
 * `storedId` (the same app's saved webhook id) is kept only if PayPal still lists it for this
 * exact listener URL — it may have been deleted in the PayPal dashboard, or registered for another
 * origin. If PayPal cannot be asked right now, the stored id is kept rather than dropped on a hiccup.
 * A URL the app already has is reused by id, its event list brought up to date.
 */
export async function registerWebhook(
  client: PayPalClient,
  origin: string | null,
  botId: string,
  storedId: string | null = null,
): Promise<WebhookOutcome> {
  if (!origin) return { registered: false, reason: 'no_base_url' };
  if (!origin.startsWith('https://')) return { registered: false, reason: 'https_required' };
  const url = webhookListenerUrl(origin, botId);
  if (storedId) {
    try {
      const stored = (await client.listWebhooks()).find((w) => w.id === storedId && w.url === url);
      if (stored) return await withCurrentEvents(client, stored);
    } catch (err) {
      logPayPalError('webhook list', err);
      const reason = webhookFailReason(err);
      return reason === 'invalid_credentials' ? { registered: false, reason } : { registered: true, id: storedId };
    }
  }
  try {
    const created = await client.createWebhook(url, PAYPAL_WEBHOOK_EVENT_TYPES);
    return { registered: true, id: created.id };
  } catch (err) {
    if (!(err instanceof PayPalApiError) || err.paypalName !== 'WEBHOOK_URL_ALREADY_EXISTS') {
      logPayPalError('webhook create', err);
      return { registered: false, reason: webhookFailReason(err) };
    }
  }
  try {
    const same = (await client.listWebhooks()).find((w) => w.url === url);
    if (same) return await withCurrentEvents(client, same);
    return { registered: false, reason: 'paypal_error' };
  } catch (err) {
    logPayPalError('webhook list', err);
    return { registered: false, reason: webhookFailReason(err) };
  }
}

/** Same as the script: an existing webhook whose event list drifted gets the current list. Best effort. */
async function withCurrentEvents(client: PayPalClient, hook: PayPalWebhook): Promise<WebhookOutcome> {
  const have = (hook.event_types ?? []).map((e) => e.name).sort().join(',');
  if (have !== [...PAYPAL_WEBHOOK_EVENT_TYPES].sort().join(',')) {
    try {
      await client.updateWebhookEvents(hook.id, PAYPAL_WEBHOOK_EVENT_TYPES);
    } catch (err) {
      logPayPalError('webhook event update', err);
    }
  }
  return { registered: true, id: hook.id };
}

function webhookFailReason(err: unknown): WebhookFailReason {
  if (err instanceof PayPalApiError) {
    if (err.status === 401) return 'invalid_credentials';
    if (err.paypalName === 'WEBHOOK_NUMBER_LIMIT_EXCEEDED') return 'webhook_limit_reached';
  }
  return isUncertainPayPalError(err) ? 'paypal_unreachable' : 'paypal_error';
}

/** Best effort: the webhook goes with the keys. A 404 (already gone) is fine; anything else is logged and ignored. */
export async function deleteWebhookQuietly(client: PayPalClient, webhookId: string): Promise<void> {
  try {
    await client.deleteWebhook(webhookId);
  } catch (err) {
    if (err instanceof PayPalApiError && err.status === 404) return;
    logPayPalError('webhook delete', err);
  }
}

// Status, PayPal's error name and debug id only — never `details` (PayPal's body) or the request.
function logPayPalError(step: string, err: unknown): void {
  if (err instanceof PayPalApiError) {
    console.warn(`[paypal-settings] ${step} failed`, { status: err.status, name: err.paypalName, debugId: err.debugId });
  } else {
    console.warn(`[paypal-settings] ${step} failed`, { error: (err as Error)?.name ?? 'unknown' });
  }
}

// ── rate limit ─────────────────────────────────────
//
// Same reason as llm-key: each key save (and webhook retry) sends a request to PayPal from our
// server's IP. Without a limit this route is a credential-guessing proxy. People save keys far
// less than five times a minute. In memory, per instance — it raises the cost of automation, no more.
const CHECK_LIMIT_PER_MIN = 5;
const checkHits = new Map<string, number[]>();

export function paypalCheckRateExceeded(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const hits = (checkHits.get(userId) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  checkHits.set(userId, hits);
  if (checkHits.size > 5000) {
    for (const [key, times] of checkHits) {
      if (times.every((t) => t <= cutoff)) checkHits.delete(key);
    }
  }
  return hits.length > CHECK_LIMIT_PER_MIN;
}

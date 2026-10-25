// Bot settings › PayPal — the bot's own PayPal keys, its webhook, refund limits and switches (design §3).
//
// Same structure as `llm-key/route.ts`. What it keeps:
//  1) **The secret never goes out.** Stored AES-256-GCM encrypted; responses carry `secretLast4` only.
//     There is no path that reads a saved secret back.
//  2) Owner only (`resolveOwnedBots`). Approvers operate refunds; they never re-key a bot.
//  3) Keys are checked with PayPal (a real sandbox OAuth token) before saving. A failed check saves
//     nothing — half-saved keys would fail in front of the first buyer.
//
// Errors are `{ error: <code> }` (plus `field` for validation); the settings screen translates them.
// No cache to invalidate: `resolvePayPalBot` and the refund guardrail RPC read `bots` on every call.
//
// GET    → current state (presentPayPalSettings)
// PUT    { clientId, secret }        → verify, save, register webhook
// PATCH  { refundAutoMaxCents?, refundAutoDays?, refundDailyCapCents?, refundPerCustomer30d?, paused?, proposeOnly? }
// DELETE → best-effort webhook delete, then clear keys (limits stay)

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { encrypt } from '@/lib/utils/crypto';
import {
  deleteWebhookQuietly,
  loadPayPalSettings,
  parseCredentialsBody,
  parseLimitsPatch,
  paypalCheckRateExceeded,
  presentPayPalSettings,
  presentWithWebhook,
  registerWebhook,
  sandboxClient,
  savedKeysClient,
  secretLast4,
  verifyCredentials,
  updatePayPalSettings,
  webhookOrigin,
  type PayPalSettingsRow,
  type WebhookOutcome,
} from '@/lib/paypal/settings';

export const dynamic = 'force-dynamic';

async function save(id: string, values: Record<string, unknown>, webhook?: WebhookOutcome) {
  const row = await updatePayPalSettings(id, values);
  if (!row) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  return NextResponse.json(presentWithWebhook(row, webhook));
}

async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const bot = await loadPayPalSettings(id);
  if (!bot) return NextResponse.json({ error: 'bot_not_found' }, { status: 404 });

  return NextResponse.json(presentPayPalSettings(bot));
}

/**
 * Save keys: format check → encrypt → rate limit → PayPal OAuth token → webhook → one write.
 *
 * Webhook rules:
 *  - same app (same client id, saved sandbox keys) with a stored webhook id → kept only if PayPal
 *    still lists it for this bot's listener URL; otherwise registered again. From an origin PayPal
 *    cannot deliver to (http / unset — local dev) it is kept unchecked: `{ registered: true, id, reason }`.
 *  - another app → the old app's webhook is deleted with the OLD saved keys (best effort; the new
 *    keys cannot touch it), then a new one is registered on the new app.
 *  - registration failure (http origin in local dev, PayPal error) keeps the verified keys and
 *    answers `webhook: { registered: false, reason }`. The webhook route then rejects this bot's
 *    events (bot.ts) until the retry endpoint succeeds.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await readObject(req);
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const parsed = parseCredentialsBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.code, field: parsed.field }, { status: 400 });

  // Encrypt first: a missing encryption key fails here, before PayPal is asked anything or a
  // webhook is registered for keys we then could not store.
  let encryptedSecret: string;
  try {
    encryptedSecret = encrypt(parsed.secret);
  } catch (err) {
    console.error(`[paypal-settings] encrypt failed for ${id}:`, (err as Error).name);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  const bot = await loadPayPalSettings(id);
  if (!bot) return NextResponse.json({ error: 'bot_not_found' }, { status: 404 });

  // Counted after the format check: a typo should not cost a try.
  if (paypalCheckRateExceeded(auth.userId)) {
    return NextResponse.json({ error: 'too_many_checks' }, { status: 429 });
  }

  const client = sandboxClient(parsed.clientId, parsed.secret);
  const verified = await verifyCredentials(client);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.code }, { status: verified.code === 'invalid_credentials' ? 400 : 502 });
  }

  const ownKeys = Boolean(bot.paypal_client_id && bot.paypal_secret_encrypted);
  const sameApp = ownKeys && bot.paypal_client_id === parsed.clientId && bot.paypal_env === 'sandbox';
  if (ownKeys && !sameApp && bot.paypal_webhook_id) {
    await deleteOldWebhook(id, bot);
  }
  const webhook: WebhookOutcome = await registerWebhook(
    client,
    webhookOrigin(),
    id,
    sameApp ? bot.paypal_webhook_id : null,
  );
  // Local dev shares the demo database: a same-app re-save from an origin PayPal cannot reach
  // (http, or none) must not wipe the id production registered. registerWebhook returned before
  // asking PayPal anything. Only a client id change or DELETE clears a stored id.
  const keepStored =
    sameApp &&
    Boolean(bot.paypal_webhook_id) &&
    !webhook.registered &&
    (webhook.reason === 'https_required' || webhook.reason === 'no_base_url');

  return await save(
    id,
    {
      paypal_client_id: parsed.clientId,
      paypal_secret_encrypted: encryptedSecret,
      paypal_secret_last4: secretLast4(parsed.secret),
      paypal_env: 'sandbox',
      paypal_verified_at: new Date().toISOString(),
      paypal_failed_at: null,
      paypal_failed_reason: null,
      paypal_scopes: verified.scopes.length ? verified.scopes : null,
      paypal_webhook_id: webhook.registered ? webhook.id : keepStored ? bot.paypal_webhook_id : null,
    },
    webhook,
  );
}

/** Limits and switches only, partial. Read by payment_action_open_refund at execution time. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await readObject(req);
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const parsed = parseLimitsPatch(body);
  if (!parsed.ok) {
    return NextResponse.json(parsed.field ? { error: parsed.code, field: parsed.field } : { error: parsed.code }, { status: 400 });
  }

  const bot = await loadPayPalSettings(id);
  if (!bot) return NextResponse.json({ error: 'bot_not_found' }, { status: 404 });

  return await save(id, parsed.values);
}

/**
 * Disconnect. The registered webhook is deleted with the saved keys first (best effort: a 404 or a
 * PayPal outage does not block the disconnect), then keys, check results and the webhook id are
 * cleared. Limits and switches stay. A demo bot falls back to the deployment keys (demo_default).
 * A webhook id stored without own keys (the demo bot's) is left alone — it is not these keys'.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const bot = await loadPayPalSettings(id);
  if (!bot) return NextResponse.json({ error: 'bot_not_found' }, { status: 404 });

  const ownKeys = Boolean(bot.paypal_client_id && bot.paypal_secret_encrypted);
  if (ownKeys && bot.paypal_webhook_id) await deleteOldWebhook(id, bot);

  return await save(id, {
    paypal_client_id: null,
    paypal_secret_encrypted: null,
    paypal_secret_last4: null,
    paypal_env: 'sandbox',
    paypal_verified_at: null,
    paypal_failed_at: null,
    paypal_failed_reason: null,
    paypal_scopes: null,
    ...(ownKeys ? { paypal_webhook_id: null } : {}),
  });
}

/**
 * Best effort: delete the stored webhook with the saved keys. Never blocks the caller — an
 * unreadable secret, a missing encryption key (CryptoKeyError) or a hand-edited live row without
 * PAYPAL_ALLOW_LIVE only skips the delete.
 */
async function deleteOldWebhook(id: string, bot: PayPalSettingsRow): Promise<void> {
  if (!bot.paypal_webhook_id) return;
  try {
    const client = savedKeysClient(bot);
    if (client) await deleteWebhookQuietly(client, bot.paypal_webhook_id);
  } catch (err) {
    console.warn(`[paypal-settings] webhook delete skipped for ${id}:`, (err as Error).name);
  }
}

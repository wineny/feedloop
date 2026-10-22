// Bot settings › PayPal › "Retry webhook" — registers the bot's webhook again with its saved keys.
//
// For the case the key save could not register one (http origin in local dev, a PayPal hiccup).
// Owner only, same rate limit as the key save (it sends requests to PayPal). A stored webhook id is
// kept only if PayPal still lists it for this bot's listener URL; otherwise a new one is registered.
// When PayPal rejects the saved keys (401), that is recorded as
// paypal_failed_at / paypal_failed_reason='invalid_credentials' so the tab shows `failed`.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { assertLiveAllowed } from '@/lib/paypal/env';
import {
  loadPayPalSettings,
  paypalCheckRateExceeded,
  presentPayPalSettings,
  presentWithWebhook,
  registerWebhook,
  savedKeysClient,
  updatePayPalSettings,
  webhookOrigin,
} from '@/lib/paypal/settings';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const bot = await loadPayPalSettings(id);
  if (!bot) return NextResponse.json({ error: 'bot_not_found' }, { status: 404 });

  // The demo bot on deployment keys has its webhook managed by `npm run paypal:webhook`.
  if (!bot.paypal_client_id || !bot.paypal_secret_encrypted) {
    return NextResponse.json({ error: 'not_connected' }, { status: 400 });
  }
  if (paypalCheckRateExceeded(auth.userId)) {
    return NextResponse.json({ error: 'too_many_checks' }, { status: 429 });
  }

  try {
    assertLiveAllowed(bot.paypal_env !== 'live');
  } catch {
    return NextResponse.json({ error: 'live_not_allowed' }, { status: 400 });
  }
  let client;
  try {
    client = savedKeysClient(bot);
  } catch (err) {
    // CryptoKeyError: the server's encryption key is missing or malformed — a deployment problem.
    console.error(`[paypal-settings] saved keys unreadable for ${id}:`, (err as Error).name);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  // Saved secret no longer decrypts (encryption key rotated): only re-entering the keys fixes it.
  if (!client) return NextResponse.json({ error: 'secret_unreadable' }, { status: 409 });

  const webhook = await registerWebhook(client, webhookOrigin(), id, bot.paypal_webhook_id);
  if (webhook.registered) {
    if (webhook.id === bot.paypal_webhook_id) return NextResponse.json(presentPayPalSettings(bot));
    const row = await updatePayPalSettings(id, { paypal_webhook_id: webhook.id });
    if (!row) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    return NextResponse.json(presentPayPalSettings(row));
  }
  if (webhook.reason === 'invalid_credentials') {
    const row = await updatePayPalSettings(id, {
      paypal_failed_at: new Date().toISOString(),
      paypal_failed_reason: 'invalid_credentials',
    });
    if (!row) return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    return NextResponse.json(presentWithWebhook(row, webhook));
  }
  return NextResponse.json(presentWithWebhook(bot, webhook));
}

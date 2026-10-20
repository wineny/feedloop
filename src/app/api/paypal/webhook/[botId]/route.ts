// POST /api/paypal/webhook/[botId] — PayPal webhook listener, one URL per bot (design v2 §6).
//
// Same shape as the GitHub webhook route:
//  1. Raw body, 2 MB cap. The signature covers the original bytes (crc32), so we never re-serialise.
//  2. Bad or missing signature → 401 and nothing else happens.
//  3. Dedupe on paypal_webhook_events.event_id (PK). A redelivery of a finished event is a no-op;
//     a redelivery of one that failed half-way runs again (handlers are idempotent).
//  4. Handlers re-read the resource from PayPal and only write state.
//  5. Handler failure → 500 so PayPal retries (it does, for up to 3 days).
//  6. The widget IP limit applies: unsigned requests still cost a bot lookup and a cert check.

import { NextRequest, NextResponse } from 'next/server';
import { checkReadRate, isUuid } from '@/lib/widget/http';
import { resolvePayPalBot } from '@/lib/paypal/bot';
import { describeError } from '@/lib/paypal/checkout';
import { supabasePaymentsStore } from '@/lib/paypal/store';
import {
  handleWebhookEvent,
  parseWebhookEvent,
  readTransmissionHeaders,
  verifyTransmission,
  webhookIdsFor,
} from '@/lib/paypal/webhook';

export const dynamic = 'force-dynamic';

const BODY_MAX = 2 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  if (!isUuid(botId)) return NextResponse.json({ error: 'unknown bot' }, { status: 404 });
  if (checkReadRate(req)) return NextResponse.json({ error: 'too many requests' }, { status: 429 });

  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > BODY_MAX) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > BODY_MAX) return NextResponse.json({ error: 'payload too large' }, { status: 413 });

  const transmission = readTransmissionHeaders(req.headers);
  if (!transmission) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

  const resolved = await resolvePayPalBot(botId);
  if (!resolved.ok) return NextResponse.json({ error: 'unknown bot' }, { status: 404 });
  const { bot } = resolved;
  if (!bot.webhookId) return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });

  const verified = await verifyTransmission({
    headers: transmission,
    raw,
    webhookIds: webhookIdsFor(bot.webhookId, { sandbox: bot.sandbox }),
    sandbox: bot.sandbox,
  });
  if (!verified) return NextResponse.json({ error: 'bad signature' }, { status: 401 });

  const event = parseWebhookEvent(raw);
  if (!event) return NextResponse.json({ error: 'invalid event' }, { status: 400 });

  const store = supabasePaymentsStore();
  try {
    const seen = await store.insertWebhookEvent({
      event_id: event.id,
      bot_id: botId,
      event_type: event.event_type,
      resource_type: event.resource_type ?? null,
      resource_id: typeof event.resource?.id === 'string' ? event.resource.id : null,
      payload: event,
    });
    if (!seen.inserted && seen.processed) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch (err) {
    console.error('[paypal-webhook] event insert failed', { eventId: event.id, message: (err as Error).message });
    return NextResponse.json({ error: 'store failed' }, { status: 500 });
  }

  try {
    const outcome = await handleWebhookEvent({ store, paypal: bot.client }, botId, event);
    await store.finishWebhookEvent(event.id, null);
    console.log('[paypal-webhook]', { eventId: event.id, type: event.event_type, outcome });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    const info = describeError(err);
    console.error('[paypal-webhook] handler failed', { eventId: event.id, type: event.event_type, ...info });
    await store.finishWebhookEvent(event.id, String(info.message ?? 'handler failed').slice(0, 500)).catch(() => {});
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }
}

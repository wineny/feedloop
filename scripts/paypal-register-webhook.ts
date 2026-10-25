// Registers the demo bot's webhook listener with the PayPal sandbox app and prints its id.
//
//   npx tsx scripts/paypal-register-webhook.ts [--url https://feedloop-demo.vercel.app] [--bot <botId>] [--dry-run]
//
// Defaults: --url = WEBHOOK_BASE_URL, else NEXTAUTH_URL; --bot = the demo bot (bots.is_demo). Idempotent — if PayPal
// already has a webhook for the same URL, it prints that one's id (updating its event list if it changed).
// Put the printed id in PAYPAL_WEBHOOK_ID (.env.local, and the deployment's env).
// The webhook id is not a secret; the client id/secret used here are never printed.

import * as dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PayPalApiError, paypalClientFromEnv } from '../src/lib/paypal/client';
import { PAYPAL_WEBHOOK_EVENT_TYPES } from '../src/lib/paypal/settings';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const EVENT_TYPES = PAYPAL_WEBHOOK_EVENT_TYPES;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Webhook {
  id: string;
  url: string;
  event_types: { name: string }[];
}

async function demoBotId(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or pass --bot)');
  const { data, error } = await createClient(url, key).from('bots').select('id').eq('is_demo', true).maybeSingle();
  if (error || !data) throw new Error(`demo bot not found: ${error?.message ?? 'run npm run db:seed-demo'}`);
  return data.id as string;
}

async function main() {
  const origin = new URL(arg('url') ?? (process.env.WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL) ?? '').origin;
  if (!origin.startsWith('https://')) {
    throw new Error(`PayPal only delivers to https URLs; got ${origin}. Pass --url https://…`);
  }
  const botId = arg('bot') ?? (await demoBotId());
  const listener = `${origin}/api/paypal/webhook/${botId}`;
  console.log(`listener: ${listener}`);
  console.log(`events:   ${EVENT_TYPES.join(', ')}`);
  if (process.argv.includes('--dry-run')) return;

  const client = paypalClientFromEnv();
  const existing = await client.request<{ webhooks: Webhook[] }>('GET', '/v1/notifications/webhooks');
  const same = existing.webhooks.find((w) => w.url === listener);
  if (same) {
    const have = same.event_types.map((e) => e.name).sort().join(',');
    if (have !== [...EVENT_TYPES].sort().join(',')) {
      await client.request('PATCH', `/v1/notifications/webhooks/${encodeURIComponent(same.id)}`, {
        body: [{ op: 'replace', path: '/event_types', value: EVENT_TYPES.map((name) => ({ name })) }],
      });
      console.log(`already registered — event types updated`);
    } else {
      console.log(`already registered`);
    }
    console.log(`PAYPAL_WEBHOOK_ID=${same.id}`);
    return;
  }
  const created = await client.request<Webhook>('POST', '/v1/notifications/webhooks', {
    body: { url: listener, event_types: EVENT_TYPES.map((name) => ({ name })) },
  });
  console.log(`created`);
  console.log(`PAYPAL_WEBHOOK_ID=${created.id}`);
}

main().catch((e) => {
  if (e instanceof PayPalApiError) {
    console.error(`register failed: ${e.status} ${e.paypalName ?? ''} ${e.message} ${e.debugId ?? ''}`);
  } else {
    console.error(`register failed: ${(e as Error).message}`);
  }
  process.exit(1);
});

// Seeds (or refreshes) the ONE demo bot: Feedloop's own support widget for the PayPal AI Hackathon.
//
//   npx tsx scripts/seed-demo.ts --owner you@example.com [--url https://feedloop.vercel.app]
//
// Idempotent — re-running updates the same row (bots.is_demo is unique) and upserts the three
// one-time products the pricing page sells. Judges never run this; the hosted demo is already
// seeded. Self-hosters run it once after `supabase/schema.sql`.
//
// What it deliberately does NOT do: embed the widget (that happens when /pricing ships) or set
// any PayPal credentials (the demo bot uses the deployment-wide PAYPAL_* env until a per-bot key
// is saved in settings).

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ownerEmail = arg('owner') ?? process.env.DEMO_OWNER_EMAIL;
const appUrl = arg('url') ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ownerEmail) {
  console.error('Missing --owner <email> (the Google account that will own the demo bot).');
  process.exit(1);
}
if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const db = createClient(supabaseUrl, serviceKey);

// Public demo = platform LLM key = our money. Tool loops cost 4–5× a plain reply, so the cap is
// far below the 2000/day the Korean demo bot had. `daily_reply_limit` wins over every other limit.
const DEMO_DAILY_REPLY_LIMIT = 300;

const KNOWLEDGE = `Feedloop is a support agent you embed on your site. It answers visitors, groups the same complaint from many people, and can open a pull request that fixes the root cause.

Pricing (one-time, USD): Starter $9, Pro $29, Agency $79. Payment is through PayPal (sandbox during the hackathon — no real money moves).

Refund policy: refunds of $20 or less within 14 days of purchase are processed automatically after the payment is verified. Anything above that, or a second refund for the same customer within 30 days, is sent to an operator for approval. To verify a payment the visitor must provide the PayPal order ID and the email used at checkout.

Disputes: if a PayPal dispute is opened, an operator reviews it in the inbox.

Support hours: the bot answers 24/7; operators review approvals during business hours (UTC+9).`;

const PRODUCTS = [
  { sku: 'starter', name: 'Starter', description: 'One site, one bot, 100 AI replies a day.', amount_cents: 900, sort_order: 1 },
  { sku: 'pro', name: 'Pro', description: 'Three sites, auto-grouping and fix PRs.', amount_cents: 2900, sort_order: 2 },
  { sku: 'agency', name: 'Agency', description: 'Ten sites, approvers, priority support.', amount_cents: 7900, sort_order: 3 },
];

async function main() {
  // 1. owner (same upsert the NextAuth signIn callback does, so the first real login just matches)
  const { data: owner, error: ownerErr } = await db
    .from('users')
    .upsert({ email: ownerEmail }, { onConflict: 'email' })
    .select('id, email')
    .single();
  if (ownerErr || !owner) throw new Error(`owner upsert failed: ${ownerErr?.message}`);

  // 2. the demo bot — find by flag, else insert
  const { data: existing, error: findErr } = await db.from('bots').select('id').eq('is_demo', true).maybeSingle();
  if (findErr) throw new Error(`demo lookup failed: ${findErr.message}`);

  const botValues = {
    user_id: owner.id,
    platform: 'web',
    bot_token_encrypted: 'kakao-no-token', // bots.bot_token_encrypted is NOT NULL (Telegram-era schema); web bots use this placeholder
    service_name: 'Feedloop',
    service_description: 'Support agent that settles payments with PayPal',
    service_url: appUrl,
    github_repo_url: 'https://github.com/wineny/feedloop',
    pr_mode: 'approve',
    status: 'active',
    is_demo: true,
    knowledge_text: KNOWLEDGE,
    knowledge_updated_at: new Date().toISOString(),
    daily_reply_limit: DEMO_DAILY_REPLY_LIMIT,
    currency: 'USD',
    refund_auto_max_cents: 2000,
    refund_auto_days: 14,
    refund_daily_cap_cents: 10000,
    refund_per_customer_30d: 1,
    propose_only: false,
  };

  let botId: string;
  if (existing) {
    const { error } = await db.from('bots').update(botValues).eq('id', existing.id);
    if (error) throw new Error(`demo update failed: ${error.message}`);
    botId = existing.id;
    console.log(`updated demo bot ${botId}`);
  } else {
    const { data, error } = await db.from('bots').insert(botValues).select('id').single();
    if (error || !data) throw new Error(`demo insert failed: ${error?.message}`);
    botId = data.id;
    console.log(`created demo bot ${botId}`);
  }

  // 3. products (the only place prices live)
  const rows = PRODUCTS.map((p) => ({ ...p, bot_id: botId, currency: 'USD', active: true }));
  const { error: prodErr } = await db.from('products').upsert(rows, { onConflict: 'bot_id,sku' });
  if (prodErr) throw new Error(`products upsert failed: ${prodErr.message}`);
  console.log(`upserted ${rows.length} products`);

  console.log(`owner ${owner.email} · widget config: ${appUrl}/api/widget/${botId}/config`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

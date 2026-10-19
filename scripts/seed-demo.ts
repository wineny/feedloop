// Seeds (or refreshes) the ONE demo bot: Feedloop's own support widget for the PayPal AI Hackathon.
//
//   npx tsx scripts/seed-demo.ts --owner you@example.com [--url https://feedloop.vercel.app]
//     [--force-owner]       hand an existing demo bot to a different owner (refused otherwise —
//                           a typo in --owner must not make a stranger owner of the public bot)
//     [--reset-knowledge]   overwrite knowledge_text with the template (kept as edited otherwise)
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
import { KAKAO_TOKEN_PLACEHOLDER } from '../src/lib/bot/kakao-placeholder';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Lower-cased: users.email is matched exactly by the upsert, and Google reports addresses in lower case.
const ownerEmailArg = (arg('owner') ?? process.env.DEMO_OWNER_EMAIL)?.trim().toLowerCase();
const forceOwner = process.argv.includes('--force-owner');
const resetKnowledge = process.argv.includes('--reset-knowledge');
const appUrl = arg('url') ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ownerEmailArg) {
  console.error('Missing --owner <email> (the Google account that will own the demo bot).');
  process.exit(1);
}
// main() is a hoisted declaration, so the guard above does not narrow inside it; pin the type here.
const ownerEmail: string = ownerEmailArg;
if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const db = createClient(supabaseUrl, serviceKey);

// Public demo = platform LLM key = our money. Tool loops cost 4–5× a plain reply, so the cap is
// far below the 2000/day the Korean demo bot had. `daily_reply_limit` wins over every other limit.
const DEMO_DAILY_REPLY_LIMIT = 300;

// One source for the numbers: the bot row, the guardrail defaults (20261019_01) and the text the
// bot reads from all come from here, so they cannot drift apart.
const REFUND_POLICY = {
  autoMaxCents: 2000,
  autoDays: 14,
  dailyCapCents: 10000,
  perCustomer30d: 1,
} as const;

const PRODUCTS = [
  { sku: 'starter', name: 'Starter', description: 'One site, one bot, 100 AI replies a day.', amount_cents: 900, sort_order: 1 },
  { sku: 'pro', name: 'Pro', description: 'Three sites, auto-grouping and fix PRs.', amount_cents: 2900, sort_order: 2 },
  { sku: 'agency', name: 'Agency', description: 'Ten sites, approvers, priority support.', amount_cents: 7900, sort_order: 3 },
];

const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const KNOWLEDGE = `Feedloop is a support agent you embed on your site. It answers visitors, groups the same complaint from many people, and can open a pull request that fixes the root cause.

Pricing (one-time, USD): ${PRODUCTS.map((p) => `${p.name} ${usd(p.amount_cents)}`).join(', ')}. Payment is through PayPal (sandbox during the hackathon — no real money moves).

Refund policy: refunds of ${usd(REFUND_POLICY.autoMaxCents)} or less within ${REFUND_POLICY.autoDays} days of purchase are processed automatically after the payment is verified. Anything above that, or more than ${REFUND_POLICY.perCustomer30d} refund for the same customer within 30 days, is sent to an operator for approval. To verify a payment the visitor must provide the PayPal order ID and the email used at checkout.

Disputes: if a PayPal dispute is opened, an operator reviews it in the inbox.

Support hours: the bot answers 24/7; operators review approvals during business hours (UTC+9).`;

async function main() {
  // 1. the demo bot — find by flag (checked BEFORE touching users, so a refused run leaves no stray row)
  const { data: existing, error: findErr } = await db
    .from('bots')
    .select('id, user_id')
    .eq('is_demo', true)
    .maybeSingle();
  if (findErr) throw new Error(`demo lookup failed: ${findErr.message}`);

  let currentOwnerEmail: string | null = null;
  if (existing) {
    const { data: cur, error: curErr } = await db.from('users').select('email').eq('id', existing.user_id).maybeSingle();
    if (curErr) throw new Error(`owner lookup failed: ${curErr.message}`);
    currentOwnerEmail = cur?.email ?? null;
  }
  const sameOwner = Boolean(existing) && currentOwnerEmail?.toLowerCase() === ownerEmail;
  if (existing && !sameOwner && !forceOwner) {
    throw new Error(
      `demo bot ${existing.id} already has a different owner. Re-run with --force-owner to hand it to ${ownerEmail}.`,
    );
  }

  // 2. owner. Reuse the current owner row when it already matches (a second upsert with a different
  // email casing would create a duplicate user and silently move the bot to it). Otherwise the same
  // upsert the NextAuth signIn callback does, so the first real login just matches.
  let owner: { id: string; email: string };
  if (existing && sameOwner) {
    owner = { id: existing.user_id, email: currentOwnerEmail ?? ownerEmail };
  } else {
    const { data, error: ownerErr } = await db
      .from('users')
      .upsert({ email: ownerEmail }, { onConflict: 'email' })
      .select('id, email')
      .single();
    if (ownerErr || !data) throw new Error(`owner upsert failed: ${ownerErr?.message}`);
    owner = data;
  }

  const botValues = {
    user_id: owner.id,
    platform: 'web',
    bot_token_encrypted: KAKAO_TOKEN_PLACEHOLDER, // bots.bot_token_encrypted is NOT NULL (Telegram-era schema); web bots use this placeholder
    service_name: 'Feedloop',
    service_description: 'Support agent that settles payments with PayPal',
    service_url: appUrl,
    github_repo_url: 'https://github.com/wineny/feedloop',
    pr_mode: 'approve',
    status: 'active',
    is_demo: true,
    daily_reply_limit: DEMO_DAILY_REPLY_LIMIT,
    currency: 'USD',
    refund_auto_max_cents: REFUND_POLICY.autoMaxCents,
    refund_auto_days: REFUND_POLICY.autoDays,
    refund_daily_cap_cents: REFUND_POLICY.dailyCapCents,
    refund_per_customer_30d: REFUND_POLICY.perCustomer30d,
    propose_only: false,
  };
  const knowledgeValues = { knowledge_text: KNOWLEDGE, knowledge_updated_at: new Date().toISOString() };

  let botId: string;
  if (existing) {
    // Operators edit the knowledge in the UI; a re-seed must not silently throw that away.
    const values = resetKnowledge ? { ...botValues, ...knowledgeValues } : botValues;
    const { error } = await db.from('bots').update(values).eq('id', existing.id);
    if (error) throw new Error(`demo update failed: ${error.message}`);
    botId = existing.id;
    console.log(`updated demo bot ${botId}`);
  } else {
    const { data, error } = await db.from('bots').insert({ ...botValues, ...knowledgeValues }).select('id').single();
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

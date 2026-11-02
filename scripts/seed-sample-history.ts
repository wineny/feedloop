// Fills the ONE demo bot (bots.is_demo) with ~60 days of DECIDED sample refund history, so the dashboard
// (refund reasons + spike, triage badges) and the approval card's precedent line have something to show.
//
//   npx tsx scripts/seed-sample-history.ts                 dry run: builds the rows and prints counts. Offline —
//                                                          no database connection, nothing written.
//   npx tsx scripts/seed-sample-history.ts --yes           inserts them into the demo bot
//   npx tsx scripts/seed-sample-history.ts --remove        counts the sample rows in the demo bot (read only)
//   npx tsx scripts/seed-sample-history.ts --remove --yes  deletes only the sample rows
//
// What the rows are and the safety rules they follow: src/lib/demo/sample-history.ts (header). In short:
// final states only (executed / rejected), `SAMPLE-` capture and refund ids (refund.ts never sends those to
// PayPal), every action already «announced», no customer key, nothing executed in the last 24 h, no orders /
// verifications / webhook events / auto-dev runs / responses, messages already classified, insights already
// grouped and groups already scored.
//
// Seed it, then record within ~20 h: the coupon «Spike» rows are 1–4 h before the moment of seeding and the
// badge needs 3 of them inside the last 24 h.
// Dashboard numbers include these rows (badged «Sample» in the ledger). `--remove --yes` takes them out again;
// `npm run db:reset-demo -- --yes` also deletes them (they are demo-bot rows like any other).
//
// --yes is refused when sample rows already exist (run --remove --yes first) or when the demo bot's
// pr_mode is 'auto' (the auto-PR cron would open PRs for the sample groups). Every write is scoped
// `bot_id = <demo bot>`. If an insert fails half way, the rows written so far are removed again.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { buildSampleHistory, type SampleHistory } from '../src/lib/demo/sample-history';
import { SAMPLE_REF_PREFIX, SAMPLE_VISITOR_PREFIX } from '../src/lib/demo/sample-marker';

const confirmed = process.argv.includes('--yes');
const remove = process.argv.includes('--remove');
const SAMPLE_TARGET_LIKE = `${SAMPLE_REF_PREFIX}%`;
const SAMPLE_VISITOR_LIKE = `${SAMPLE_VISITOR_PREFIX}%`;

type DemoBot = { id: string; service_name: string; pr_mode: string };

const pad = (s: string) => s.padEnd(24);

function printPlan(h: SampleHistory, now: number) {
  const day = 24 * 60 * 60_000;
  const executed = h.actions.filter((a) => a.status === 'executed');
  const rows: [string, number, string][] = [
    ['conversations', h.conversations.length, `web, external_user_id ${SAMPLE_VISITOR_PREFIX}visitor-NN`],
    ['messages', h.messages.length, "visitor turns, classification_state 'done'"],
    ['insight_groups', h.groups.length, h.groups.map((g) => `${g.triage}: ${g.title}`).join(' | ')],
    ['insights', h.insights.length, `${h.insights.filter((i) => i.group_id).length} grouped`],
    [
      'payment_actions',
      h.actions.length,
      `refunds: ${executed.filter((a) => a.origin === 'auto').length} auto, ${executed.filter((a) => a.origin === 'approval').length} approved, ` +
        `${h.actions.filter((a) => a.status === 'rejected').length} rejected; ` +
        `${h.actions.filter((a) => Date.parse(a.created_at) > now - day).length} in the last 24 h (all rejected)`,
    ],
    ['payment_announcements', h.announcements.length, 'one per action (suppressed: response_id NULL)'],
  ];
  for (const [table, n, what] of rows) console.log(`  ${pad(table)}${String(n).padStart(4)}  ${what}`);
}

function isMissingTriageColumn(error: { code?: string; message: string }): boolean {
  return /triage/i.test(error.message) && (error.code === 'PGRST204' || error.code === '42703' || /column/i.test(error.message));
}

async function findDemoBot(db: SupabaseClient): Promise<DemoBot> {
  const { data, error } = await db.from('bots').select('id, service_name, pr_mode').eq('is_demo', true).maybeSingle();
  if (error) throw new Error(`demo lookup failed: ${error.message}`);
  if (!data) throw new Error('No demo bot found (bots.is_demo = true). Run `npm run db:seed-demo` first.');
  return data as DemoBot;
}

async function count(db: SupabaseClient, table: string, botId: string, column: string, like: string): Promise<number> {
  const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq('bot_id', botId).like(column, like);
  if (error) throw new Error(`count ${table} failed: ${error.message}`);
  return n ?? 0;
}

async function insert(db: SupabaseClient, table: string, rows: object[]): Promise<void> {
  const { error } = await db.from(table).insert(rows);
  if (error) throw new Error(`insert ${table} failed: ${error.message}`);
  console.log(`  ${pad(table)}${String(rows.length).padStart(4)}`);
}

async function seed(db: SupabaseClient, bot: DemoBot): Promise<void> {
  if (bot.pr_mode === 'auto') {
    throw new Error("refused: the demo bot's pr_mode is 'auto' — the auto-PR cron would open PRs for the sample groups.");
  }
  const existing =
    (await count(db, 'conversations', bot.id, 'external_user_id', SAMPLE_VISITOR_LIKE)) +
    (await count(db, 'payment_actions', bot.id, 'target_id', SAMPLE_TARGET_LIKE));
  if (existing > 0) throw new Error('refused: sample rows already exist in the demo bot. Run with --remove --yes first.');

  const now = Date.now();
  const h = buildSampleHistory({ botId: bot.id, now });
  console.log('Inserting:');
  try {
    await insert(db, 'conversations', h.conversations);
    await insert(db, 'messages', h.messages);
    const { error } = await db.from('insight_groups').insert(h.groups);
    if (error && isMissingTriageColumn(error)) {
      await insert(db, 'insight_groups', h.groups.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'triage' && k !== 'triage_reason'))));
      console.log('  (insight_groups.triage columns missing — migration 20261102_01 not applied; inserted without triage)');
    } else if (error) {
      throw new Error(`insert insight_groups failed: ${error.message}`);
    } else {
      console.log(`  ${pad('insight_groups')}${String(h.groups.length).padStart(4)}  (with triage)`);
    }
    await insert(db, 'insights', h.insights);
    await insert(db, 'payment_actions', h.actions);
    await insert(db, 'payment_announcements', h.announcements);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error('Removing the sample rows written so far…');
    await removeSample(db, bot, true, h.groups.map((g) => g.id));
    throw new Error('seed failed; sample rows removed.');
  }
  console.log('Done. Remove later with: npx tsx scripts/seed-sample-history.ts --remove --yes');
}

/**
 * Deletes only sample rows, all scoped to the demo bot: refunds with a SAMPLE- capture (announcements cascade),
 * then sample conversations (web, `sample-` visitor; messages → insights → insight_message_sources cascade), then the groups those
 * insights were in — only if no insight is left in them (real feedback may have joined a sample group).
 */
async function removeSample(db: SupabaseClient, bot: DemoBot, apply: boolean, knownGroupIds: string[] = []): Promise<void> {
  const convRes = await db.from('conversations').select('id').eq('bot_id', bot.id).eq('source', 'web').like('external_user_id', SAMPLE_VISITOR_LIKE).limit(1000);
  if (convRes.error) throw new Error(`sample conversations lookup failed: ${convRes.error.message}`);
  const convIds = (convRes.data ?? []).map((r) => r.id as string);
  // knownGroupIds: a failed seed's own groups — its insights may not have been written yet.
  let groupIds: string[] = [...knownGroupIds];
  if (convIds.length > 0) {
    const msgRes = await db.from('messages').select('id').eq('bot_id', bot.id).in('conversation_id', convIds).limit(5000);
    if (msgRes.error) throw new Error(`sample messages lookup failed: ${msgRes.error.message}`);
    const msgIds = (msgRes.data ?? []).map((r) => r.id as string);
    if (msgIds.length > 0) {
      const insRes = await db.from('insights').select('group_id').eq('bot_id', bot.id).in('message_id', msgIds).limit(5000);
      if (insRes.error) throw new Error(`sample insights lookup failed: ${insRes.error.message}`);
      const found = (insRes.data ?? []).map((r) => r.group_id as string | null).filter((id): id is string => Boolean(id));
      groupIds = [...new Set([...groupIds, ...found])];
    }
  }
  const actions = await count(db, 'payment_actions', bot.id, 'target_id', SAMPLE_TARGET_LIKE);
  console.log(`${apply ? 'Deleting' : 'Would delete'} (demo bot ${bot.id}):`);
  console.log(`  ${pad('payment_actions')}${String(actions).padStart(4)}  target_id LIKE '${SAMPLE_TARGET_LIKE}' (+ announcements)`);
  console.log(`  ${pad('conversations')}${String(convIds.length).padStart(4)}  source 'web', external_user_id LIKE '${SAMPLE_VISITOR_LIKE}' (+ messages, insights)`);
  console.log(`  ${pad('insight_groups')}${String(groupIds.length).padStart(4)}  the sample insights' groups, if left empty`);
  if (!apply) {
    console.log('Dry run — nothing was deleted. Re-run with --remove --yes to delete.');
    return;
  }

  const del1 = await db.from('payment_actions').delete({ count: 'exact' }).eq('bot_id', bot.id).like('target_id', SAMPLE_TARGET_LIKE);
  if (del1.error) throw new Error(`delete payment_actions failed: ${del1.error.message}`);
  const del2 = await db.from('conversations').delete({ count: 'exact' }).eq('bot_id', bot.id).eq('source', 'web').like('external_user_id', SAMPLE_VISITOR_LIKE);
  if (del2.error) throw new Error(`delete conversations failed: ${del2.error.message}`);
  let groupsDeleted = 0;
  for (const id of groupIds) {
    const left = await db.from('insights').select('id', { count: 'exact', head: true }).eq('bot_id', bot.id).eq('group_id', id);
    if (left.error) throw new Error(`group ${id} insight count failed: ${left.error.message}`);
    if ((left.count ?? 0) > 0) {
      console.log(`  kept group ${id}: ${left.count} non-sample insight(s) joined it`);
      continue;
    }
    const del = await db.from('insight_groups').delete({ count: 'exact' }).eq('bot_id', bot.id).eq('id', id);
    if (del.error) throw new Error(`delete insight_groups ${id} failed: ${del.error.message}`);
    groupsDeleted += del.count ?? 0;
  }
  console.log(`Deleted: ${del1.count ?? 0} payment_actions, ${del2.count ?? 0} conversations, ${groupsDeleted} insight_groups.`);
}

async function main() {
  if (!remove && !confirmed) {
    const now = Date.now();
    const h = buildSampleHistory({ botId: '00000000-0000-4000-8000-000000000000', now });
    console.log('DRY RUN — offline, no database connection. Rows that WOULD be inserted into the demo bot:');
    printPlan(h, now);
    console.log('All safety invariants passed (src/lib/demo/sample-history.ts). Re-run with --yes to insert.');
    return;
  }

  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  const db = createClient(supabaseUrl, serviceKey);
  const bot = await findDemoBot(db);
  console.log(`${remove ? 'REMOVE' : 'SEED'} — demo bot ${bot.id} (${bot.service_name})`);
  if (remove) await removeSample(db, bot, confirmed);
  else await seed(db, bot);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

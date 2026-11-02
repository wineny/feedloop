// Sample refund history for the ONE demo bot (scripts/seed-sample-history.ts writes it; nothing here touches a
// database). Pure: `buildSampleHistory` returns rows, `assertSampleHistory` throws when any safety rule below is
// broken — the builder calls it before returning, so the script can never insert a row that breaks one.
//
// What it builds (≈60 days, 30 refund requests, all decided):
//   conversations (web, `sample-visitor-NN`) → messages (2 visitor turns each) → 3 insight groups → insights →
//   payment_actions (refunds) → payment_announcements.
//   Groups cover every triage verdict: coupon bug → fix, CSV export → needs_decision, price → wont_fix.
//   The coupon group has 4 requests in the last 24 h and none in the 7 days before → the dashboard Spike badge.
//   Dashboard numbers (refund reasons, auto refunds in 7 days) INCLUDE these rows; the ledger badges them
//   «Sample»; `--remove` deletes them again.
//
// Safety rules (see .omc/plans/autopilot-impl.md «Safety review»):
//   1. Final states only: executed (auto or after approval) or rejected. Never pending / executing / unknown,
//      so no Approve button and no reconciliation ever sees them (refund.ts also refuses SAMPLE- ids).
//   2. target_id `SAMPLE-CAP-…`, paypal_ref `SAMPLE-REF-…` — real PayPal ids never contain '-'.
//   3. Every action has a payment_announcements row for its status (response_id NULL = suppressed), so the
//      reaper never writes a payment sentence into a sample conversation.
//   4. customer_key NULL, and every row created in the last 24 h is `rejected`: the live daily cap (UTC day)
//      and the per-customer cap only count executing/unknown/executed rows → zero effect on real refunds.
//   5. No paypal_orders, payment_verifications or webhook events (visitor tools would read PayPal with them).
//   6. messages.classification_state = 'done' (the classifier would send them to the LLM).
//   7. Every groupable insight (bug/ux/feature_request) has a group_id (auto-grouping would call the LLM), and
//      every group already has impact_core (impact scoring would call the LLM).
//   8/9. No auto_dev_runs; the script refuses a demo bot with pr_mode = 'auto'.
// No responses rows either: a response row starts with email_delivery_status = 'pending'.

import { SAMPLE_REF_PREFIX, SAMPLE_VISITOR_PREFIX, isSampleRef, isSampleVisitor } from './sample-marker';

export const SAMPLE_HISTORY_DAYS = 60;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const CURRENCY = 'USD';

/** The demo bot's products (scripts/seed-demo.ts) and its auto-refund limit ($20 → only Starter refunds auto). */
const PRICE_CENTS = { starter: 900, pro: 2900, agency: 7900 } as const;
type Product = keyof typeof PRICE_CENTS;

export type SampleTriage = 'fix' | 'wont_fix' | 'needs_decision';
const TRIAGE_VALUES: readonly SampleTriage[] = ['fix', 'wont_fix', 'needs_decision'];
const GROUPABLE = new Set(['bug', 'ux', 'feature_request']);

/** The guardrail RPC's check keys (payment_action_open_refund v2). */
const CHECK_KEYS = [
  'amount_within_max',
  'within_days',
  'no_prior_refund',
  'currency_matches',
  'daily_cap_ok',
  'customer_known',
  'customer_cap_ok',
  'no_dispute',
  'not_propose_only',
  'not_paused',
] as const;

// ── rows (column names = the tables'; every row of a table has the same keys — one bulk insert) ─────────────

export interface SampleConversationRow {
  id: string;
  bot_id: string;
  source: 'web';
  external_user_id: string;
  contact_name: string;
  status: 'open';
  locale: 'en';
  last_message_at: string;
  operator_read_at: string;
  created_at: string;
}

export interface SampleMessageRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  source: 'web';
  external_user_id: string;
  author_name: string;
  body: string;
  detected_at: string;
  created_at: string;
  classification_state: 'done';
  classification_next_at: string;
}

export interface SampleGroupRow {
  id: string;
  bot_id: string;
  title: string;
  summary: string;
  category: string;
  status: 'open';
  impact_core: boolean;
  impact_reason: string;
  impact_scored_at: string;
  created_at: string;
  /** insight_groups.triage / triage_reason (migration 20261102_01). The script drops both if the columns are missing. */
  triage: SampleTriage;
  triage_reason: string;
}

export interface SampleInsightRow {
  id: string;
  bot_id: string;
  message_id: string;
  source_message_ids: string[];
  group_id: string | null;
  category: string;
  summary: string;
  sentiment: 'negative' | 'neutral';
  follow_up_needed: false;
  classified_by: 'llm';
  created_at: string;
  updated_at: string;
}

export interface SampleActionRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  kind: 'refund';
  target_id: string;
  amount_cents: number;
  currency: string;
  customer_key: null;
  origin: 'auto' | 'approval';
  status: 'executed' | 'rejected';
  reason: string;
  guardrail: Record<string, boolean>;
  payload: { amount: { value: string; currency_code: string } } | null;
  result: { id: string; status: 'COMPLETED' } | null;
  paypal_ref: string | null;
  error: null;
  decided_by: null;
  decided_at: string | null;
  executed_at: string | null;
  sent_at: string | null;
  send_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface SampleAnnouncementRow {
  action_id: string;
  status: SampleActionRow['status'];
  response_id: null;
  created_at: string;
}

export interface SampleHistory {
  conversations: SampleConversationRow[];
  messages: SampleMessageRow[];
  groups: SampleGroupRow[];
  insights: SampleInsightRow[];
  actions: SampleActionRow[];
  announcements: SampleAnnouncementRow[];
}

// ── the stories ─────────────────────────────────────────────────────────────────────────────────

type GroupKey = 'coupon' | 'export' | 'price';

const GROUPS: Record<GroupKey, Omit<SampleGroupRow, 'id' | 'bot_id' | 'status' | 'impact_scored_at' | 'created_at'>> = {
  coupon: {
    title: 'Coupon code not applied at checkout',
    summary:
      'Customers enter a valid coupon (LAUNCH20, WELCOME10, SPRING15). The pricing page shows it as applied, but the PayPal order is created for the full price, so they ask for a refund instead.',
    category: 'bug',
    impact_core: true,
    impact_reason: 'Checkout charges the wrong amount.',
    triage: 'fix',
    triage_reason: 'Checkout drops a valid discount and charges full price. It is broken and costs refunds.',
  },
  export: {
    title: 'No CSV export for conversations and insights',
    summary:
      'Customers want to download conversations and insights as CSV (weekly reports, client reports, Google Sheets). There is no export today; several asked for a refund because of it.',
    category: 'feature_request',
    impact_core: false,
    impact_reason: 'Reporting add-on, not the feedback loop itself.',
    triage: 'needs_decision',
    triage_reason: 'A new feature with scope and plan choices (which data, which plans). The owner decides.',
  },
  price: {
    title: 'Price feels too high for small sites',
    summary:
      'Owners of small or hobby sites say the one-time price is more than they expected for a few messages a week.',
    category: 'cs',
    impact_core: false,
    impact_reason: 'Pricing feedback, not a product defect.',
    triage: 'wont_fix',
    triage_reason: 'Pricing works as designed. Nothing in the product is broken.',
  },
};

type Outcome = 'auto' | 'approved' | 'rejected';

interface Story {
  /** Hours before `now` the refund was requested. */
  ago: number;
  product: Product;
  outcome: Outcome;
  group: GroupKey | null;
  /** The ungrouped insight's category (grouped stories use the group's). Never bug/ux/feature_request. */
  category?: 'cs' | 'other';
  name: string;
  /** The visitor's two turns: the problem, then the refund ask. */
  say: [string, string];
  /** payment_actions.reason — what the refund tool recorded. */
  reason: string;
  /** The insight summary (grouped stories: the group's own wording of this report). */
  summary: string;
}

const d = (days: number) => days * 24;

const STORIES: Story[] = [
  // Coupon bug — 4 before the last week, 4 in the last 24 h (the spike; all rejected, see rule 4).
  { ago: d(50), product: 'starter', outcome: 'auto', group: 'coupon', name: 'Maya Chen',
    say: ['Hi, I tried WELCOME10 at checkout and it said "applied", but PayPal still charged me $9.00.', "Can I just get a refund? I'll buy again once the coupon works."],
    reason: 'Coupon WELCOME10 showed as applied but I was charged full price', summary: 'Coupon shows as applied, PayPal charges full price' },
  { ago: d(44), product: 'pro', outcome: 'approved', group: 'coupon', name: 'Daniel Ortiz',
    say: ['The LAUNCH20 code was accepted on the pricing page, but the PayPal window showed $29, not $23.20.', "I paid anyway, but I'd like a refund please. I'll repurchase with the discount."],
    reason: 'LAUNCH20 accepted on the page, PayPal charged $29', summary: 'Discount code accepted on the page but not in the PayPal order' },
  { ago: d(31), product: 'starter', outcome: 'auto', group: 'coupon', name: 'Priya Nair',
    say: ['The promo code box cleared itself when I clicked "Pay with PayPal".', 'I got charged without the discount. Refund please?'],
    reason: 'Promo code cleared when I clicked Pay with PayPal', summary: 'Promo code field resets when PayPal checkout opens' },
  { ago: d(23), product: 'pro', outcome: 'approved', group: 'coupon', name: 'Tom Becker',
    say: ['Checkout ignored my coupon code (SPRING15). The full $29 was charged.', 'Please refund this order so I can pay the right amount.'],
    reason: 'Checkout ignored coupon SPRING15', summary: 'Checkout ignores a valid coupon code' },
  { ago: 15, product: 'agency', outcome: 'rejected', group: 'coupon', name: 'Sofia Rossi',
    say: ["Your LAUNCH20 coupon didn't apply on the Agency plan. I paid the full $79.", 'I want a full refund.'],
    reason: "LAUNCH20 didn't apply on Agency, paid full $79", summary: 'Coupon not applied on the Agency plan' },
  { ago: 9, product: 'agency', outcome: 'rejected', group: 'coupon', name: 'Kenji Watanabe',
    say: ['The coupon code is not working at checkout. It says applied, then PayPal shows the full price.', 'Please refund the whole $79.'],
    reason: 'Coupon says applied, PayPal shows full price', summary: 'Coupon shows as applied, PayPal charges full price' },
  { ago: 5, product: 'agency', outcome: 'rejected', group: 'coupon', name: 'Hannah Moore',
    say: ["Hi, the discount code from your newsletter wasn't applied when I paid.", "I'd like my money back."],
    reason: "Newsletter discount code wasn't applied", summary: 'Newsletter discount code not applied at checkout' },
  { ago: 2, product: 'agency', outcome: 'rejected', group: 'coupon', name: 'Lucas Martin',
    say: ['Is checkout broken for coupons? I entered LAUNCH20 and still paid $79.', 'Refund me please. This is the second time it happened.'],
    reason: 'Entered LAUNCH20, still paid $79', summary: 'Coupon code ignored at checkout, second time' },

  // CSV export — a missing feature.
  { ago: d(52), product: 'pro', outcome: 'approved', group: 'export', name: 'Emma Johansson',
    say: ['Is there a way to export conversations to CSV? I need them for our weekly report.', "If not, I'd like a refund. Export was the main reason I bought Pro."],
    reason: 'Needs CSV export of conversations for a weekly report', summary: 'Wants a CSV export of conversations' },
  { ago: d(40), product: 'agency', outcome: 'approved', group: 'export', name: 'Omar Haddad',
    say: ["We need to export insights to a spreadsheet for our clients. I can't find an export button.", "Without export this doesn't work for our agency. Please refund."],
    reason: 'No export of insights for client reports', summary: 'Agency needs insights exported for client reports' },
  { ago: d(33), product: 'starter', outcome: 'auto', group: 'export', name: 'Grace Kim',
    say: ["Where's the export? I want to move my insights into Notion.", "If there isn't one, please refund."],
    reason: 'No way to export insights to Notion', summary: 'Wants to export insights to another tool' },
  { ago: d(27), product: 'pro', outcome: 'rejected', group: 'export', name: 'Felix Wagner',
    say: ['Can I download the feedback list as a CSV?', "No export means I can't use it. Refund?"],
    reason: 'Wants to download the feedback list as CSV', summary: 'Wants the feedback list as a CSV download' },
  { ago: d(18), product: 'starter', outcome: 'auto', group: 'export', name: 'Aisha Bello',
    say: ["I assumed I could export my data, but there's no CSV option.", 'Please refund my Starter purchase.'],
    reason: 'Expected a CSV export', summary: 'Expected a CSV export of their data' },
  { ago: d(11), product: 'pro', outcome: 'approved', group: 'export', name: 'Noah Williams',
    say: ['Our ops team lives in Google Sheets. Is there any export or API?', "Then I'd like a refund for now, sorry."],
    reason: 'Needs an export or API for Google Sheets', summary: 'Wants an export or API for Google Sheets' },
  { ago: d(4), product: 'agency', outcome: 'approved', group: 'export', name: 'Chloe Dubois',
    say: ['I need a CSV export of all conversations for each client site.', "That's a dealbreaker for us. Can you refund the Agency plan?"],
    reason: 'Needs a CSV export per client site', summary: 'Needs a per-site CSV export of conversations' },

  // Price — works as designed.
  { ago: d(57), product: 'starter', outcome: 'auto', group: 'price', name: 'Ben Carter',
    say: ['Honestly, $9 is more than I expected for one small site.', "I'd like a refund please."],
    reason: 'Too expensive for one small site', summary: 'Price too high for a single small site' },
  { ago: d(42), product: 'agency', outcome: 'rejected', group: 'price', name: 'Isabel Torres',
    say: ['We expected Agency to be cheaper per site.', 'Please refund the full amount.'],
    reason: 'Agency more expensive per site than expected', summary: 'Agency plan feels expensive per site' },
  { ago: d(35), product: 'pro', outcome: 'approved', group: 'price', name: 'Ryan Patel',
    say: ['Pro is too expensive for my side project. I only get a few messages a week.', 'Can I get a refund?'],
    reason: 'Pro too expensive for a side project', summary: 'Pro too expensive for a low-traffic side project' },
  { ago: d(20), product: 'starter', outcome: 'auto', group: 'price', name: 'Lena Fischer',
    say: ["I found a cheaper option that's good enough for my blog.", 'Please refund.'],
    reason: 'Found a cheaper option for my blog', summary: 'Switched to a cheaper tool for a blog' },
  { ago: d(13), product: 'agency', outcome: 'rejected', group: 'price', name: 'Marcus Green',
    say: ['$79 is too much for what we use. We only run two sites.', "Refund the Agency plan and I'll buy Starter."],
    reason: '$79 too much for two sites', summary: 'Agency price too high for two sites' },
  { ago: d(6), product: 'starter', outcome: 'auto', group: 'price', name: 'Julia Novak',
    say: ['The price is a bit high for a hobby site.', 'Refund please, no hard feelings.'],
    reason: 'Price a bit high for a hobby site', summary: 'Price high for a hobby site' },

  // One-off reasons (customer service; not grouped — nothing to build).
  { ago: d(59), product: 'pro', outcome: 'approved', group: null, category: 'cs', name: 'Ethan Brooks',
    say: ['I meant to buy Starter but clicked Pro by mistake.', "Can you refund Pro? I'll buy Starter right after."],
    reason: 'Bought Pro by mistake, wanted Starter', summary: 'Bought the wrong plan (Pro instead of Starter)' },
  { ago: d(55), product: 'starter', outcome: 'auto', group: null, category: 'other', name: 'Mia Lopez',
    say: ['I bought this for my shop, but we closed the online store last week.', 'Refund please.'],
    reason: 'Closed the online store', summary: 'Closed the online store it was bought for' },
  { ago: d(48), product: 'starter', outcome: 'auto', group: null, category: 'cs', name: 'Samuel Adeyemi',
    say: ['I think I paid twice. I got two PayPal receipts for Starter.', 'Please refund one of them.'],
    reason: 'Paid twice for Starter', summary: 'Charged twice for the same plan' },
  { ago: d(38), product: 'agency', outcome: 'approved', group: null, category: 'other', name: 'Olivia Hart',
    say: ['Our team decided to go with another tool.', 'Could you refund the Agency plan? We never installed it.'],
    reason: 'Team chose another tool, never installed', summary: 'Team chose another tool before installing' },
  { ago: d(29), product: 'starter', outcome: 'rejected', group: null, category: 'cs', name: 'Leo Schmidt',
    say: ['I bought this last month and forgot about it.', 'I never used it. Can I get a refund?'],
    reason: 'Bought last month, never used it', summary: 'Asked for a refund weeks after buying; never used it' },
  { ago: d(25), product: 'starter', outcome: 'auto', group: null, category: 'other', name: 'Zara Ahmed',
    say: ['I bought this as a gift for a friend, but it turns out they already have an account.', 'Can I get a refund?'],
    reason: 'Gift; recipient already has an account', summary: 'Gift purchase; the recipient already had an account' },
  { ago: d(16), product: 'agency', outcome: 'approved', group: null, category: 'cs', name: 'Victor Silva',
    say: ['We bought Agency but we only need one site. Wrong plan.', 'Please refund so we can buy Starter instead.'],
    reason: 'Bought Agency, only need one site', summary: 'Bought Agency but only needed one site' },
  { ago: d(9), product: 'starter', outcome: 'auto', group: null, category: 'cs', name: 'Nora Lindqvist',
    say: ['I thought this was a free trial.', "I didn't mean to pay yet. Can I get a refund?"],
    reason: 'Thought it was a free trial', summary: 'Expected a free trial, not a payment' },
  { ago: d(3), product: 'starter', outcome: 'auto', group: null, category: 'other', name: 'Adam Kowalski',
    say: ['The client project I bought this for was cancelled.', 'Refund please.'],
    reason: 'Client project cancelled', summary: 'The client project it was bought for was cancelled' },
];

// ── builder ─────────────────────────────────────────────────────────────────────────────────────

export interface BuildSampleHistoryInput {
  botId: string;
  /** Epoch ms. Every row is placed relative to it (the spike is «the last 24 h» at seed time). */
  now: number;
  idGen?: () => string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ref = (kind: 'CAP' | 'REF', n: number) => `${SAMPLE_REF_PREFIX}${kind}-${String(n).padStart(4, '0')}`;
const centsValue = (cents: number) => (cents / 100).toFixed(2);

/** The guardrail record the RPC would have written: auto = every check passed; approval = the one that failed. */
function guardrailFor(story: Story): Record<string, boolean> {
  const checks = Object.fromEntries(CHECK_KEYS.map((k) => [k, true])) as Record<string, boolean>;
  if (story.outcome === 'auto') return checks;
  // Over the $20 auto limit, or (Starter) bought longer ago than the 14-day window.
  if (PRICE_CENTS[story.product] > 2000) checks.amount_within_max = false;
  else checks.within_days = false;
  return checks;
}

export function buildSampleHistory({ botId, now, idGen = () => globalThis.crypto.randomUUID() }: BuildSampleHistoryInput): SampleHistory {
  const h: SampleHistory = { conversations: [], messages: [], groups: [], insights: [], actions: [], announcements: [] };
  const groupIds = {} as Record<GroupKey, string>;
  const groupFirstAt = {} as Record<GroupKey, number>;
  for (const key of Object.keys(GROUPS) as GroupKey[]) groupIds[key] = idGen();

  STORIES.forEach((story, i) => {
    const n = i + 1;
    const requestedAt = now - story.ago * HOUR_MS;
    const firstAt = requestedAt - 4 * 60_000;
    const askAt = requestedAt - 40_000;
    // Older requests were decided within a few hours; the last day's within ~half an hour.
    const decidedAt = story.outcome === 'auto' ? null : requestedAt + (story.ago > 24 ? (1 + (n % 5)) * HOUR_MS : (20 + (n % 3) * 5) * 60_000);
    const executedAt = story.outcome === 'auto' ? requestedAt + 3_000 : story.outcome === 'approved' ? decidedAt! + 4_000 : null;
    const sentAt = executedAt === null ? null : executedAt - 2_000;
    const visitor = `${SAMPLE_VISITOR_PREFIX}visitor-${String(n).padStart(2, '0')}`;
    const first = story.name.split(' ')[0];

    const conversationId = idGen();
    h.conversations.push({
      id: conversationId,
      bot_id: botId,
      source: 'web',
      external_user_id: visitor,
      contact_name: story.name,
      status: 'open',
      locale: 'en',
      last_message_at: iso(askAt),
      operator_read_at: iso(decidedAt ?? requestedAt + 10 * 60_000),
      created_at: iso(firstAt),
    });

    const messageIds = [idGen(), idGen()];
    [firstAt, askAt].forEach((at, t) => {
      h.messages.push({
        id: messageIds[t],
        bot_id: botId,
        conversation_id: conversationId,
        source: 'web',
        external_user_id: visitor,
        author_name: first,
        body: story.say[t],
        detected_at: iso(at),
        created_at: iso(at),
        classification_state: 'done',
        classification_next_at: iso(at),
      });
    });

    // One insight per conversation, on the refund turn (= what the dashboard's refund-reason match looks for),
    // extended with the first turn.
    const insightAt = requestedAt + 15_000;
    h.insights.push({
      id: idGen(),
      bot_id: botId,
      message_id: messageIds[1],
      source_message_ids: [messageIds[0], messageIds[1]],
      group_id: story.group ? groupIds[story.group] : null,
      category: story.group ? GROUPS[story.group].category : (story.category ?? 'cs'),
      summary: story.summary,
      sentiment: story.group === 'price' || story.category === 'other' ? 'neutral' : 'negative',
      follow_up_needed: false,
      classified_by: 'llm',
      created_at: iso(insightAt),
      updated_at: iso(insightAt),
    });
    if (story.group && (groupFirstAt[story.group] === undefined || insightAt < groupFirstAt[story.group])) groupFirstAt[story.group] = insightAt;

    const cents = PRICE_CENTS[story.product];
    const paypalRef = executedAt === null ? null : ref('REF', n);
    const actionId = idGen();
    const status = story.outcome === 'rejected' ? 'rejected' : 'executed';
    const settledAt = executedAt ?? decidedAt!;
    h.actions.push({
      id: actionId,
      bot_id: botId,
      conversation_id: conversationId,
      kind: 'refund',
      target_id: ref('CAP', n),
      amount_cents: cents,
      currency: CURRENCY,
      customer_key: null,
      origin: story.outcome === 'auto' ? 'auto' : 'approval',
      status,
      reason: story.reason,
      guardrail: guardrailFor(story),
      payload: executedAt === null ? null : { amount: { value: centsValue(cents), currency_code: CURRENCY } },
      result: paypalRef === null ? null : { id: paypalRef, status: 'COMPLETED' },
      paypal_ref: paypalRef,
      error: null,
      decided_by: null,
      decided_at: decidedAt === null ? null : iso(decidedAt),
      executed_at: executedAt === null ? null : iso(executedAt),
      sent_at: sentAt === null ? null : iso(sentAt),
      send_attempts: sentAt === null ? 0 : 1,
      created_at: iso(requestedAt),
      updated_at: iso(settledAt),
    });
    h.announcements.push({ action_id: actionId, status, response_id: null, created_at: iso(settledAt) });
  });

  for (const key of Object.keys(GROUPS) as GroupKey[]) {
    h.groups.push({
      id: groupIds[key],
      bot_id: botId,
      status: 'open',
      ...GROUPS[key],
      impact_scored_at: iso(groupFirstAt[key] + 60_000),
      created_at: iso(groupFirstAt[key]),
    });
  }

  assertSampleHistory(h, now);
  return h;
}

// ── invariants ──────────────────────────────────────────────────────────────────────────────────

/** Throws on the first broken safety rule (file header). The seed script never inserts without passing this. */
export function assertSampleHistory(h: SampleHistory, now: number): void {
  const fail = (msg: string): never => {
    throw new Error(`sample history invariant: ${msg}`);
  };
  const oldest = now - SAMPLE_HISTORY_DAYS * DAY_MS;
  const inRange = (at: string | null, what: string) => {
    if (at === null) return;
    const t = Date.parse(at);
    if (!(t >= oldest && t < now)) fail(`${what} ${at} outside the last ${SAMPLE_HISTORY_DAYS} days`);
  };
  const bots = new Set([...h.conversations, ...h.messages, ...h.groups, ...h.insights, ...h.actions].map((r) => r.bot_id));
  if (bots.size !== 1) fail('rows for more than one bot');

  const conversations = new Set<string>();
  for (const c of h.conversations) {
    if (!isSampleVisitor(c.external_user_id)) fail(`conversation ${c.id} visitor ${c.external_user_id} lacks the sample- prefix`);
    inRange(c.created_at, 'conversation');
    inRange(c.operator_read_at, 'operator_read_at');
    conversations.add(c.id);
  }
  const messageIds = new Set<string>();
  for (const m of h.messages) {
    if (m.classification_state !== 'done') fail(`message ${m.id} would be classified`);
    if (!conversations.has(m.conversation_id)) fail(`message ${m.id} outside the sample conversations`);
    if (!isSampleVisitor(m.external_user_id)) fail(`message ${m.id} visitor lacks the sample- prefix`);
    inRange(m.created_at, 'message');
    messageIds.add(m.id);
  }
  const groupIds = new Set(h.groups.map((g) => g.id));
  for (const g of h.groups) {
    if (typeof g.impact_core !== 'boolean') fail(`group ${g.id} unscored (impact scoring would call the LLM)`);
    inRange(g.created_at, 'group');
  }
  for (const v of TRIAGE_VALUES) if (!h.groups.some((g) => g.triage === v)) fail(`no group with triage ${v}`);
  const insightCountByGroup = new Map<string, number>();
  for (const i of h.insights) {
    if (!messageIds.has(i.message_id) || i.source_message_ids.some((id) => !messageIds.has(id))) fail(`insight ${i.id} points outside the sample messages`);
    if (GROUPABLE.has(i.category) && !i.group_id) fail(`groupable insight ${i.id} has no group (auto-grouping would call the LLM)`);
    if (i.group_id && !groupIds.has(i.group_id)) fail(`insight ${i.id} in a non-sample group`);
    if (i.group_id) insightCountByGroup.set(i.group_id, (insightCountByGroup.get(i.group_id) ?? 0) + 1);
    inRange(i.created_at, 'insight');
  }
  for (const g of h.groups) if (!insightCountByGroup.get(g.id)) fail(`group ${g.id} has no insights`);

  const announced = new Set(h.announcements.map((a) => `${a.action_id}:${a.status}`));
  const targets = new Set<string>();
  for (const a of h.actions) {
    if (a.kind !== 'refund') fail(`action ${a.id} is not a refund`);
    if (a.status !== 'executed' && a.status !== 'rejected') fail(`action ${a.id} status ${a.status} is not final`);
    if (!isSampleRef(a.target_id)) fail(`action ${a.id} target ${a.target_id} lacks the SAMPLE- prefix`);
    if (a.paypal_ref !== null && !isSampleRef(a.paypal_ref)) fail(`action ${a.id} paypal_ref lacks the SAMPLE- prefix`);
    if (targets.has(a.target_id)) fail(`duplicate target ${a.target_id}`);
    targets.add(a.target_id);
    if (a.customer_key !== null) fail(`action ${a.id} has a customer_key (per-customer cap)`);
    if (!conversations.has(a.conversation_id)) fail(`action ${a.id} outside the sample conversations`);
    if (!announced.has(`${a.id}:${a.status}`)) fail(`action ${a.id} has no announcement (the reaper would write into the chat)`);
    if (!(a.amount_cents > 0) || a.currency !== CURRENCY) fail(`action ${a.id} amount`);
    const created = Date.parse(a.created_at);
    if (created > now - DAY_MS && a.status !== 'rejected') fail(`action ${a.id} in the last 24 h is ${a.status} (daily cap)`);
    inRange(a.created_at, 'action');
    inRange(a.decided_at, 'decided_at');
    inRange(a.executed_at, 'executed_at');
    inRange(a.updated_at, 'updated_at');
    const failed = Object.values(a.guardrail).filter((passed) => passed !== true).length;
    if (a.origin === 'auto' && (failed > 0 || a.decided_at !== null || a.status !== 'executed')) fail(`auto action ${a.id} inconsistent`);
    if (a.origin === 'approval' && (failed === 0 || a.decided_at === null)) fail(`approval action ${a.id} inconsistent`);
    if (a.status === 'executed' && (!a.executed_at || !a.sent_at || !a.paypal_ref)) fail(`executed action ${a.id} incomplete`);
    if (a.status === 'rejected' && (a.executed_at || a.sent_at || a.paypal_ref || a.payload)) fail(`rejected action ${a.id} looks sent`);
  }
}

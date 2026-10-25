// The payment ledger (stage 5, item 3): refunds and purchases of the bots the caller may operate,
// newest first, in one list. Read-only — Approve / Reject go through the inbox decision route
// (`/api/inbox/[conversationId]/payment-actions/[actionId]`), the same path the approval card uses.
//
// GET ?botId=  — owner OR approver (resolveAccessibleBots), like the dashboard: the judge who joined the
// demo bot as an approver reads its ledger. Without botId: every bot the caller may operate.
// GET ?conversationId=  — only that conversation's rows (the inbox's payment activity panel). Same bot
// scope and the same owner/approver rules: a conversation of a bot the caller may not operate yields nothing.
//
// What leaves the server is `LedgerRow` (src/lib/paypal/ledger.ts) — no buyer email, no approve URL,
// no raw PayPal response; emails/tokens inside the buyer's words are masked. Owners see who decided (a name)
// and full PayPal order ids; approvers see «you» / «a team member» and the order id's last 6 characters.

import { NextResponse, type NextRequest } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { maskSecrets } from '@/lib/widget/context';
import { apiText } from '@/lib/http/api-text';
import {
  LEDGER_LIMIT,
  actionToLedgerRow,
  mergeLedger,
  orderToLedgerRow,
  type LedgerActionSource,
  type LedgerDecider,
  type LedgerOrderSource,
  type LedgerResponse,
} from '@/lib/paypal/ledger';


// `bot_id` only to decide what the caller may see of a row (owner vs approver) — it is not returned.
const ACTION_COLUMNS =
  'id, bot_id, kind, origin, status, amount_cents, currency, target_id, conversation_id, paypal_ref, reason, guardrail, error, decided_at, decided_by, executed_at, created_at, updated_at, payload, result';
// No payer_email / payer_id / approve_url: the ledger does not show them.
const ORDER_COLUMNS =
  'order_id, bot_id, status, amount_cents, currency, quantity, capture_id, conversation_id, refunded_cents, created_at, captured_at, refunded_at, products(name)';

// conversations.id is a uuid — anything else would only reach Postgres as a cast error (a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionQueryRow = LedgerActionSource & { bot_id: string };
type OrderQueryRow = Omit<LedgerOrderSource, 'product_name'> & { bot_id: string; products: { name: string | null } | { name: string | null }[] | null };

export async function GET(req?: NextRequest) {
  const params = req?.nextUrl.searchParams;
  const auth = await resolveAccessibleBots(params?.get('botId') ?? null);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const conversationId = params?.get('conversationId') || null;
  if (conversationId && !UUID_RE.test(conversationId)) {
    return NextResponse.json({ error: apiText(req, 'badRequest') }, { status: 400 });
  }

  const empty: LedgerResponse = { rows: [], truncated: false };
  const botIds = auth.botIds;
  if (botIds.length === 0) return NextResponse.json(empty);

  // Owner vs approver, per bot. One bot asked for → its role; all bots → ownedBotIds (same rule as the
  // dashboard's connect card). Approvers see less: no decider names, short order ids.
  const owned = new Set(auth.role ? (auth.role === 'owner' ? botIds : []) : (auth.ownedBotIds ?? []));

  const db = getServiceRoleClient();
  let actionQuery = db.from('payment_actions').select(ACTION_COLUMNS, { count: 'exact' }).in('bot_id', botIds);
  let orderQuery = db.from('paypal_orders').select(ORDER_COLUMNS, { count: 'exact' }).in('bot_id', botIds);
  if (conversationId) {
    actionQuery = actionQuery.eq('conversation_id', conversationId);
    orderQuery = orderQuery.eq('conversation_id', conversationId);
  }
  const [actionRes, orderRes] = await Promise.all([
    actionQuery.order('created_at', { ascending: false }).limit(LEDGER_LIMIT),
    orderQuery.order('created_at', { ascending: false }).limit(LEDGER_LIMIT),
  ]);

  const failed = actionRes.error ?? orderRes.error;
  if (failed) {
    console.error('[ledger] lookup failed', { message: failed.message });
    return NextResponse.json({ error: 'Could not load the payment ledger' }, { status: 500 });
  }

  // The buyer's words and PayPal's error text are free text: an email or a token typed into the chat
  // must not reach the ledger (the screen also shows to approvers of someone else's bot).
  const actions = ((actionRes.data ?? []) as unknown as ActionQueryRow[]).map((row) => ({
    ...row,
    reason: row.reason === null ? null : maskSecrets(row.reason),
    error: row.error === null ? null : maskSecrets(row.error),
  }));
  const orders = ((orderRes.data ?? []) as unknown as OrderQueryRow[]).map(({ products, ...row }) => {
    const product = Array.isArray(products) ? products[0] : products;
    return { ...row, product_name: product?.name ?? null } satisfies LedgerOrderSource & { bot_id: string };
  });

  // Who decided: a name only, and only for the bot's owner. An approver (the demo bot has many judge
  // approvers) sees «you» or «a team member» — never the other approvers' names. A failed lookup leaves the
  // names out; the rows stand.
  const deciderIds = [
    ...new Set(actions.filter((a) => owned.has(a.bot_id)).map((a) => a.decided_by).filter((id): id is string => Boolean(id))),
  ];
  const names = new Map<string, string | null>();
  if (deciderIds.length > 0) {
    const { data: users, error } = await db.from('users').select('id, name').in('id', deciderIds);
    if (error) console.error('[ledger] decider names lookup failed', { message: error.message });
    for (const user of users ?? []) names.set(user.id as string, (user.name as string | null) ?? null);
  }
  const deciderFor = (botId: string) => (userId: string): LedgerDecider => ({
    self: userId === auth.userId,
    name: owned.has(botId) ? (names.get(userId) ?? null) : null,
  });

  const merged = mergeLedger(
    actions.map(({ bot_id, ...row }) => actionToLedgerRow(row, deciderFor(bot_id))),
    orders.map(({ bot_id, ...row }) => orderToLedgerRow(row, { fullOrderId: owned.has(bot_id) })),
    LEDGER_LIMIT,
  );
  const tableCut =
    (actionRes.count ?? 0) > actions.length || (orderRes.count ?? 0) > orders.length;

  const body: LedgerResponse = { rows: merged.rows, truncated: tableCut || merged.cut };
  return NextResponse.json(body);
}

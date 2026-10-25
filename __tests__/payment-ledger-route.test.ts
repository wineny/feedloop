// GET /api/payments/ledger — the dashboard's payment ledger (stage 5, item 3).
//
// Like dashboard-payments-route.test.ts, each table has rows and the filters the query carries
// (in·order·limit) are applied for real — a missing `.in('bot_id', …)` shows up as another tenant's row.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Method = [string, ...unknown[]];

const { from, resolveAccessibleBots, tables, failing, calls } = vi.hoisted(() => ({
  from: vi.fn(),
  resolveAccessibleBots: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  failing: { table: null as string | null },
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
}));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/auth/ownership', () => ({ resolveAccessibleBots }));
import { GET } from '@/app/api/payments/ledger/route';
import { LEDGER_LIMIT, type LedgerResponse } from '@/lib/paypal/ledger';

const BOT = 'bot-1';
const OTHER = 'someone-else';
const USER = 'user-1';
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function run(table: string, methods: Method[]) {
  if (failing.table === table) return { data: null, count: null, error: { message: 'timeout' } };
  let rows = (tables[table] ?? []).filter((row) =>
    methods.every(([method, col, ...args]) =>
      method === 'in' ? (args[0] as unknown[]).includes(row[col as string]) : method === 'eq' ? row[col as string] === args[0] : true,
    ),
  );
  const order = methods.find((m) => m[0] === 'order');
  if (order) {
    const col = order[1] as string;
    rows = [...rows].sort((a, b) => String(b[col]).localeCompare(String(a[col])));
  }
  const count = rows.length;
  const limit = methods.find((m) => m[0] === 'limit');
  return { data: limit ? rows.slice(0, limit[1] as number) : rows, count, error: null };
}

const action = (o: Row = {}): Row => ({
  id: 'act-1',
  bot_id: BOT,
  kind: 'refund',
  origin: 'auto',
  status: 'executed',
  amount_cents: 900,
  currency: 'USD',
  target_id: 'CAPTURE1',
  conversation_id: 'conv-1',
  customer_key: 'buyer@example.com',
  paypal_ref: 'REFUND1',
  reason: 'please refund',
  guardrail: { amount_within_max: true, within_days: true },
  error: null,
  decided_at: null,
  decided_by: null,
  executed_at: ago(1),
  created_at: ago(1),
  updated_at: ago(1),
  payload: { amount: { value: '9.00', currency_code: 'USD' } },
  result: { id: 'REFUND1', status: 'COMPLETED', amount: { value: '9.00', currency_code: 'USD' }, links: [{ href: 'https://api.paypal.com/x' }] },
  ...o,
});

const order = (o: Row = {}): Row => ({
  order_id: 'ORDER1',
  bot_id: BOT,
  status: 'captured',
  amount_cents: 2900,
  currency: 'USD',
  quantity: 1,
  capture_id: 'CAPTURE1',
  conversation_id: 'conv-1',
  payer_email: 'buyer@example.com',
  payer_id: 'PAYER1',
  approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
  refunded_cents: 0,
  created_at: ago(2),
  captured_at: ago(2),
  refunded_at: null,
  products: { name: 'Pro' },
  ...o,
});

async function ledger(): Promise<LedgerResponse> {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  failing.table = null;
  for (const key of Object.keys(tables)) delete tables[key];
  tables.users = [{ id: USER, name: 'Owner', email: 'owner@example.com' }, { id: 'user-2', name: 'Jamie', email: 'jamie@example.com' }];
  resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT], ownedBotIds: [BOT] });
  from.mockImplementation((table: string) => {
    const call = { table, methods: [] as Method[] };
    calls.push(call);
    const query = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(run(table, call.methods)).then(resolve),
    } as Record<string, unknown>;
    for (const method of ['select', 'in', 'eq', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => { call.methods.push([method, ...args]); return query; };
    }
    return query;
  });
});

describe('auth and scope', () => {
  it('passes the auth answer through (401 / 403) and reads nothing', async () => {
    resolveAccessibleBots.mockResolvedValue({ ok: false, status: 403, error: 'nope' });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('uses the owner-or-approver helper with ?botId=', async () => {
    const req = { nextUrl: new URL('http://x/api/payments/ledger?botId=bot-1') } as never;
    await GET(req);
    expect(resolveAccessibleBots).toHaveBeenCalledWith('bot-1');
  });

  it('only the caller’s bots — another tenant’s refund and order never appear', async () => {
    tables.payment_actions = [action(), action({ id: 'act-x', bot_id: OTHER })];
    tables.paypal_orders = [order(), order({ order_id: 'ORDER-X', bot_id: OTHER })];
    const { rows } = await ledger();
    expect(rows.map((r) => r.id).sort()).toEqual(['ORDER1', 'act-1']);
    for (const call of calls.filter((c) => c.table !== 'users')) {
      expect(call.methods).toContainEqual(['in', 'bot_id', [BOT]]);
    }
  });

  it('no bots → empty list without querying', async () => {
    resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [] });
    expect(await ledger()).toEqual({ rows: [], truncated: false });
    expect(from).not.toHaveBeenCalled();
  });
});

describe('merge', () => {
  it('one list, newest first, refunds / purchases / disputes typed', async () => {
    tables.payment_actions = [
      action({ id: 'act-old', created_at: ago(10) }),
      action({ id: 'act-new', created_at: ago(1), status: 'pending', origin: 'approval', executed_at: null }),
      action({ id: 'dsp-1', kind: 'accept_dispute', target_id: 'PP-D-1', created_at: ago(5), amount_cents: null, currency: null }),
    ];
    tables.paypal_orders = [order({ order_id: 'O-mid', created_at: ago(3) }), order({ order_id: 'O-oldest', created_at: ago(20) })];
    const { rows, truncated } = await ledger();
    expect(rows.map((r) => [r.type, r.id])).toEqual([
      ['refund', 'act-new'],
      ['purchase', 'O-mid'],
      ['dispute', 'dsp-1'],
      ['refund', 'act-old'],
      ['purchase', 'O-oldest'],
    ]);
    expect(truncated).toBe(false);
    expect(rows[0]).toMatchObject({ status: 'pending', origin: 'approval', decidable: true, conversationId: 'conv-1' });
    // Disputes are not decided from the ledger (the decision route takes refunds only).
    expect(rows.find((r) => r.id === 'dsp-1')).toMatchObject({ decidable: false, amountCents: null });
  });

  it('purchase rows carry the product name and refunded amount', async () => {
    tables.paypal_orders = [order({ status: 'partially_refunded', refunded_cents: 900, refunded_at: ago(1), products: [{ name: 'Agency' }] })];
    const { rows } = await ledger();
    expect(rows[0]).toMatchObject({
      type: 'purchase',
      status: 'partially_refunded',
      amountCents: 2900,
      detail: { orderId: 'ORDER1', captureId: 'CAPTURE1', product: 'Agency', refundedCents: 900 },
    });
  });

  it('the execution record: amount sent, PayPal status, timeline, failed checks, who decided', async () => {
    tables.payment_actions = [
      action({
        origin: 'approval',
        guardrail: { amount_within_max: false, within_days: true },
        decided_at: ago(0.5),
        decided_by: 'user-2',
      }),
      action({ id: 'act-mine', decided_by: USER, decided_at: ago(0.5), created_at: ago(3) }),
    ];
    const { rows } = await ledger();
    expect(rows[0]).toMatchObject({
      detail: {
        kind: 'refund',
        targetId: 'CAPTURE1',
        paypalRef: 'REFUND1',
        sent: { value: '9.00', currency: 'USD' },
        resultStatus: 'COMPLETED',
        failedChecks: ['amount_within_max'],
        decidedBy: { self: false, name: 'Jamie' },
      },
    });
    expect(rows[1]).toMatchObject({ detail: { decidedBy: { self: true, name: 'Owner' } } });
  });
});

describe('nothing sensitive leaves the server', () => {
  it('no buyer email, approve URL, payer id or raw PayPal response; emails in free text are masked', async () => {
    tables.payment_actions = [action({ reason: 'refund to buyer@example.com please', error: 'failed for jane@example.com' })];
    tables.paypal_orders = [order()];
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('checkoutnow');
    expect(text).not.toContain('PAYER1');
    expect(text).not.toContain('api.paypal.com');
    const body = JSON.parse(text) as LedgerResponse;
    expect(body.rows.find((r) => r.type === 'refund')?.detail).toMatchObject({ reason: 'refund to *** please', error: 'failed for ***' });
  });

  it('the order query does not even select payer fields', async () => {
    tables.paypal_orders = [order()];
    await ledger();
    const select = calls.find((c) => c.table === 'paypal_orders')?.methods.find((m) => m[0] === 'select');
    expect(String(select?.[1])).not.toMatch(/payer_email|payer_id|approve_url/);
    const actionSelect = calls.find((c) => c.table === 'payment_actions')?.methods.find((m) => m[0] === 'select');
    expect(String(actionSelect?.[1])).not.toMatch(/customer_key/);
  });

  it('tokens and JWTs typed into the chat or echoed in an error are masked too', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const token = 'A21AAKx9ZqVb7Lr0mT3sYw8cPq5nHd2uFj6eGk4oXz1';
    tables.payment_actions = [action({ reason: `my token is ${token}`, error: `Bearer ${jwt} rejected` })];
    const text = await (await GET()).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('eyJhbGci');
    const body = JSON.parse(text) as LedgerResponse;
    expect(body.rows[0].detail).toMatchObject({ reason: 'my token is ***', error: 'Bearer *** rejected' });
  });

  it('decider lookup reads names only', async () => {
    tables.payment_actions = [action({ decided_by: 'user-2', decided_at: ago(1) })];
    await ledger();
    const select = calls.find((c) => c.table === 'users')?.methods.find((m) => m[0] === 'select');
    expect(select?.[1]).toBe('id, name');
  });
});

describe('owner vs approver', () => {
  const asApprover = () => resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT], ownedBotIds: [] });

  it('an approver never gets another person’s name — «a team member» (name null), or «you» for their own decision', async () => {
    asApprover();
    tables.payment_actions = [
      action({ id: 'by-other', decided_by: 'user-2', decided_at: ago(1), created_at: ago(1) }),
      action({ id: 'by-me', decided_by: USER, decided_at: ago(1), created_at: ago(2) }),
    ];
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain('Jamie');
    expect(text).not.toContain('Owner');
    const { rows } = JSON.parse(text) as LedgerResponse;
    expect(rows.find((r) => r.id === 'by-other')?.detail).toMatchObject({ decidedBy: { self: false, name: null } });
    expect(rows.find((r) => r.id === 'by-me')?.detail).toMatchObject({ decidedBy: { self: true, name: null } });
    expect(calls.some((c) => c.table === 'users')).toBe(false);
  });

  it('?botId= as approver (role) is treated the same', async () => {
    resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT], role: 'approver' });
    tables.payment_actions = [action({ decided_by: 'user-2', decided_at: ago(1) })];
    tables.paypal_orders = [order({ order_id: '5O190127TN364715T' })];
    const text = await (await GET()).text();
    expect(text).not.toContain('Jamie');
    expect(text).not.toContain('5O190127TN364715T');
  });

  it('the owner gets names (role owner, or ownedBotIds)', async () => {
    resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT], role: 'owner' });
    tables.payment_actions = [action({ decided_by: 'user-2', decided_at: ago(1) })];
    const { rows } = await ledger();
    expect(rows[0].detail).toMatchObject({ decidedBy: { self: false, name: 'Jamie' } });
  });

  it('order id: the owner gets it whole, an approver only the last 6 characters — in id, detail and key', async () => {
    tables.paypal_orders = [order({ order_id: '5O190127TN364715T' })];
    expect((await ledger()).rows[0]).toMatchObject({ id: '5O190127TN364715T', detail: { orderId: '5O190127TN364715T' } });

    asApprover();
    const text = await (await GET()).text();
    expect(text).not.toContain('5O190127TN364715T');
    const row = (JSON.parse(text) as LedgerResponse).rows[0];
    expect(row).toMatchObject({ id: '…64715T', detail: { orderId: '…64715T' } });
    expect(row.key).not.toContain('5O190127TN364715T');
  });

  it('across bots: names and full ids only for the bots the caller owns', async () => {
    resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT, 'demo-bot'], ownedBotIds: [BOT] });
    tables.payment_actions = [
      action({ id: 'mine', decided_by: 'user-2', decided_at: ago(1), created_at: ago(1) }),
      action({ id: 'demo', bot_id: 'demo-bot', decided_by: 'user-2', decided_at: ago(1), created_at: ago(2) }),
    ];
    tables.paypal_orders = [order({ order_id: 'MINEORDER0000001A' }), order({ order_id: 'DEMOORDER0000002B', bot_id: 'demo-bot' })];
    const { rows } = await ledger();
    expect(rows.find((r) => r.id === 'mine')?.detail).toMatchObject({ decidedBy: { name: 'Jamie' } });
    expect(rows.find((r) => r.id === 'demo')?.detail).toMatchObject({ decidedBy: { name: null } });
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['MINEORDER0000001A', '…00002B']));
  });
});

describe('limits', () => {
  it(`each table is capped at ${LEDGER_LIMIT}; a cut table sets truncated (count: exact)`, async () => {
    tables.payment_actions = Array.from({ length: LEDGER_LIMIT + 1 }, (_, i) => action({ id: `a-${i}`, created_at: ago(i) }));
    const { rows, truncated } = await ledger();
    expect(rows).toHaveLength(LEDGER_LIMIT);
    expect(truncated).toBe(true);
    for (const call of calls.filter((c) => c.table !== 'users')) {
      expect(call.methods).toContainEqual(['limit', LEDGER_LIMIT]);
      expect(call.methods.find((m) => m[0] === 'select')?.[2]).toEqual({ count: 'exact' });
    }
  });

  it('two full-but-uncut tables merged past the limit are cut to the newest and flagged', async () => {
    tables.payment_actions = Array.from({ length: 150 }, (_, i) => action({ id: `a-${i}`, created_at: ago(i * 2) }));
    tables.paypal_orders = Array.from({ length: 150 }, (_, i) => order({ order_id: `o-${i}`, created_at: ago(i * 2 + 1) }));
    const { rows, truncated } = await ledger();
    expect(rows).toHaveLength(LEDGER_LIMIT);
    expect(truncated).toBe(true);
    expect(rows[0].id).toBe('a-0');
    expect(rows[1].id).toBe('o-0');
  });

  it('a failed lookup is a 500, not an empty ledger', async () => {
    failing.table = 'paypal_orders';
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe('?conversationId= (the inbox payment activity panel)', () => {
  const CONV = '11111111-2222-4333-8444-555555555555';
  const CONV_2 = '11111111-2222-4333-8444-666666666666';
  const forConversation = (id: string) => ({ nextUrl: new URL(`http://x/api/payments/ledger?conversationId=${id}`), headers: new Headers() }) as never;
  const asApprover = () => resolveAccessibleBots.mockResolvedValue({ ok: true, userId: USER, botIds: [BOT], ownedBotIds: [] });

  it('only that conversation, and still only the caller’s bots', async () => {
    tables.payment_actions = [
      action({ conversation_id: CONV }),
      action({ id: 'act-other-conv', conversation_id: CONV_2 }),
      // Same conversation id on another tenant's bot: the bot scope still applies.
      action({ id: 'act-other-bot', bot_id: OTHER, conversation_id: CONV }),
    ];
    tables.paypal_orders = [order({ conversation_id: CONV }), order({ order_id: 'ORDER-OTHER-CONV', conversation_id: CONV_2 }), order({ order_id: 'ORDER-X', bot_id: OTHER, conversation_id: CONV })];
    const res = await GET(forConversation(CONV));
    const { rows } = (await res.json()) as LedgerResponse;
    expect(rows.map((r) => r.id).sort()).toEqual(['ORDER1', 'act-1']);
    expect(resolveAccessibleBots).toHaveBeenCalledWith(null);
    for (const call of calls.filter((c) => c.table !== 'users')) {
      expect(call.methods).toContainEqual(['in', 'bot_id', [BOT]]);
      expect(call.methods).toContainEqual(['eq', 'conversation_id', CONV]);
    }
  });

  it('a conversation of a bot the caller may not operate yields nothing', async () => {
    tables.payment_actions = [action({ bot_id: OTHER, conversation_id: '99999999-2222-4333-8444-555555555555' })];
    tables.paypal_orders = [order({ bot_id: OTHER, conversation_id: '99999999-2222-4333-8444-555555555555' })];
    const { rows } = (await (await GET(forConversation('99999999-2222-4333-8444-555555555555'))).json()) as LedgerResponse;
    expect(rows).toEqual([]);
  });

  it('without it the ledger is not filtered by conversation', async () => {
    tables.payment_actions = [action(), action({ id: 'act-2', conversation_id: CONV_2 })];
    const { rows } = await ledger();
    expect(rows).toHaveLength(2);
    for (const call of calls) expect(call.methods.some((m) => m[0] === 'eq')).toBe(false);
  });

  it('same masking as the ledger: an approver gets no names and a short order id; the owner gets both', async () => {
    tables.payment_actions = [action({ conversation_id: CONV, decided_by: 'user-2', decided_at: ago(1) })];
    tables.paypal_orders = [order({ conversation_id: CONV, order_id: '5O190127TN364715T' })];
    const owner = (await (await GET(forConversation(CONV))).json()) as LedgerResponse;
    expect(owner.rows.find((r) => r.type === 'refund')?.detail).toMatchObject({ decidedBy: { name: 'Jamie' } });
    expect(owner.rows.find((r) => r.type === 'purchase')?.id).toBe('5O190127TN364715T');

    asApprover();
    const text = await (await GET(forConversation(CONV))).text();
    expect(text).not.toContain('Jamie');
    expect(text).not.toContain('5O190127TN364715T');
    expect(text).not.toContain('@example.com');
    const approver = JSON.parse(text) as LedgerResponse;
    expect(approver.rows.find((r) => r.type === 'purchase')?.id).toBe('…64715T');
  });

  it('a conversation id that is not a uuid is a 400, and nothing is read', async () => {
    for (const bad of ['conv-1', "x' or 1=1", '1'.repeat(36)]) {
      const res = await GET(forConversation(encodeURIComponent(bad)));
      expect(res.status).toBe(400);
    }
    expect(from).not.toHaveBeenCalled();
  });
});

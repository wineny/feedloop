// 대시보드 `payments` 블록(5단계 숫자 3개 + 연결 카드)의 계약 테스트.
//
// 다른 대시보드 테스트는 응답을 «순서로» 짝짓는데, 여기서는 표마다 행을 두고 조회에 실린 필터
// (eq·in·gte·not is null·limit)를 실제로 적용한다 — 필터 한 줄이 빠지면 숫자가 달라져서 깨진다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Method = [string, ...unknown[]];

const { from, resolveOwnedBots, tables, failing, calls, serverMaxRows } = vi.hoisted(() => ({
  from: vi.fn(),
  resolveOwnedBots: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** 이 조건에 맞는 조회만 실패시킨다 — 표 전체를 죽이면 앞선 대시보드 조회가 먼저 500 을 낸다. */
  failing: { when: null as null | ((table: string, methods: [string, ...unknown[]][]) => boolean) },
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
  /** PostgREST 의 max-rows 흉내 — limit 을 안 걸어도 서버가 이 수만큼만 준다(count 는 전체). */
  serverMaxRows: {} as Record<string, number>,
}));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots, resolveAccessibleBots: resolveOwnedBots }));
import { GET } from '@/app/api/dashboard/route';

const BOT = 'bot-1';
const DAY = 24 * 3_600_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function matches(row: Row, [method, col, ...args]: Method): boolean {
  const value = row[col as string];
  switch (method) {
    case 'eq': return value === args[0];
    case 'in': return (args[0] as unknown[]).includes(value);
    case 'gte': return value != null && String(value) >= String(args[0]);
    case 'lte': return value != null && String(value) <= String(args[0]);
    case 'lt': return value != null && (value as number) < (args[0] as number);
    case 'is': return value == null;
    case 'not': return args[0] === 'is' && args[1] === null ? value != null : true;
    default: return true;
  }
}

function run(table: string, methods: Method[]) {
  if (failing.when?.(table, methods)) return { data: null, count: null, error: { message: 'timeout' } };
  const matched = (tables[table] ?? []).filter((row) => methods.every((m) => matches(row, m)));
  // PostgREST 처럼: count 는 limit 전 전체 수, data 는 limit 까지만.
  const limit = methods.find((m) => m[0] === 'limit');
  const limited = limit ? matched.slice(0, limit[1] as number) : matched;
  const rows = serverMaxRows[table] !== undefined ? limited.slice(0, serverMaxRows[table]) : limited;
  const head = methods.some((m) => m[0] === 'select' && (m[2] as { head?: boolean } | undefined)?.head);
  return { data: head ? null : rows, count: matched.length, error: null };
}

const bot = (o: Row = {}): Row => ({
  id: BOT,
  status: 'active',
  is_demo: false,
  paypal_client_id: 'cid',
  paypal_secret_encrypted: 'enc',
  github_repo_url: null,
  currency: 'USD',
  ...o,
});

const reply = (o: Row = {}): Row => ({
  bot_id: BOT,
  conversation_id: 'conv-1',
  response_type: 'payment_agent',
  response_body: '…',
  sent_at: ago(1),
  delivered_at: null,
  ...o,
});

const action = (o: Row = {}): Row => ({
  bot_id: BOT,
  kind: 'refund',
  origin: 'auto',
  status: 'executed',
  amount_cents: 1500,
  currency: 'USD',
  created_at: ago(1),
  executed_at: ago(1),
  ...o,
});

async function payments() {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()).payments;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  failing.when = null;
  for (const key of Object.keys(tables)) delete tables[key];
  for (const key of Object.keys(serverMaxRows)) delete serverMaxRows[key];
  tables.bots = [bot()];
  resolveOwnedBots.mockResolvedValue({ ok: true, botIds: [BOT], ownedBotIds: [BOT] });
  from.mockImplementation((table: string) => {
    const call = { table, methods: [] as Method[] };
    calls.push(call);
    const query = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(run(table, call.methods)).then(resolve),
    } as Record<string, unknown>;
    for (const method of ['select', 'in', 'eq', 'not', 'is', 'lte', 'lt', 'gte', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => { call.methods.push([method, ...args]); return query; };
    }
    return query;
  });
});

describe('결제 문의 수(7일)', () => {
  it('행이 아니라 «대화» 를 센다 — 한 대화의 결제 답 여러 개는 1', async () => {
    tables.responses = [
      reply({ conversation_id: 'conv-1' }),
      reply({ conversation_id: 'conv-1', response_type: 'payment' }),
      reply({ conversation_id: 'conv-1', sent_at: ago(2) }),
      reply({ conversation_id: 'conv-2', response_type: 'payment' }),
    ];
    expect((await payments()).inquiries7d).toBe(2);
  });

  it('결제가 아닌 답, 7일보다 오래된 답, 다른 봇, 대화 없는 답은 빠진다', async () => {
    tables.responses = [
      reply({ conversation_id: 'conv-1' }),
      reply({ conversation_id: 'conv-ai', response_type: 'ai' }),
      reply({ conversation_id: 'conv-old', sent_at: ago(8) }),
      reply({ conversation_id: 'conv-other', bot_id: 'someone-else' }),
      reply({ conversation_id: null }),
    ];
    expect((await payments()).inquiries7d).toBe(1);
  });

  it('조회가 실패하면 0 이 아니라 null(집계 못 함)이고, 대시보드는 살아 있다', async () => {
    failing.when = (table, methods) =>
      table === 'responses' && methods.some((m) => m[0] === 'in' && m[1] === 'response_type');
    expect((await payments()).inquiries7d).toBeNull();
  });
});

describe('자동 환불(7일)', () => {
  it('실행된 자동 환불만 — 승인 경로·미실행·7일 밖·분쟁 수락은 빠진다', async () => {
    tables.payment_actions = [
      action({ amount_cents: 1500 }),
      action({ amount_cents: 500, executed_at: ago(6) }),
      action({ origin: 'approval', amount_cents: 900 }),
      action({ status: 'failed', executed_at: null }),
      action({ status: 'unknown', executed_at: null }),
      action({ status: 'executing', executed_at: null }),
      action({ amount_cents: 700, created_at: ago(1), executed_at: ago(9) }),
      action({ kind: 'accept_dispute', amount_cents: 300 }),
      action({ bot_id: 'someone-else' }),
    ];
    expect((await payments()).autoRefunds7d).toEqual({ count: 2, amountCents: 2000, currency: 'USD' });
  });

  it('기간은 created_at 이 아니라 executed_at 으로 자른다', async () => {
    tables.payment_actions = [action({ created_at: ago(10), executed_at: ago(1) })];
    expect((await payments()).autoRefunds7d.count).toBe(1);
  });

  it('0건이면 금액 0 에 봇 통화를 싣는다', async () => {
    tables.bots = [bot({ currency: 'EUR' })];
    expect((await payments()).autoRefunds7d).toEqual({ count: 0, amountCents: 0, currency: 'EUR' });
  });

  it('통화가 섞이면 건수는 그대로, 금액·통화는 null — 서로 다른 통화를 더하지 않는다', async () => {
    tables.payment_actions = [action({ currency: 'USD' }), action({ currency: 'EUR' })];
    expect((await payments()).autoRefunds7d).toEqual({ count: 2, amountCents: null, currency: null });
  });
});

describe('승인 대기 수', () => {
  it('pending 만, 기간 제한 없이, 소유 봇으로 좁혀서 센다', async () => {
    tables.payment_actions = [
      action({ status: 'pending', origin: 'approval', created_at: ago(30), executed_at: null }),
      action({ status: 'pending', origin: 'approval', kind: 'accept_dispute', executed_at: null }),
      action({ status: 'rejected', origin: 'approval', executed_at: null }),
      action({ status: 'pending', origin: 'approval', bot_id: 'someone-else', executed_at: null }),
    ];
    expect((await payments()).pendingApprovals).toBe(2);
    const pending = calls.find((c) => c.table === 'payment_actions' && c.methods.some((m) => m[0] === 'eq' && m[1] === 'status' && m[2] === 'pending'));
    expect(pending!.methods).toContainEqual(['select', 'id', { count: 'exact', head: true }]);
  });
});

describe('잘린 표본', () => {
  it('count 가 받은 행보다 많으면(서버가 잘랐으면) 0 도 하한도 아닌 null 이다', async () => {
    tables.responses = Array.from({ length: 1001 }, (_, i) => reply({ conversation_id: `conv-${i}` }));
    tables.payment_actions = Array.from({ length: 1001 }, () => action());
    const result = await payments();
    expect(result.inquiries7d).toBeNull();
    expect(result.autoRefunds7d).toBeNull();
    expect(result.refundReasons).toBeNull();
    // 결제 문의·자동 환불·환불 사유와 그 재료(인사이트·실행) 모두 정확한 count 를 함께 요청한다
    const counted = calls.filter((c) => c.methods.some((m) => m[0] === 'select' && (m[2] as { count?: string } | undefined)?.count === 'exact' && !(m[2] as { head?: boolean }).head));
    expect(counted.map((c) => c.table).sort()).toEqual(['auto_dev_runs', 'insights', 'payment_actions', 'payment_actions', 'responses']);
  });

  it('상한과 정확히 같은 수는 잘린 것이 아니다', async () => {
    tables.payment_actions = Array.from({ length: 1000 }, () => action({ amount_cents: 1 }));
    expect((await payments()).autoRefunds7d).toEqual({ count: 1000, amountCents: 1000, currency: 'USD' });
  });
});

describe('payment_actions 조회 실패', () => {
  it('자동 환불·승인 대기·환불 사유는 0 이 아니라 null 이다', async () => {
    failing.when = (table) => table === 'payment_actions';
    expect(await payments()).toMatchObject({ autoRefunds7d: null, pendingApprovals: null, refundReasons: null, connected: true });
  });
});

describe('환불 사유', () => {
  it('상태와 기간에 상관없이 환불 요청을 세고, 같은 대화의 인사이트로 갈래를 나눈다 — 다른 봇·분쟁 수락은 빠진다', async () => {
    tables.payment_actions = [
      action({ id: 'r-wrong-1', conversation_id: 'conv-a', reason: 'I bought the wrong plan by mistake.', created_at: ago(30) }),
      action({ id: 'r-wrong-2', conversation_id: 'conv-b', reason: 'I bought the wrong plan by mistake.', status: 'rejected', origin: 'approval', created_at: ago(2) }),
      action({ id: 'r-bug', conversation_id: 'conv-c', reason: 'Receipt shows the wrong currency', created_at: ago(1) }),
      action({ id: 'r-dispute', kind: 'accept_dispute', conversation_id: 'conv-d', reason: 'dispute' }),
      action({ id: 'r-other-bot', bot_id: 'someone-else', conversation_id: 'conv-e', reason: 'elsewhere' }),
    ];
    // 환불 턴 = 그 대화에서 환불 직전의 방문자 메시지
    tables.messages = [
      { id: 'm-a', bot_id: BOT, conversation_id: 'conv-a', created_at: ago(30.001) },
      { id: 'm-c', bot_id: BOT, conversation_id: 'conv-c', created_at: ago(1.001) },
    ];
    tables.insights = [
      { id: 'ins-c', bot_id: BOT, message_id: 'm-c', source_message_ids: [], group_id: 'g-1', category: 'bug', summary: 'Currency wrong on receipt', created_at: ago(0.9) },
    ];
    tables.insight_groups = [{ id: 'g-1', bot_id: BOT, title: 'Receipt shows the wrong currency' }];
    tables.auto_dev_runs = [
      { id: 'run-1', bot_id: BOT, insight_id: null, group_id: 'g-1', status: 'completed', pr_url: 'https://github.com/example/demo/pull/128', pr_number: 128, closed_at: null, created_at: ago(0.5) },
    ];

    const { refundReasons } = await payments();
    expect(refundReasons).toEqual({
      total: 3,
      buckets: { fix: 1, feature: 0, other: 0, unclassified: 2 },
      top: [
        { key: 'reason:i bought the wrong plan by mistake.', label: 'I bought the wrong plan by mistake.', count: 2, bucket: 'unclassified', href: '/inbox?c=conv-b', external: false },
        { key: 'group:g-1', label: 'Receipt shows the wrong currency', count: 1, bucket: 'fix', href: 'https://github.com/example/demo/pull/128', external: true },
      ],
    });
    // 메시지·묶음 조회도 소유 봇으로 좁힌다
    const messageCall = calls.find((c) => c.table === 'messages' && c.methods.some((m) => m[0] === 'in' && m[1] === 'conversation_id'));
    expect(messageCall!.methods).toContainEqual(['in', 'bot_id', [BOT]]);
    const conversationFilter = messageCall!.methods.find((m) => m[0] === 'in' && m[1] === 'conversation_id');
    expect([...(conversationFilter![2] as string[])].sort()).toEqual(['conv-a', 'conv-b', 'conv-c']);
    const groupCall = calls.find((c) => c.table === 'insight_groups');
    expect(groupCall!.methods).toContainEqual(['in', 'bot_id', [BOT]]);
    expect(groupCall!.methods).toContainEqual(['in', 'id', ['g-1']]);
  });

  it('환불 대화가 없으면 메시지·묶음 조회를 하지 않는다', async () => {
    tables.payment_actions = [action({ reason: 'Changed my mind' })];
    expect((await payments()).refundReasons).toMatchObject({ total: 1, buckets: { unclassified: 1 } });
    expect(calls.some((c) => c.table === 'messages' && c.methods.some((m) => m[0] === 'in' && m[1] === 'conversation_id'))).toBe(false);
    expect(calls.some((c) => c.table === 'insight_groups')).toBe(false);
  });

  it('환불 대화 메시지가 상한에 닿으면(잘렸으면) 틀린 숫자 대신 null 이다', async () => {
    tables.payment_actions = [action({ conversation_id: 'conv-a', reason: 'x' })];
    tables.messages = Array.from({ length: 1001 }, (_, i) => ({ id: `m-${i}`, bot_id: BOT, conversation_id: 'conv-a', created_at: ago(2) }));
    expect((await payments()).refundReasons).toBeNull();
  });

  it('대화 50개씩 나눠 읽는다 — 한 조회가 상한을 넘기지 않게', async () => {
    tables.payment_actions = Array.from({ length: 120 }, (_, i) => action({ conversation_id: `conv-${i}`, reason: 'x' }));
    expect((await payments()).refundReasons).toMatchObject({ total: 120 });
    const chunks = calls.filter((c) => c.table === 'messages' && c.methods.some((m) => m[0] === 'in' && m[1] === 'conversation_id'));
    expect(chunks.map((c) => (c.methods.find((m) => m[0] === 'in' && m[1] === 'conversation_id')![2] as string[]).length)).toEqual([50, 50, 20]);
  });

  it('인사이트 목록이 서버 상한에 잘렸으면 null 이다 — 다른 대시보드 숫자는 그대로', async () => {
    tables.payment_actions = [action({ conversation_id: 'conv-a', reason: 'x', status: 'pending', origin: 'approval', executed_at: null })];
    tables.insights = Array.from({ length: 1001 }, (_, i) => ({ id: `i-${i}`, bot_id: BOT, message_id: null, source_message_ids: [], group_id: null, category: 'bug', summary: '', created_at: ago(1) }));
    serverMaxRows.insights = 1000;
    const result = await payments();
    expect(result.refundReasons).toBeNull();
    expect(result.pendingApprovals).toBe(1);
  });

  it('환불 대화 메시지 조회가 실패하면 null(집계 못 함)이고, 대시보드는 살아 있다', async () => {
    tables.payment_actions = [action({ conversation_id: 'conv-a', reason: 'x' })];
    failing.when = (table, methods) => table === 'messages' && methods.some((m) => m[0] === 'in' && m[1] === 'conversation_id');
    expect((await payments()).refundReasons).toBeNull();
  });
});

describe('연결 여부', () => {
  it('자기 키가 저장된 봇은 연결됨 — 연결 카드 대상 없음', async () => {
    expect(await payments()).toMatchObject({ connected: true, connectBotId: null });
  });

  it('키 없는 데모 봇은 공용 키를 쓰므로 연결됨', async () => {
    tables.bots = [bot({ is_demo: true, paypal_client_id: null, paypal_secret_encrypted: null })];
    expect((await payments()).connected).toBe(true);
  });

  it('키 없는 일반 봇은 연결 안 됨 — 숫자 모양은 그대로, 카드는 그 봇으로', async () => {
    tables.bots = [bot({ paypal_client_id: null, paypal_secret_encrypted: null })];
    expect(await payments()).toEqual({
      connected: false,
      connectBotId: BOT,
      inquiries7d: 0,
      autoRefunds7d: { count: 0, amountCents: 0, currency: 'USD' },
      pendingApprovals: 0,
      refundReasons: { total: 0, buckets: { fix: 0, feature: 0, other: 0, unclassified: 0 }, top: [] },
    });
  });

  it('일시정지 봇은 키가 있어도(데모여도) 연결 안 됨', async () => {
    tables.bots = [bot({ status: 'paused', is_demo: true })];
    expect(await payments()).toMatchObject({ connected: false, connectBotId: BOT });
  });

  it('소유 봇 여럿 중 하나라도 연결돼 있으면 연결됨 — 카드 대상은 연결 안 된 첫 소유 봇', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['a', 'b'], ownedBotIds: ['a', 'b'] });
    tables.bots = [bot({ id: 'a', paypal_client_id: null }), bot({ id: 'b' })];
    expect(await payments()).toMatchObject({ connected: true, connectBotId: 'a' });
  });

  it('소유 봇이 전부 연결돼 있으면 카드 대상 없음', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['a', 'b'], ownedBotIds: ['a', 'b'] });
    tables.bots = [bot({ id: 'a' }), bot({ id: 'b' })];
    expect(await payments()).toMatchObject({ connected: true, connectBotId: null });
  });

  it('아무것도 연결 안 됐으면 첫 소유 봇으로 보낸다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['a', 'b'], ownedBotIds: ['a', 'b'] });
    tables.bots = [bot({ id: 'a', paypal_client_id: null }), bot({ id: 'b', paypal_secret_encrypted: null })];
    expect(await payments()).toMatchObject({ connected: false, connectBotId: 'a' });
  });

  it('자기 봇은 미연결 + 데모 봇은 승인자로(전체 보기) → 숫자도 보이고, 카드는 자기 봇으로', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['mine', 'demo'], ownedBotIds: ['mine'] });
    tables.bots = [
      bot({ id: 'mine', paypal_client_id: null, paypal_secret_encrypted: null }),
      bot({ id: 'demo', is_demo: true, paypal_client_id: null, paypal_secret_encrypted: null }),
    ];
    tables.payment_actions = [action({ bot_id: 'demo', status: 'pending', origin: 'approval', executed_at: null })];
    expect(await payments()).toMatchObject({ connected: true, connectBotId: 'mine', pendingApprovals: 1 });
  });

  it('데모 봇의 승인자(전체 보기) → 데모 숫자를 보고, 카드 대상은 없다 — 설정 탭은 소유자 전용이다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['demo'], ownedBotIds: [] });
    tables.bots = [bot({ id: 'demo', is_demo: true, paypal_client_id: null, paypal_secret_encrypted: null })];
    expect(await payments()).toMatchObject({ connected: true, connectBotId: null });
  });

  it('?botId= 로 데모 봇을 승인자로 보고 있으면 → 연결됨, 카드 대상 없음', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['demo'], role: 'approver' });
    tables.bots = [bot({ id: 'demo', is_demo: true, paypal_client_id: null, paypal_secret_encrypted: null })];
    expect(await payments()).toMatchObject({ connected: true, connectBotId: null });
  });

  it('?botId= 로 승인자 봇을 보고 있으면 connectBotId 는 null', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['other'], role: 'approver' });
    tables.bots = [bot({ id: 'other', paypal_client_id: null, paypal_secret_encrypted: null })];
    expect(await payments()).toMatchObject({ connected: false, connectBotId: null });
  });

  it('?botId= 로 자기 봇을 보고 있으면 그 봇으로', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: [BOT], role: 'owner' });
    tables.bots = [bot({ paypal_client_id: null, paypal_secret_encrypted: null })];
    expect(await payments()).toMatchObject({ connected: false, connectBotId: BOT });
  });

  it('암호문은 응답에 실리지 않는다', async () => {
    tables.bots = [bot({ paypal_secret_encrypted: 'enc:SECRET-CIPHERTEXT' })];
    const body = await (await GET()).text();
    expect(body).not.toContain('SECRET-CIPHERTEXT');
  });

  it('봇이 하나도 없어도 payments 모양은 내려간다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: true, botIds: [] });
    expect(await payments()).toMatchObject({ connected: false, connectBotId: null });
  });
});

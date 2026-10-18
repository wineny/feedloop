import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 못 보낸 되돌림의 회복 경로 둘 — 유저가 다시 말을 걸 때, 사람이 버튼을 누를 때.
// 크론을 새로 만들 수 없어서 이 둘이 전부다.

interface Op {
  table: string;
  op: string;
  patch?: Record<string, unknown>;
  filters: Array<[string, unknown, unknown]>;
}

let ops: Op[] = [];

/** 대화는 «필터를 보고» 답한다. 조회 순서가 바뀌어도 테스트가 깨지지 않게. */
let convFixtures: Array<Record<string, unknown>> = [];
/** 되돌림은 순서대로 답한다 — 전송 «전» 과 «후» 를 갈라 보여줘야 하기 때문이다. */
let responseQueue: unknown[][] = [];

function findFilter(rec: Op, method: string, field: string): unknown {
  const hit = rec.filters.find((f) => f[0] === method && f[1] === field);
  return hit ? hit[2] : undefined;
}

function resolveConversations(rec: Op): unknown[] {
  const eqId = findFilter(rec, 'eq', 'id');
  if (eqId !== undefined) return convFixtures.filter((c) => c.id === eqId);

  const inIds = findFilter(rec, 'in', 'id') as string[] | undefined;
  if (inIds) return convFixtures.filter((c) => inIds.includes(c.id as string));

  const person = findFilter(rec, 'eq', 'channel_person_id');
  if (person !== undefined) {
    const bot = findFilter(rec, 'eq', 'bot_id');
    const limit = (findFilter(rec, 'limit', undefined as unknown as string) ??
      rec.filters.find((f) => f[0] === 'limit')?.[1]) as number | undefined;
    const rows = convFixtures
      .filter((c) => c.channel_person_id === person && (bot === undefined || c.bot_id === bot))
      .sort(
        (a, b) =>
          new Date(String(b.last_message_at ?? 0)).getTime() -
          new Date(String(a.last_message_at ?? 0)).getTime(),
      );
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }
  return convFixtures;
}

function resolveOp(rec: Op): unknown[] {
  if (rec.table === 'conversations') return resolveConversations(rec);
  if (rec.table === 'responses') {
    if (responseQueue.length === 0) return [];
    return responseQueue.length === 1 ? responseQueue[0] : (responseQueue.shift() as unknown[]);
  }
  return [];
}

function chain(table: string, op: string, patch?: Record<string, unknown>) {
  const rec: Op = { table, op, patch, filters: [] };
  ops.push(rec);

  const self: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'is', 'not', 'lt', 'gt', 'gte', 'order', 'limit']) {
    self[m] = (a?: unknown, b?: unknown) => {
      rec.filters.push([m, a, b]);
      return self;
    };
  }
  self.single = async () => ({ data: resolveOp(rec)[0] ?? null, error: null });
  self.maybeSingle = self.single;
  self.then = (resolve: (v: unknown) => void) =>
    resolve({ data: op === 'select' ? resolveOp(rec) : null, error: null });
  return self;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      update: (patch: Record<string, unknown>) => chain(table, 'update', patch),
    }),
  }),
}));

const sendBotMessageMock = vi.fn(async () => ({ ok: true }) as {
  ok: boolean;
  status?: number;
  message?: string;
});

vi.mock('@/lib/channel/client', () => ({ sendBotMessage: sendBotMessageMock }));

let mod: typeof import('@/lib/channel/redeliver');
let errorSpy: ReturnType<typeof vi.spyOn>;

const filtersOf = (table: string, op: string) =>
  ops.filter((o) => o.table === table && o.op === op).flatMap((o) => o.filters);
const updatesOf = (table: string) => ops.filter((o) => o.table === table && o.op === 'update');
const sentChatIds = () =>
  sendBotMessageMock.mock.calls.map((c) => (c as unknown as string[])[1]);

const CHANNEL_CONV = {
  id: 'c-1',
  bot_id: 'bot-1',
  source: 'channel',
  external_user_id: 'chat-1',
  channel_person_id: 'person-1',
  last_message_at: '2026-09-10T00:00:00Z',
};

beforeEach(async () => {
  vi.resetModules();
  ops = [];
  convFixtures = [];
  responseQueue = [];
  sendBotMessageMock.mockClear();
  sendBotMessageMock.mockResolvedValue({ ok: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  mod = await import('@/lib/channel/redeliver');
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('retryUndelivered — 유저가 다시 말을 걸었을 때', () => {
  it('되돌림만, 아직 못 보낸 것만, 5회 미만 실패한 것만 고른다', async () => {
    convFixtures = [CHANNEL_CONV];
    responseQueue = [[{ id: 'r1', response_body: '반영됐어요', delivery_attempts: 2 }]];

    await mod.retryUndelivered('c-1');

    const f = filtersOf('responses', 'select');
    // 운영자 답장도 delivered_at IS NULL 로 쌓인다 — 그건 우리가 보낼 것이 아니다.
    expect(f).toContainEqual(['eq', 'response_type', 'loop_closed']);
    expect(f).toContainEqual(['is', 'delivered_at', null]);
    expect(f).toContainEqual(['lt', 'delivery_attempts', mod.MAX_DELIVERY_ATTEMPTS]);
  });

  it('보내고 나면 전달로 확정한다', async () => {
    convFixtures = [CHANNEL_CONV];
    responseQueue = [[{ id: 'r1', response_body: '반영됐어요 (PR #5)', delivery_attempts: 0 }]];

    const out = await mod.retryUndelivered('c-1');

    expect(out).toEqual({ sent: 1, failed: 0, considered: 1 });
    expect(sendBotMessageMock).toHaveBeenCalledWith('bot-1', 'chat-1', '반영됐어요 (PR #5)', {
      timeoutMs: mod.WEBHOOK_RETRY_TIMEOUT_MS,
    });
    expect(updatesOf('responses')[0].patch).toHaveProperty('delivered_at');
  });

  it('실패하면 시도 횟수를 올리고 사유를 남긴다 — 5회에서 멈추기 위한 근거다', async () => {
    convFixtures = [CHANNEL_CONV];
    responseQueue = [[{ id: 'r1', response_body: 'x', delivery_attempts: 2 }]];
    sendBotMessageMock.mockResolvedValue({ ok: false, status: 404, message: '전송이 거부됐습니다' });

    const out = await mod.retryUndelivered('c-1');

    expect(out).toEqual({ sent: 0, failed: 1, considered: 1 });
    expect(updatesOf('responses')[0].patch).toMatchObject({
      delivery_attempts: 3,
      delivery_error: '전송이 거부됐습니다',
    });
  });

  it('웹·카카오 대화면 아무것도 하지 않는다 — 그쪽은 각자의 대기열 규칙이 있다', async () => {
    convFixtures = [{ ...CHANNEL_CONV, source: 'web' }];

    expect(await mod.retryUndelivered('c-1')).toEqual({ sent: 0, failed: 0, considered: 0 });
    expect(sendBotMessageMock).not.toHaveBeenCalled();
  });

  it('대기열이 비어 있으면 전송을 부르지 않는다', async () => {
    convFixtures = [CHANNEL_CONV];
    responseQueue = [[]];

    expect(await mod.retryUndelivered('c-1')).toEqual({ sent: 0, failed: 0, considered: 0 });
    expect(sendBotMessageMock).not.toHaveBeenCalled();
  });

  it('한 발화에 얹는 건수를 제한한다 — 웹훅을 오래 붙들지 않는다', async () => {
    convFixtures = [CHANNEL_CONV];
    responseQueue = [[]];
    await mod.retryUndelivered('c-1');

    expect(filtersOf('responses', 'select')).toContainEqual([
      'limit',
      mod.WEBHOOK_RETRY_MAX,
      undefined,
    ]);
  });
});

describe('retryUndeliveredForRun — 사람이 버튼을 눌렀을 때', () => {
  it('카카오 대기열이 앞을 막아도 채널톡 건을 찾아 보낸다', async () => {
    // 카카오는 유저가 말을 걸 때까지 영구히 미전달이고 sent_at 도 앞선다.
    // 채널을 가르기 «전에» 잘라내면 채널톡 행이 조회에 들어오지도 못한다.
    const kakao = Array.from({ length: 6 }, (_, i) => ({
      id: `r-k${i}`,
      response_body: 'x',
      delivery_attempts: 0,
      conversation_id: `c-k${i}`,
    }));
    const channel = {
      id: 'r-ch',
      response_body: '반영됐어요',
      delivery_attempts: 0,
      conversation_id: 'c-1',
    };

    convFixtures = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `c-k${i}`,
        bot_id: 'bot-1',
        source: 'kakao',
        external_user_id: `kakao-${i}`,
        channel_person_id: null,
        last_message_at: '2026-09-10T00:00:00Z',
      })),
      CHANNEL_CONV,
    ];
    responseQueue = [
      [...kakao, channel], // 전송 전
      kakao, // 채널톡 건은 나갔고 카카오만 남는다
    ];

    const out = await mod.retryUndeliveredForRun('run-1');

    expect(sendBotMessageMock).toHaveBeenCalledTimes(1);
    expect(sentChatIds()).toEqual(['chat-1']);
    expect(out.sent).toBe(1);
    // 카카오 6건은 실패가 아니다 — 그 유저가 말 걸 때 나가는 정상 대기열이다.
    expect(out.skippedNonChannel).toBe(6);
    expect(out.remaining).toBe(0);
  });

  it('그 사람의 가장 최근 대화로 다시 보낸다 — 옛 챗은 닫혀 있을 수 있다', async () => {
    convFixtures = [
      { ...CHANNEL_CONV, id: 'c-old', external_user_id: 'chat-old', last_message_at: '2026-09-01T00:00:00Z' },
      { ...CHANNEL_CONV, id: 'c-new', external_user_id: 'chat-new', last_message_at: '2026-09-10T00:00:00Z' },
    ];
    responseQueue = [
      [{ id: 'r1', response_body: '반영됐어요', delivery_attempts: 0, conversation_id: 'c-old' }],
      [],
    ];

    const out = await mod.retryUndeliveredForRun('run-1');

    expect(out).toEqual({
      sent: 1,
      failed: 0,
      remaining: 0,
      exhausted: 0,
      skippedNonChannel: 0,
    });
    expect(sendBotMessageMock).toHaveBeenCalledWith('bot-1', 'chat-new', '반영됐어요', {
      timeoutMs: mod.MANUAL_RETRY_TIMEOUT_MS,
    });
  });

  it('run 으로 좁히고 되돌림·미전달 조건을 건다', async () => {
    responseQueue = [[]];
    await mod.retryUndeliveredForRun('run-9');

    const f = filtersOf('responses', 'select');
    expect(f).toContainEqual(['eq', 'auto_dev_run_id', 'run-9']);
    expect(f).toContainEqual(['eq', 'response_type', 'loop_closed']);
    expect(f).toContainEqual(['is', 'delivered_at', null]);
    expect(sendBotMessageMock).not.toHaveBeenCalled();
  });

  it('조회 자체를 자르지 않는다 — 자르는 일은 채널을 가른 뒤에 한다', async () => {
    responseQueue = [[]];
    await mod.retryUndeliveredForRun('run-9');

    const limits = filtersOf('responses', 'select').filter((f) => f[0] === 'limit');
    expect(limits).toHaveLength(0);
  });

  it('한 번에 보내는 건수는 채널톡 건만 세어 제한한다', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      response_body: 'x',
      delivery_attempts: 0,
      conversation_id: `c${i}`,
    }));
    convFixtures = rows.map((r, i) => ({
      id: r.conversation_id,
      bot_id: 'bot-1',
      source: 'channel',
      external_user_id: `chat-${i}`,
      channel_person_id: `person-${i}`,
      last_message_at: '2026-09-10T00:00:00Z',
    }));
    responseQueue = [rows, rows.slice(mod.MANUAL_RETRY_MAX)];

    const out = await mod.retryUndeliveredForRun('run-1');

    expect(sendBotMessageMock).toHaveBeenCalledTimes(mod.MANUAL_RETRY_MAX);
    expect(out.sent).toBe(mod.MANUAL_RETRY_MAX);
    expect(out.remaining).toBe(8 - mod.MANUAL_RETRY_MAX);
  });

  it('5회를 다 쓴 건은 보내지 않고 exhausted 로 따로 센다', async () => {
    convFixtures = [
      CHANNEL_CONV,
      { ...CHANNEL_CONV, id: 'c-2', external_user_id: 'chat-2', channel_person_id: 'person-2' },
    ];
    const rows = [
      { id: 'r1', response_body: 'x', delivery_attempts: 5, conversation_id: 'c-1' },
      { id: 'r2', response_body: 'y', delivery_attempts: 1, conversation_id: 'c-2' },
    ];
    responseQueue = [rows, [rows[0]]];

    const out = await mod.retryUndeliveredForRun('run-1');

    // 다시 눌러도 안 나가는 것과 나갈 것을 섞으면 운영자가 영원히 버튼을 누른다.
    expect(sentChatIds()).toEqual(['chat-2']);
    expect(out.sent).toBe(1);
    expect(out.exhausted).toBe(1);
    expect(out.remaining).toBe(0);
  });

  it('person 키가 없으면 그 대화로 그대로 보낸다', async () => {
    convFixtures = [{ ...CHANNEL_CONV, channel_person_id: null }];
    responseQueue = [
      [{ id: 'r1', response_body: 'x', delivery_attempts: 0, conversation_id: 'c-1' }],
      [],
    ];

    await mod.retryUndeliveredForRun('run-1');
    expect(sentChatIds()).toEqual(['chat-1']);
  });

  it('이번에 실패한 건은 remaining 에 남는다 — 다시 누르면 된다', async () => {
    convFixtures = [{ ...CHANNEL_CONV, channel_person_id: null }];
    responseQueue = [
      [{ id: 'r1', response_body: 'x', delivery_attempts: 0, conversation_id: 'c-1' }],
      [{ id: 'r1', response_body: 'x', delivery_attempts: 1, conversation_id: 'c-1' }],
    ];
    sendBotMessageMock.mockResolvedValue({ ok: false, status: 500, message: '전송 실패' });

    const out = await mod.retryUndeliveredForRun('run-1');

    expect(out.sent).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.remaining).toBe(1);
    expect(out.exhausted).toBe(0);
  });

  it('요약은 전송을 마친 뒤에 센다 — 방금 나간 것이 남은 것으로 보이면 안 된다', async () => {
    convFixtures = [{ ...CHANNEL_CONV, channel_person_id: null }];
    responseQueue = [
      [{ id: 'r1', response_body: 'x', delivery_attempts: 0, conversation_id: 'c-1' }],
      [],
    ];

    const out = await mod.retryUndeliveredForRun('run-1');
    expect(out.sent).toBe(1);
    expect(out.remaining).toBe(0);
  });
});

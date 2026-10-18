import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 암호화 키는 crypto 모듈이 «로드 시점에» 읽는다. import 보다 먼저 세운다.
process.env.BOT_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

// ── after() ────────────────────────────────────────
// 라우트는 200 을 준 뒤에 본 처리를 한다. 테스트는 그 작업을 붙잡아 두고
// 「응답이 빨랐나」와 「그래서 무엇이 생겼나」를 따로 본다.

let afterTasks: Promise<unknown>[] = [];

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: Promise<unknown>) => {
      afterTasks.push(Promise.resolve(task));
    },
  };
});

async function drainAfter() {
  const tasks = afterTasks;
  afterTasks = [];
  await Promise.all(tasks);
}

// ── Supabase 흉내 ───────────────────────────────────
// 테이블별로 무엇이 들어갔는지 기록한다. 라우트가 「아무 행도 안 만든다」를
// 단언하려면 행 수를 실제로 셀 수 있어야 한다.

interface Op {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
}

let ops: Op[] = [];
let botRow: Record<string, unknown> | null = null;
let rateCount = 0;
let pendingResponses: unknown[] = [];
let conversationRow: Record<string, unknown> | null = null;
/** 이미 저장돼 있던 person 키. 상담원 메시지가 이걸 덮지 않아야 한다. */
let storedPersonId: string | null = null;
let seenMessageIds = new Set<string>();
let throwOn = new Set<string>();
let responseSeq = 0;

const rowsOf = (table: string, op = 'insert') =>
  ops.filter((o) => o.table === table && o.op === op);

/**
 * 호출된 RPC. 인사이트는 더 이상 `insights` 로 직접 insert 되지 않는다 —
 * `pipeline_settle_insight` 가 메시지 상태와 인사이트를 한 트랜잭션에 남긴다.
 * 그래서 「인사이트가 생겼나」는 여기서 본다.
 */
const rpcCalls: { fn: string; args: unknown }[] = [];
const settleCalls = () => rpcCalls.filter((c) => c.fn === 'pipeline_settle_insight');

function resolveOp(rec: Op): Record<string, unknown> {
  const key = `${rec.table}.${rec.op}`;
  if (throwOn.has(key)) throw new Error('db exploded');

  if (rec.table === 'bots' && rec.op === 'select') {
    return { data: botRow, error: botRow ? null : { message: 'no rows' } };
  }
  if (rec.table === 'messages' && rec.op === 'select') {
    return { count: rateCount, error: null };
  }
  if (rec.table === 'messages' && rec.op === 'insert') {
    const id = (rec.payload as { external_message_id?: string }).external_message_id ?? '';
    if (seenMessageIds.has(id)) {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    seenMessageIds.add(id);
    return { data: { id: `msg-${seenMessageIds.size}` }, error: null };
  }
  if (rec.table === 'conversations' && rec.op === 'upsert') {
    // 진짜 upsert 처럼 «쓴 값» 을 돌려준다. payload 에 키가 없으면 이미 저장돼 있던
    // 값이 남는다 — 상담원 메시지가 고객 키를 덮지 않는지 보려면 이 구분이 필요하다.
    const written = (rec.payload as { channel_person_id?: string }).channel_person_id;
    return {
      data: {
        id: 'conv-1',
        bot_id: 'bot',
        source: 'channel',
        external_user_id: 'chat-1',
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        channel_person_id: written ?? storedPersonId,
      },
      error: null,
    };
  }
  if (rec.table === 'conversations' && rec.op === 'select') {
    return { data: conversationRow, error: conversationRow ? null : { message: 'none' } };
  }
  if (rec.table === 'responses' && rec.op === 'select') {
    return { data: pendingResponses, error: null };
  }
  if (rec.table === 'responses' && rec.op === 'insert') {
    responseSeq += 1;
    return { data: { id: `resp-${responseSeq}` }, error: null };
  }
  return { data: null, error: null, count: 0 };
}

function chain(table: string, op: string, payload?: unknown) {
  const rec: Op = { table, op, payload, filters: [] };
  ops.push(rec);

  const self: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'lt', 'gt', 'gte', 'order', 'limit', 'select', 'not']) {
    self[m] = (a?: unknown) => {
      rec.filters.push([m, a]);
      return self;
    };
  }
  self.single = async () => resolveOp(rec);
  self.then = (res: (v: unknown) => void, rej?: (e: unknown) => void) => {
    try {
      res(resolveOp(rec));
    } catch (err) {
      if (rej) rej(err);
      else throw err;
    }
  };
  return self;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => ({
      select: (_cols?: unknown, _opts?: unknown) => chain(table, 'select'),
      insert: (payload: unknown) => chain(table, 'insert', payload),
      upsert: (payload: unknown) => chain(table, 'upsert', payload),
      update: (payload: unknown) => chain(table, 'update', payload),
    }),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: 1, error: null };
    },
  }),
}));

// ── 자동 묶기(I-10) ────────────────────────────────
// 라우트가 되돌림 재전송 «뒤»에 건다. 호출 시점의 responses 조회 수를 같이 적어 순서를 단언한다.
const scheduleAutoGroupingMock = vi.fn(async (_botId: string) => ({ ran: false, reason: 'not_waiter' as const }));
const scheduleSeenResponseSelects: number[] = [];
vi.mock('@/lib/groups/auto-grouping', () => ({
  scheduleAutoGrouping: (botId: string) => {
    scheduleSeenResponseSelects.push(rowsOf('responses', 'select').length);
    return scheduleAutoGroupingMock(botId);
  },
}));

// ── 봇 설정 · LLM · 채널 전송 ───────────────────────

const markBotConnectedMock = vi.fn(async () => {});

vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  return { ...actual, markBotConnected: markBotConnectedMock };
});

vi.mock('@/lib/bot/core', () => ({
  getBotConfigFromDB: async () => ({
    botId: 'bot',
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: '널널투어',
      botTone: '친근한 한국어.',
      serviceName: '널널투어',
      serviceUrl: '',
      serviceDescription: '',
      serviceCompany: '',
      targetUsers: '',
      serviceFeatures: [],
      loginMethod: '',
      faq: [],
      knowledge: '',
    },
    cooldownIntervalSec: 30,
    cooldownMaxDaily: 50,
    dailyReplyLimit: null,
    llmApiKeyEncrypted: null,
    llmProvider: null,
    llmModel: null,
    llmKeyFailedAt: null,
  }),
}));

const callLlmMock = vi.fn(async () => JSON.stringify({
  response: '접수했어요',
  insight: { category: 'bug', summary: '쿠폰함 오류', sentiment: 'negative' },
}) as string | null);

vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return { ...actual, callLlm: callLlmMock };
});

const sendBotMessageMock = vi.fn(async () => ({ ok: true }) as { ok: boolean });

vi.mock('@/lib/channel/client', () => ({
  sendBotMessage: sendBotMessageMock,
}));

// ── 요청 흉내 ───────────────────────────────────────

function request(body: unknown, contentLength?: string, query = '') {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    headers: {
      get: (k: string) => (k === 'content-length' ? (contentLength ?? String(raw.length)) : null),
    },
    // 채널톡은 `?token=` 을 쿼리로 붙여 보낸다(실측 E2). 라우트가 읽는 것은 searchParams 하나다.
    nextUrl: new URL(`https://feedloop.test/api/channel/webhook/bot/token${query}`),
    text: async () => raw,
  } as unknown as import('next/server').NextRequest;
}

const BOT_ID = '35028c5f-bfce-4761-980d-ad6874a9b6ea';
let TOKEN = '';

function messageEvent(over: Record<string, unknown> = {}) {
  return {
    event: 'push',
    type: 'Message',
    entity: {
      id: 'ext-msg-1',
      chatId: 'chat-1',
      chatType: 'userChat',
      personType: 'user',
      personId: 'person-1',
      plainText: '쿠폰함이 안 열려요',
      ...over,
    },
  };
}

let POST: typeof import('@/app/api/channel/webhook/[botId]/[token]/route').POST;
let GET: typeof import('@/app/api/channel/webhook/[botId]/[token]/route').GET;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

async function call(token: string, body: unknown, contentLength?: string, botId = BOT_ID, query = '') {
  return POST(request(body, contentLength, query), { params: Promise.resolve({ botId, token }) });
}

beforeEach(async () => {
  vi.resetModules();
  ops = [];
  afterTasks = [];
  rateCount = 0;
  pendingResponses = [];
  seenMessageIds = new Set();
  throwOn = new Set();
  responseSeq = 0;
  rpcCalls.length = 0;
  conversationRow = { bot_id: BOT_ID, source: 'channel', external_user_id: 'chat-1' };
  storedPersonId = null;
  markBotConnectedMock.mockClear();
  callLlmMock.mockClear();
  sendBotMessageMock.mockClear();
  sendBotMessageMock.mockResolvedValue({ ok: true });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const { encrypt } = await import('@/lib/utils/crypto');
  const { generateWebhookToken } = await import('@/lib/channel/verify');
  TOKEN = generateWebhookToken();

  botRow = {
    id: BOT_ID,
    status: 'active',
    channel_webhook_token_encrypted: encrypt(TOKEN),
    channel_webhook_verify_token_encrypted: null,
    channel_id: null,
  };

  ({ POST, GET } = await import('@/app/api/channel/webhook/[botId]/[token]/route'));
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('무인증 경로의 문 — 거절은 전부 404 다', () => {
  it('토큰이 틀리면 404 다. 401 을 주면 봇이 있다는 걸 알려주게 된다', async () => {
    const { generateWebhookToken } = await import('@/lib/channel/verify');
    const res = await call(generateWebhookToken(), messageEvent());
    expect(res.status).toBe(404);
    expect(rowsOf('messages')).toHaveLength(0);
  });

  it('토큰 형식이 아니면 DB 를 읽지도 않는다', async () => {
    const res = await call('../../etc', messageEvent());
    expect(res.status).toBe(404);
    expect(ops).toHaveLength(0);
  });

  it('botId 가 UUID 가 아니면 404 다', async () => {
    const res = await call(TOKEN, messageEvent(), undefined, 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(ops).toHaveLength(0);
  });

  it('봇이 없거나 멈춰 있으면 404 다', async () => {
    botRow = null;
    expect((await call(TOKEN, messageEvent())).status).toBe(404);

    const { encrypt } = await import('@/lib/utils/crypto');
    botRow = {
      id: BOT_ID,
      status: 'paused',
      channel_webhook_token_encrypted: encrypt(TOKEN),
      channel_id: null,
    };
    expect((await call(TOKEN, messageEvent())).status).toBe(404);
  });

  it('본문이 64KB 를 넘으면 413 이다', async () => {
    const res = await call(TOKEN, messageEvent(), String(70 * 1024));
    expect(res.status).toBe(413);
    expect(rowsOf('messages')).toHaveLength(0);
  });

  it('JSON 이 아니면 400 이다', async () => {
    const res = await call(TOKEN, 'not json at all');
    expect(res.status).toBe(400);
  });

  it('페이로드의 채널 id 가 봇에 저장된 것과 다르면 404 다', async () => {
    botRow = { ...(botRow as object), channel_id: 'ch-mine' };
    const res = await call(TOKEN, { ...messageEvent(), channelId: 'ch-someone-else' });
    expect(res.status).toBe(404);
    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
  });

  it('봇당 분당 상한을 넘으면 429 다 — 200 을 주기 전에 센다', async () => {
    rateCount = 120;
    const res = await call(TOKEN, messageEvent());
    expect(res.status).toBe(429);
    expect(rowsOf('messages')).toHaveLength(0);
  });
});

describe('채널톡 ?token= 대조 — 운영자가 저장해 둔 경우에만(실측 E2)', () => {
  const VERIFY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  async function storeVerifyToken() {
    const { encrypt } = await import('@/lib/utils/crypto');
    botRow = { ...(botRow as object), channel_webhook_verify_token_encrypted: encrypt(VERIFY) };
  }

  it('저장 안 했으면 쿼리가 없어도, 엉뚱한 값이어도 종전처럼 받는다', async () => {
    expect((await call(TOKEN, messageEvent())).status).toBe(200);
    expect((await call(TOKEN, messageEvent({ id: 'ext-msg-2' }), undefined, BOT_ID, '?token=whatever')).status).toBe(200);
    await drainAfter();
    expect(rowsOf('messages')).toHaveLength(2);
  });

  it('저장했으면 맞는 토큰이 붙은 요청만 받는다', async () => {
    await storeVerifyToken();
    const res = await call(TOKEN, messageEvent(), undefined, BOT_ID, `?token=${VERIFY}`);
    expect(res.status).toBe(200);
    await drainAfter();
    expect(rowsOf('messages')).toHaveLength(1);
  });

  it('저장했는데 쿼리가 없거나 다르면 404 다 — 경로 세그먼트만 새어도 못 들어온다', async () => {
    await storeVerifyToken();
    expect((await call(TOKEN, messageEvent())).status).toBe(404);
    expect((await call(TOKEN, messageEvent(), undefined, BOT_ID, '?token=a1b2c3d4e5f60718293a4b5c6d7e8f91')).status).toBe(404);
    await drainAfter();
    expect(rowsOf('messages')).toHaveLength(0);
    // 본문을 읽기 전에 막는다 — 거절된 요청은 속도 제한 카운터도 건드리지 않는다.
    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
  });

  it('대조 실패는 봇 id 만 남긴다 — 제시된 값도 저장된 값도 로그에 안 찍힌다', async () => {
    await storeVerifyToken();
    const presented = 'a1b2c3d4e5f60718293a4b5c6d7e8f91';
    await call(TOKEN, messageEvent(), undefined, BOT_ID, `?token=${presented}`);

    const logged = warnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain(BOT_ID);
    expect(logged).not.toContain(presented);
    expect(logged).not.toContain(VERIFY);
  });
});

describe('만들지 않는 것', () => {
  it('알 수 없는 이벤트는 200 이되 아무것도 만들지 않는다', async () => {
    const res = await call(TOKEN, { type: 'Manager', entity: { id: 'x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: 'unknown_type' });
    await drainAfter();
    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
  });

  it('그룹 챗이면 대화·메시지·인사이트를 하나도 만들지 않는다', async () => {
    const res = await call(TOKEN, messageEvent({ chatType: 'group' }));
    expect(await res.json()).toMatchObject({ ignored: 'not_user_chat' });
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
    expect(rowsOf('messages')).toHaveLength(0);
    expect(rowsOf('insights')).toHaveLength(0);
  });

  it('ALF(봇) 답변은 기록하지 않는다', async () => {
    await call(TOKEN, messageEvent({ personType: 'bot', id: 'ext-bot-1' }));
    await drainAfter();

    expect(rowsOf('messages')).toHaveLength(0);
    expect(rowsOf('responses')).toHaveLength(0);
    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
  });

  it('본문이 빈 메시지(파일만)는 저장하지 않는다', async () => {
    const res = await call(TOKEN, messageEvent({ plainText: '   ' }));
    expect(await res.json()).toMatchObject({ ignored: 'empty_text' });
    await drainAfter();
    expect(rowsOf('messages')).toHaveLength(0);
  });
});

describe('유저 메시지 → 자동 묶기(I-10)', () => {
  beforeEach(() => {
    scheduleAutoGroupingMock.mockClear();
    scheduleSeenResponseSelects.length = 0;
  });

  it('인사이트가 저장되면 되돌림 재전송 «뒤»에 자동 묶기를 건다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();
    expect(scheduleAutoGroupingMock).toHaveBeenCalledTimes(1);
    expect(scheduleAutoGroupingMock).toHaveBeenCalledWith(BOT_ID);
    // 재전송(responses 조회)이 먼저 돌았다 — 대기자가 재전송을 굶기지 않는다(보안 리뷰 H1).
    expect(scheduleSeenResponseSelects[0]).toBeGreaterThan(0);
  });

  it('같은 messageId 재전송은 묶기도 다시 걸지 않는다 — 음성 대조', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();
    await call(TOKEN, messageEvent());
    await drainAfter();
    expect(scheduleAutoGroupingMock).toHaveBeenCalledTimes(1);
  });

  it('상담원 답장은 묶기를 걸지 않는다', async () => {
    await call(TOKEN, messageEvent({ personType: 'manager' }));
    await drainAfter();
    expect(scheduleAutoGroupingMock).not.toHaveBeenCalled();
  });
});

describe('유저 메시지', () => {
  it('메시지 1행을 남기고 분류한다', async () => {
    const res = await call(TOKEN, messageEvent());
    expect(res.status).toBe(200);
    await drainAfter();

    expect(rowsOf('messages')).toHaveLength(1);
    expect(rowsOf('messages')[0].payload).toMatchObject({
      source: 'channel',
      external_message_id: 'ext-msg-1',
      external_user_id: 'chat-1',
    });
    expect(settleCalls()).toHaveLength(1);
    expect(settleCalls()[0].args).toMatchObject({
      p_bot_id: BOT_ID,
      p_insight: expect.objectContaining({ category: 'bug' }),
    });
  });

  it('같은 messageId 가 3번 와도 메시지 1행·인사이트 1행이다', async () => {
    for (let i = 0; i < 3; i += 1) {
      await call(TOKEN, messageEvent());
      await drainAfter();
    }

    const saved = rowsOf('messages').filter((o) => o.op === 'insert');
    // insert 시도는 3번이지만 유니크 인덱스가 2번을 되돌린다.
    expect(saved).toHaveLength(3);
    expect(seenMessageIds.size).toBe(1);
    // 재전송은 분류로 넘어가지 않는다 — 인사이트도 묶음도 둘이 되면 안 된다.
    expect(settleCalls()).toHaveLength(1);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  it('제보자가 보낸 시각이 창 밖이면 서버 시각으로 갈아끼운다 — 속도 제한이 이 값을 센다', async () => {
    // 2000-01-01. 이걸 그대로 저장하면 최근 60초를 세는 카운터가 영원히 0 이라
    // 무인증 경로의 상한이 통째로 무력해진다.
    await call(TOKEN, messageEvent({ createdAt: 946684800000 }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(Date.now() - new Date(detectedAt).getTime()).toBeLessThan(5_000);
  });

  it('미래로 보낸 시각도 갈아끼운다 — 앞당겨 두면 카운터를 영원히 피한다', async () => {
    await call(TOKEN, messageEvent({ createdAt: Date.now() + 365 * 24 * 3600_000 }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(Date.now() - new Date(detectedAt).getTime()).toBeLessThan(5_000);
  });

  it('과거는 한 순간도 허용하지 않는다 — 허용 폭이 속도제한 창(60초)보다 좁아야 한다', async () => {
    // 예전엔 과거 5분을 허용했다. 그 폭이 창보다 넓어서 now−120초 를 박고 messageId 만
    // 바꿔 돌리면 그대로 다시 뚫렸다. 표시 순서보다 상한의 정확성을 택했다.
    const sentAt = Date.now() - 120_000;
    await call(TOKEN, messageEvent({ createdAt: sentAt }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(new Date(detectedAt).getTime()).toBeGreaterThan(sentAt);
    expect(Date.now() - new Date(detectedAt).getTime()).toBeLessThan(5_000);
  });

  it('몇 초 전이어도 서버 시각으로 기록한다 — 도착 순서로 남는다', async () => {
    const sentAt = Date.now() - 3_000;
    await call(TOKEN, messageEvent({ createdAt: sentAt }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(new Date(detectedAt).getTime()).toBeGreaterThan(sentAt);
  });

  it('시계 차이만큼의 미래는 그대로 살린다 — 미래 값은 속도제한을 피하지 못한다', async () => {
    // 최근 60초를 세는 창에 «항상» 들어오므로 회피에 쓸 수 없다.
    const sentAt = Date.now() + 20_000;
    await call(TOKEN, messageEvent({ createdAt: sentAt }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(new Date(detectedAt).getTime()).toBe(sentAt);
  });

  it('시각이 아예 없으면 서버 시각을 쓴다', async () => {
    await call(TOKEN, messageEvent({ createdAt: undefined }));
    await drainAfter();

    const detectedAt = (rowsOf('messages')[0].payload as { detected_at: string }).detected_at;
    expect(Date.now() - new Date(detectedAt).getTime()).toBeLessThan(5_000);
  });

  it('upsertConversation 을 한 번만 부른다 — person 키를 같은 호출에 싣는다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();

    const upserts = rowsOf('conversations', 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({
      source: 'channel',
      external_user_id: 'chat-1',
      channel_person_id: 'person-1',
      channel_chat_type: 'userChat',
    });
  });

  it('personId 가 없으면 chat: 폴백으로 채운다 — NULL 을 남기지 않는다', async () => {
    await call(TOKEN, messageEvent({ personId: undefined }));
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')[0].payload).toMatchObject({
      channel_person_id: 'chat:chat-1',
    });
  });

  it('상담원 메시지는 operator 응답으로 남기고 분류하지 않는다', async () => {
    await call(
      TOKEN,
      // 상담원의 personId 는 고객과 «다르다». 같은 값으로 두면 아래 두 테스트가
      // 잡아야 할 덮어쓰기를 못 잡는다.
      messageEvent({ personType: 'manager', personId: 'manager-9', plainText: '확인해 볼게요' }),
    );
    await drainAfter();

    expect(rowsOf('responses')).toHaveLength(1);
    expect(rowsOf('responses')[0].payload).toMatchObject({ response_type: 'operator' });
    expect(rowsOf('messages')).toHaveLength(0);
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('상담원의 personId 를 person 키로 쓰지 않는다 — 상담원 한 명이 대화 수십 개를 접어버린다', async () => {
    await call(TOKEN, messageEvent({ personType: 'manager', personId: 'manager-9' }));
    await drainAfter();

    // upsert 에 키를 아예 싣지 않는다.
    const upsert = rowsOf('conversations', 'upsert')[0].payload as Record<string, unknown>;
    expect(upsert).not.toHaveProperty('channel_person_id');

    // 대신 그 챗에 묶인 결정적 폴백으로 채운다. NULL 을 남기지 않는다.
    const fill = rowsOf('conversations', 'update').find((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'channel_person_id'),
    );
    expect(fill!.payload).toEqual({ channel_person_id: 'chat:chat-1' });
    expect(JSON.stringify(fill!.payload)).not.toContain('manager-9');
  });

  it('이미 고객 키가 있는 대화에 상담원이 답해도 그 값을 덮지 않는다', async () => {
    storedPersonId = 'person-1';

    await call(TOKEN, messageEvent({ personType: 'manager', personId: 'manager-9' }));
    await drainAfter();

    const touched = rowsOf('conversations', 'update').some((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'channel_person_id'),
    );
    expect(touched).toBe(false);
  });

  it('고객 메시지는 자기 personId 를 키로 쓰고 폴백을 덧쓰지 않는다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')[0].payload).toMatchObject({
      channel_person_id: 'person-1',
    });
    const touched = rowsOf('conversations', 'update').some((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'channel_person_id'),
    );
    expect(touched).toBe(false);
  });

  it('유저가 다시 말을 걸면 밀린 되돌림을 얹는다', async () => {
    pendingResponses = [{ id: 'resp-old', response_body: '반영됐어요 (PR #5)', delivery_attempts: 0 }];

    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(sendBotMessageMock).toHaveBeenCalledTimes(1);
    expect(sendBotMessageMock.mock.calls[0]).toEqual([
      BOT_ID,
      'chat-1',
      '반영됐어요 (PR #5)',
      { timeoutMs: 1500 },
    ]);
  });
});

describe('연결 표시 · 실패 계측', () => {
  it('markBotConnected 를 부르지 않는다 — 카카오 탭이 거짓으로 「연결됨」이 된다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(markBotConnectedMock).not.toHaveBeenCalled();

    const botUpdates = rowsOf('bots', 'update');
    expect(botUpdates.length).toBeGreaterThan(0);
    for (const u of botUpdates) {
      expect(u.payload).not.toHaveProperty('last_active_at');
      expect(u.payload).not.toHaveProperty('status');
    }
  });

  it('채널 전용 칸을 최초 1회만 쓴다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();

    const connect = rowsOf('bots', 'update').find((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'channel_connected_at'),
    );
    expect(connect).toBeDefined();
    // IS NULL 조건이 붙어 있어야 메시지마다 UPDATE 가 나가지 않는다.
    expect(connect!.filters).toContainEqual(['is', 'channel_connected_at']);
  });

  it('after() 안에서 터지면 봇에 흔적을 남긴다 — 이미 200 을 줘서 재전송이 안 온다', async () => {
    throwOn.add('conversations.upsert');

    const res = await call(TOKEN, messageEvent());
    expect(res.status).toBe(200);
    await drainAfter();

    const errorUpdate = rowsOf('bots', 'update').find((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'channel_last_error'),
    );
    expect(errorUpdate).toBeDefined();
    expect((errorUpdate!.payload as { channel_last_error: string }).channel_last_error).toContain(
      'db exploded',
    );
  });

  it('본 처리가 느려도 200 은 즉시 나간다', async () => {
    callLlmMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('{}'), 400)),
    );

    const started = Date.now();
    const res = await call(TOKEN, messageEvent());
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(100);
    await drainAfter();
  });
});

describe('메시지 이벤트의 refers.userChat.state — 닫힘은 여기로만 온다(실측 E8)', () => {
  function withState(state: string | undefined, over: Record<string, unknown> = {}) {
    return {
      ...messageEvent(over),
      refers: state === undefined ? {} : { userChat: { id: 'chat-1', state } },
    };
  }

  const statusUpdates = () =>
    rowsOf('conversations', 'update').filter((u) =>
      Object.prototype.hasOwnProperty.call(u.payload, 'status'),
    );

  it('상담원이 종료하며 남긴 말에 closed 가 실려 오면 대화를 닫는다', async () => {
    await call(TOKEN, withState('closed', { personType: 'manager', personId: 'manager-9', plainText: '상담을 종료합니다' }));
    await drainAfter();

    expect(statusUpdates().map((u) => (u.payload as { status: string }).status)).toEqual(['closed']);
  });

  it('닫힌 채팅에 유저가 다시 말을 걸어 opened 가 오면 다시 연다', async () => {
    await call(TOKEN, withState('opened'));
    await drainAfter();

    expect(statusUpdates().map((u) => (u.payload as { status: string }).status)).toEqual(['open']);
  });

  it('initial(첫 문의)·모르는 상태·state 없음은 status 를 건드리지 않는다', async () => {
    await call(TOKEN, withState('initial'));
    await call(TOKEN, withState('snoozed', { id: 'ext-msg-2' }));
    await call(TOKEN, withState(undefined, { id: 'ext-msg-3' }));
    await drainAfter();

    expect(statusUpdates()).toHaveLength(0);
  });
});

describe('유저챗 이벤트', () => {
  it('연락처와 출처를 남긴다 — veil 은 검증되지 않은 값이다', async () => {
    await call(TOKEN, {
      type: 'UserChat',
      entity: { id: 'chat-1', state: 'opened' },
      refers: { veil: { id: 'veil-1', name: '익명손님' } },
    });
    await drainAfter();

    const updates = rowsOf('conversations', 'update');
    expect(updates.some((u) => (u.payload as Record<string, unknown>).contact_name === '익명손님')).toBe(true);
    expect(
      updates.some((u) => (u.payload as Record<string, unknown>).channel_contact_source === 'veil'),
    ).toBe(true);
  });

  it('닫힘이 오면 대화를 닫고, 모르는 상태는 건드리지 않는다', async () => {
    await call(TOKEN, { type: 'UserChat', entity: { id: 'chat-1', state: 'closed' } });
    await drainAfter();
    expect(
      rowsOf('conversations', 'update').some(
        (u) => (u.payload as Record<string, unknown>).status === 'closed',
      ),
    ).toBe(true);

    ops = [];
    await call(TOKEN, { type: 'UserChat', entity: { id: 'chat-1', state: 'snoozed' } });
    await drainAfter();
    expect(
      rowsOf('conversations', 'update').some((u) =>
        Object.prototype.hasOwnProperty.call(u.payload, 'status'),
      ),
    ).toBe(false);
  });
});

describe('GET — warm-up', () => {
  it('토큰이 맞으면 채널 이름을 돌려준다', async () => {
    const res = await GET(request({}), { params: Promise.resolve({ botId: BOT_ID, token: TOKEN }) });
    expect(await res.json()).toEqual({ status: 'ok', channel: 'channel', botId: BOT_ID });
  });

  it('토큰이 틀리면 404 다 — 토큰 없는 경로는 존재하지 않는다', async () => {
    const { generateWebhookToken } = await import('@/lib/channel/verify');
    const res = await GET(request({}), {
      params: Promise.resolve({ botId: BOT_ID, token: generateWebhookToken() }),
    });
    expect(res.status).toBe(404);
  });
});

// ── I-29 근본 원인 — last_message_at 은 «남은 뒤»에만 올린다 ──────────
// upsert 는 시각을 싣지 않는다. 고객 메시지·연락처가 실제로 저장된 뒤 별도 update 로 올린다.
// 상담원 답장·재전송은 올리지 않는다(2026-09-17 ny: 우리 쪽 말은 미읽음을 켜지 않는다).

const touches = () =>
  rowsOf('conversations', 'update').filter((u) => 'last_message_at' in (u.payload as Record<string, unknown>));

describe('last_message_at 쓰기 순서 (I-29)', () => {
  it('upsert 는 시각을 싣지 않고, 고객 메시지가 저장된 «뒤» update 로 올린다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')[0].payload).not.toHaveProperty('last_message_at');
    expect(touches()).toHaveLength(1);
    // 순서: messages insert 가 먼저, 시각 update 가 뒤
    const insertAt = ops.findIndex((o) => o.table === 'messages' && o.op === 'insert');
    const touchAt = ops.indexOf(touches()[0]);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(touchAt).toBeGreaterThan(insertAt);
  });

  it('같은 messageId 재전송은 시각을 다시 올리지 않는다', async () => {
    await call(TOKEN, messageEvent());
    await drainAfter();
    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(rowsOf('messages')).toHaveLength(2); // 두 번 시도, 두 번째는 중복 오류
    expect(touches()).toHaveLength(1);
  });

  it('메시지 저장이 실패하면 시각도 안 올라간다 — 유령 대화를 만들지 않는다', async () => {
    throwOn.add('messages.insert');
    await call(TOKEN, messageEvent());
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')).toHaveLength(1);
    expect(touches()).toHaveLength(0);
  });

  it('상담원 답장은 시각을 올리지 않는다 — Feedloop 받은편지함이 미읽음으로 켜지지 않는다', async () => {
    await call(TOKEN, messageEvent({ personType: 'manager', personId: 'manager-9', plainText: '확인해 볼게요' }));
    await drainAfter();

    expect(rowsOf('responses')).toHaveLength(1);
    expect(touches()).toHaveLength(0);
  });

  it('유저챗 개시에 연락처가 실려 오면 연락처를 남긴 «뒤» 시각을 올린다 — 리드로 뜬다', async () => {
    await call(TOKEN, {
      type: 'UserChat',
      entity: { id: 'chat-1', state: 'opened' },
      refers: { veil: { id: 'veil-1', name: '익명손님' } },
    });
    await drainAfter();

    const updates = rowsOf('conversations', 'update');
    const contactAt = updates.findIndex((u) => (u.payload as Record<string, unknown>).contact_name === '익명손님');
    const touchAt = updates.findIndex((u) => 'last_message_at' in (u.payload as Record<string, unknown>));
    expect(contactAt).toBeGreaterThanOrEqual(0);
    expect(touchAt).toBeGreaterThan(contactAt);
    expect(touches()).toHaveLength(1);
  });

  it('유저챗 개시에 연락처가 없으면 시각을 올리지 않는다 — 첫 메시지가 올 때 올라간다', async () => {
    await call(TOKEN, { type: 'UserChat', entity: { id: 'chat-1', state: 'opened' } });
    await drainAfter();

    expect(rowsOf('conversations', 'upsert')).toHaveLength(1);
    expect(touches()).toHaveLength(0);
  });
});

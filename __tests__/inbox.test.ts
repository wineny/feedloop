import { describe, it, expect, vi, beforeEach } from 'vitest';

// 테이블별로 다른 결과를 돌려주는 Supabase 모킹.
let convRows: unknown[] = [];
let messageRows: unknown[] = [];
let responseRows: unknown[] = [];
let botRows: unknown[] = [];
const updateCalls: { table: string; patch: Record<string, unknown> }[] = [];
const insertCalls: { table: string; row: Record<string, unknown> }[] = [];

function rowsFor(table: string) {
  if (table === 'conversations') return convRows;
  if (table === 'messages') return messageRows;
  if (table === 'bots') return botRows;
  return responseRows;
}

function selectChain(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ['in', 'is', 'gt', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // listConversations 는 배치에서 메시지를 못 찾은 대화를 conversation_id 로 하나씩 다시 본다(I-29).
  // 그 조회가 «그 대화의» 것만 돌려줘야 유령 대화 판정을 시험할 수 있다.
  let convId: string | null = null;
  chain.eq = vi.fn((col: string, v: string) => {
    if (table === 'messages' && col === 'conversation_id') convId = v;
    return chain;
  });
  chain.maybeSingle = vi.fn(async () => {
    const rows = rowsFor(table) as { conversation_id?: string }[];
    const hit = convId ? rows.find((r) => r.conversation_id === convId) : rows[0];
    return { data: hit ?? null, error: null };
  });
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: rowsFor(table), error: null });
  return chain;
}

function updateChain(table: string, patch: Record<string, unknown>) {
  updateCalls.push({ table, patch });
  const chain: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'is']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null });
  return chain;
}

function insertChain(table: string, row: Record<string, unknown>) {
  insertCalls.push({ table, row });
  return {
    select: vi.fn(() => ({
      single: vi.fn(async () => ({ data: { id: 'new-id' }, error: null })),
    })),
  };
}

const fromMock = vi.fn((table: string) => ({
  select: vi.fn(() => selectChain(table)),
  update: vi.fn((patch: Record<string, unknown>) => updateChain(table, patch)),
  insert: vi.fn((row: Record<string, unknown>) => insertChain(table, row)),
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ from: fromMock }),
}));

// 라우트 테스트는 인가를 여기서 끊는다 — next-auth 세션을 끌고 들어오지 않게.
const { resolveOwnedBots } = vi.hoisted(() => ({ resolveOwnedBots: vi.fn() }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));

type Mod = typeof import('@/lib/bot/conversations');

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('@/lib/bot/conversations');
}

beforeEach(() => {
  vi.clearAllMocks();
  convRows = [];
  messageRows = [];
  responseRows = [];
  botRows = [];
  updateCalls.length = 0;
  insertCalls.length = 0;
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'u1', botIds: ['bot-1'] });
});

describe('listConversations — 미읽음 판정', () => {
  it('마지막 메시지가 읽은 시각보다 뒤면 미읽음이다', async () => {
    convRows = [
      {
        id: 'c1', source: 'web', external_user_id: 'v1',
        contact_name: null, contact_email: null,
        last_message_at: '2026-09-06T10:05:00Z',
        operator_read_at: '2026-09-06T10:00:00Z',
      },
      {
        id: 'c2', source: 'kakao', external_user_id: 'k1',
        contact_name: '김방문', contact_email: null,
        last_message_at: '2026-09-06T09:00:00Z',
        operator_read_at: '2026-09-06T09:30:00Z',
      },
      {
        // 한 번도 안 열어본 대화
        id: 'c3', source: 'web', external_user_id: 'v2',
        contact_name: null, contact_email: null,
        last_message_at: '2026-09-06T08:00:00Z',
        operator_read_at: null,
      },
    ];
    messageRows = [
      { conversation_id: 'c1', body: '최신', detected_at: '2026-09-06T10:05:00Z' },
      { conversation_id: 'c1', body: '옛것', detected_at: '2026-09-06T10:01:00Z' },
      { conversation_id: 'c2', body: 'c2 메시지', detected_at: '2026-09-06T09:00:00Z' },
    ];

    const { listConversations } = await load();
    const items = await listConversations(['bot-1']);

    // c3 은 메시지가 0건인 유령 대화(저장 실패 뒤 last_message_at 만 찍힌 것) — 목록에서 거른다(I-29)
    expect(items.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(items.map((i) => i.unread)).toEqual([true, false]);
    // 대화마다 가장 최근 본문 하나만 접는다
    expect(items[0].lastMessageBody).toBe('최신');
  });

  it('봇이 없으면 조회 자체를 하지 않는다', async () => {
    const { listConversations } = await load();
    await expect(listConversations([])).resolves.toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('카카오 대기열', () => {
  it('아직 전달 안 된 응답만 꺼낸다', async () => {
    responseRows = [
      { id: 'r1', response_body: '밀린 답장' },
      { id: 'r2', response_body: '되돌림 알림' },
    ];

    const { getUndeliveredResponses } = await load();
    const queued = await getUndeliveredResponses('c1', 2);

    expect(queued).toEqual([
      { id: 'r1', body: '밀린 답장' },
      { id: 'r2', body: '되돌림 알림' },
    ]);
  });

  it('전달 처리는 아직 미전달인 것에만 걸어 두 번 보내지 않는다', async () => {
    const { markResponsesDelivered } = await load();
    await markResponsesDelivered(['r1', 'r2']);

    const call = updateCalls.find((c) => c.table === 'responses');
    expect(call?.patch.delivered_at).toBeTruthy();
  });

  it('빈 목록이면 쓰기를 시도하지 않는다', async () => {
    const { markResponsesDelivered } = await load();
    await markResponsesDelivered([]);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('saveConversationResponse — 전달 시점', () => {
  it('delivered=false 면 delivered_at 을 비워 대기열에 남긴다', async () => {
    const { saveConversationResponse } = await load();

    await saveConversationResponse({
      botId: 'b1', conversationId: 'c1', responseType: 'operator',
      body: '카카오 답장', delivered: false,
    });
    await saveConversationResponse({
      botId: 'b1', conversationId: 'c1', responseType: 'operator',
      body: '웹 답장', delivered: true,
    });

    const rows = insertCalls.filter((c) => c.table === 'responses').map((c) => c.row);
    expect(rows[0].delivered_at).toBeNull();
    expect(rows[1].delivered_at).toBeTruthy();
  });
});

// ── AI 가 못 답한 대화 (계획 §A-4) ─────────────────────
//
// "미읽음"으로는 이걸 구별할 수 없다. upsertConversation 이 last_message_at 을
// 갱신하므로 AI 가 답했든 못 답했든 새 메시지가 온 대화는 전부 미읽음이다.

describe('needsEscalation — 사람이 이어받아야 하는가', () => {
  it('LLM 호출 자체가 실패하면(null) 넘긴다', async () => {
    const { needsEscalation } = await load();
    expect(needsEscalation(null)).toBe(true);
    expect(needsEscalation(undefined)).toBe(true);
  });

  it('출력 파싱이 깨졌으면(parsed:false) 넘긴다 — 답이 채워져 있어도', async () => {
    const { needsEscalation } = await load();
    expect(needsEscalation({ response: '아무 말', parsed: false })).toBe(true);
  });

  it('모델이 스스로 escalate 를 켰으면 넘긴다', async () => {
    const { needsEscalation } = await load();
    expect(needsEscalation({ response: '팀에 확인해서 알려드릴게요', escalate: true })).toBe(true);
  });

  it('정상 파싱인데 할 말이 없으면 넘긴다 — 결국 방문자는 답을 못 받는다', async () => {
    const { needsEscalation } = await load();
    expect(needsEscalation({ response: null, parsed: true, escalate: false })).toBe(true);
  });

  it('제대로 답했으면 넘기지 않는다', async () => {
    const { needsEscalation } = await load();
    expect(needsEscalation({ response: '쿠폰은 결제 화면에서 적용돼요', parsed: true, escalate: false })).toBe(false);
  });
});

describe('escalated_at 기록과 해소', () => {
  it('markConversationEscalated 는 시각을 찍는다', async () => {
    const { markConversationEscalated } = await load();
    await markConversationEscalated('c1');

    const call = updateCalls.find((u) => u.table === 'conversations');
    expect(call).toBeDefined();
    expect(typeof call!.patch.escalated_at).toBe('string');
  });

  it('markHandoffRequested 는 배지와 위젯 상태 줄을 같은 시각으로 같이 찍는다', async () => {
    const { markHandoffRequested } = await load();
    await markHandoffRequested('c1');

    const call = updateCalls.find((u) => u.table === 'conversations');
    expect(call).toBeDefined();
    expect(typeof call!.patch.escalated_at).toBe('string');
    expect(call!.patch.handoff_requested_at).toBe(call!.patch.escalated_at);
  });

  it('markConversationEscalated(AI 물러남)는 위젯 상태 줄(handoff_requested_at)을 건드리지 않는다', async () => {
    const { markConversationEscalated } = await load();
    await markConversationEscalated('c1');

    const call = updateCalls.find((u) => u.table === 'conversations');
    expect(call!.patch).not.toHaveProperty('handoff_requested_at');
  });

  it('clearConversationEscalated 는 둘 다 null 로 되돌린다 — 사람이 답했으니 해소다', async () => {
    const { clearConversationEscalated } = await load();
    await clearConversationEscalated('c1');

    const call = updateCalls.find((u) => u.table === 'conversations');
    expect(call).toBeDefined();
    expect(call!.patch).toEqual({ escalated_at: null, handoff_requested_at: null });
  });

  it('listConversations 가 escalated 를 미읽음과 별개로 싣는다', async () => {
    convRows = [
      {
        id: 'c1', source: 'web', external_user_id: 'v1',
        contact_name: null, contact_email: null,
        last_message_at: '2026-09-10T10:05:00Z',
        // 이미 읽었는데도 escalated 는 살아 있어야 한다 — 답장을 해야 꺼진다.
        operator_read_at: '2026-09-10T10:06:00Z',
        escalated_at: '2026-09-10T10:05:01Z',
      },
      {
        id: 'c2', source: 'kakao', external_user_id: 'k1',
        contact_name: null, contact_email: null,
        last_message_at: '2026-09-10T09:00:00Z',
        operator_read_at: null,
        escalated_at: null,
      },
    ];
    // 메시지가 있어야 목록에 남는다(I-29) — 이 테스트가 보는 것은 escalated 이므로 한 건씩만 둔다
    messageRows = [
      { conversation_id: 'c1', body: 'c1', detected_at: '2026-09-10T10:05:00Z' },
      { conversation_id: 'c2', body: 'c2', detected_at: '2026-09-10T09:00:00Z' },
    ];

    const { listConversations } = await load();
    const items = await listConversations(['bot-1']);

    expect(items[0].escalated).toBe(true);
    expect(items[0].unread).toBe(false);
    expect(items[1].escalated).toBe(false);
    expect(items[1].unread).toBe(true);
  });
});

// ── 채널톡 답장 정책 (계획 §3-(d) A · 단계 6) ─────────────
//
// 답장 창구를 둘로 만들면 「누가 이미 답했나」가 흐려진다. 그래서 받은편지함은
// 채널톡 대화에서 답장을 «받지 않고» 데스크 링크를 돌려준다. 저장 경로에도 닿지 않아야 한다.

const CHANNEL_CONV = {
  id: 'ch-conv-1',
  bot_id: 'bot-1',
  source: 'channel',
  external_user_id: 'chat-77',
};

const SECRET = 'TESTSECRET-a1b2c3';

/** 모킹은 select 목록을 무시하고 행 전체를 준다 — 라우트가 무엇을 «내보내는지» 를 본다. */
const CHANNEL_BOT = {
  id: 'bot-1',
  channel_slug: 'nullnul',
  channel_access_key_encrypted: SECRET,
  channel_access_secret_encrypted: SECRET,
  channel_webhook_token_encrypted: SECRET,
};

async function postReply(conversationId: string, text = '데스크에서 답할게요') {
  vi.resetModules();
  const { POST } = await import('@/app/api/inbox/[conversationId]/reply/route');
  const res = await POST(
    new Request('https://feedloop.test/api/inbox/x/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }),
    { params: Promise.resolve({ conversationId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/inbox/[id]/reply — 채널톡은 받지 않는다', () => {
  it('채널톡 대화면 409 로 끊는다', async () => {
    convRows = [CHANNEL_CONV];
    botRows = [CHANNEL_BOT];

    const { status } = await postReply(CHANNEL_CONV.id);
    expect(status).toBe(409);
  });

  it('409 본문이 그 유저챗을 여는 데스크 주소를 담는다', async () => {
    convRows = [CHANNEL_CONV];
    botRows = [CHANNEL_BOT];

    const { body } = await postReply(CHANNEL_CONV.id);
    expect(body.deskUrl).toBe('https://desk.channel.io/nullnul/user-chats/chat-77');
  });

  it('slug 를 아직 모르면 데스크 첫 화면으로 보낸다 — 링크가 막다른 길이 되지 않게', async () => {
    convRows = [CHANNEL_CONV];
    botRows = [{ ...CHANNEL_BOT, channel_slug: null }];

    const { body } = await postReply(CHANNEL_CONV.id);
    expect(body.deskUrl).toBe('https://desk.channel.io');
  });

  it('responses 를 한 행도 만들지 않는다 — 본문을 읽기 전에 끊는다', async () => {
    convRows = [CHANNEL_CONV];
    botRows = [CHANNEL_BOT];

    await postReply(CHANNEL_CONV.id);
    expect(insertCalls.filter((c) => c.table === 'responses')).toHaveLength(0);
  });

  it('응답 본문에 자격증명 문자열이 섞이지 않는다 (원칙 4)', async () => {
    convRows = [CHANNEL_CONV];
    botRows = [CHANNEL_BOT];

    const { body } = await postReply(CHANNEL_CONV.id);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('웹 대화는 종전대로 저장된다 — 무회귀', async () => {
    convRows = [{ ...CHANNEL_CONV, id: 'web-conv-1', source: 'web' }];

    const { status, body } = await postReply('web-conv-1');
    expect(status).toBe(200);
    expect(body.delivered).toBe(true);
    expect(insertCalls.filter((c) => c.table === 'responses')).toHaveLength(1);
  });
});

// ── 수동 대화 닫기 (단계 6) ──────────────────────────
//
// 채널톡의 「닫힘」을 전달하는 웹훅 스코프가 미확인이다(§3-(f)). 그 이벤트가 안 와도
// 받은편지함이 끝난 상담을 열린 것으로 보여주지 않게, 운영자가 직접 닫는 길을 둔다.

async function postClose(conversationId: string) {
  vi.resetModules();
  const { POST } = await import('@/app/api/inbox/[conversationId]/close/route');
  const res = await POST(new Request('https://feedloop.test/api/inbox/x/close', { method: 'POST' }), {
    params: Promise.resolve({ conversationId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/inbox/[id]/close — 수동 닫기', () => {
  it('대화를 closed 로 바꾼다', async () => {
    convRows = [CHANNEL_CONV];

    const { status } = await postClose(CHANNEL_CONV.id);
    expect(status).toBe(200);

    const call = updateCalls.find((u) => u.table === 'conversations' && u.patch.status);
    expect(call?.patch).toEqual({ status: 'closed' });
  });

  it('남의 봇 대화는 403 이고 아무것도 바꾸지 않는다', async () => {
    convRows = [CHANNEL_CONV];
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: '해당 봇에 대한 권한이 없습니다' });

    const { status } = await postClose(CHANNEL_CONV.id);
    expect(status).toBe(403);
    expect(updateCalls.filter((u) => u.patch.status === 'closed')).toHaveLength(0);
  });

  it('무인증이면 401 이다', async () => {
    convRows = [CHANNEL_CONV];
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    const { status } = await postClose(CHANNEL_CONV.id);
    expect(status).toBe(401);
  });

  it('없는 대화는 404 다', async () => {
    convRows = [];
    const { status } = await postClose('nope');
    expect(status).toBe(404);
  });
});

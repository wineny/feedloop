import { describe, it, expect, vi, beforeEach } from 'vitest';

// I-29 근본 원인 — 쓰기 «순서».
//
// 예전엔 upsertConversation 이 대화를 열면서 last_message_at 을 같이 찍고, 메시지는 그 뒤에 저장했다.
// 저장이 실패하면(I-23 경로) 시각만 있는 «유령 대화»가 받은편지함에 빈 미읽음 줄로 떴다.
// 이제 upsert 는 시각을 건드리지 않고, 저장이 «성공한 뒤» 호출부가 touchConversation 으로 찍는다.
//
// 여기서는 대화 계층의 두 함수(upsert 가 시각을 안 싣는가 · touch 가 시각만 올리는가)와,
// 메시지 없이 연락처만 남기는 위젯 라우트(연락처가 실제로 남은 뒤에만 올리는가)를 본다.
// 채널별 라우트는 각 라우트의 테스트 파일에 있다 — reply-limit(위젯 메시지)·widget-escalate·channel-webhook·kakao-insight-save-failure.

interface Op {
  table: string;
  op: string;
  payload?: unknown;
}
let ops: Op[] = [];
/** 어떤 (table.op) 을 실패시킬지 */
let failOn = new Set<string>();

const rowsOf = (table: string, op: string) => ops.filter((o) => o.table === table && o.op === op);

function chain(table: string, op: string, payload?: unknown) {
  const rec: Op = { table, op, payload };
  ops.push(rec);
  const self: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'order', 'limit', 'select', 'not']) self[m] = () => self;
  const resolve = () => {
    if (failOn.has(`${table}.${op}`)) return { data: null, error: { message: 'db exploded' } };
    if (table === 'conversations' && op === 'upsert') {
      return {
        data: {
          id: 'conv-1',
          bot_id: 'bot-1',
          source: 'web',
          external_user_id: 'v-1',
          contact_name: null,
          contact_email: null,
          contact_phone: null,
          escalated_at: null,
          handoff_requested_at: null,
          channel_person_id: null,
        },
        error: null,
      };
    }
    return { data: null, error: null, count: 0 };
  };
  self.single = async () => resolve();
  self.maybeSingle = async () => resolve();
  self.then = (res: (v: unknown) => void) => res(resolve());
  return self;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      insert: (payload: unknown) => chain(table, 'insert', payload),
      upsert: (payload: unknown) => chain(table, 'upsert', payload),
      update: (payload: unknown) => chain(table, 'update', payload),
    }),
  }),
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return {
    ...actual,
    resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: '널널투어' })),
    checkWriteRate: vi.fn(async () => null),
  };
});

import { upsertConversation, touchConversation } from '@/lib/bot/conversations';

beforeEach(() => {
  ops = [];
  failOn = new Set();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('upsertConversation — 시각을 찍지 않는다 (I-29 근본 원인)', () => {
  it('upsert 페이로드에 last_message_at 이 없다 — 웹·카카오·채널톡 전부', async () => {
    await upsertConversation({ botId: 'bot-1', source: 'web', externalUserId: 'v-1' });
    await upsertConversation({ botId: 'bot-1', source: 'kakao', externalUserId: 'k-1' });
    await upsertConversation({
      botId: 'bot-1',
      source: 'channel',
      externalUserId: 'chat-1',
      channelPersonId: 'person-1',
      channelChatType: 'userChat',
    });

    const upserts = rowsOf('conversations', 'upsert');
    expect(upserts).toHaveLength(3);
    for (const u of upserts) expect(u.payload).not.toHaveProperty('last_message_at');
    // 채널톡 전용 키는 종전대로 같은 upsert 에 실린다 — 시각만 빠졌다
    expect(upserts[2].payload).toMatchObject({ channel_person_id: 'person-1', channel_chat_type: 'userChat' });
  });

  it('touchConversation 은 last_message_at 하나만 올린다', async () => {
    const before = Date.now();
    await touchConversation('conv-1');

    const updates = rowsOf('conversations', 'update');
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['last_message_at']);
    expect(new Date(payload.last_message_at as string).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ── 위젯 「연락처 남기기」 — 메시지 없이 대화를 만드는 경로 ──────────
// 연락처가 «실제로 남은 뒤»에만 시각을 찍는다(2026-09-17 ny 결정: 리드는 미읽음·상단으로).

async function postContact(payload: Record<string, unknown>) {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/widget/[botId]/contact/route');
  const req = new NextRequest(`https://feedloop.test/api/widget/${BOT_ID}/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://demo.example' },
    body: JSON.stringify({ visitorId: VISITOR, ...payload }),
  });
  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const touched = () =>
  rowsOf('conversations', 'update').filter((u) => 'last_message_at' in (u.payload as Record<string, unknown>));

describe('POST /api/widget/[botId]/contact — 연락처가 남은 뒤에만 시각을 찍는다', () => {
  it('연락처 저장이 성공하면 그 «뒤에» last_message_at 을 올린다', async () => {
    const { status } = await postContact({ name: '홍길동', email: 'hong@example.com' });
    expect(status).toBe(200);

    const updates = rowsOf('conversations', 'update');
    // [연락처 update] → [시각 update] 순서. 시각이 먼저면 연락처 저장이 실패했을 때 유령이 된다.
    expect(updates.map((u) => Object.keys(u.payload as Record<string, unknown>))).toEqual([
      ['contact_name', 'contact_email'],
      ['last_message_at'],
    ]);
    // upsert 자체는 시각을 싣지 않는다
    expect(rowsOf('conversations', 'upsert')[0].payload).not.toHaveProperty('last_message_at');
  });

  it('연락처 저장이 실패하면 500 이고 시각은 안 올라간다 — 빈 줄이 상단에 뜨지 않는다', async () => {
    failOn.add('conversations.update');
    const { status } = await postContact({ name: '홍길동' });
    expect(status).toBe(500);
    expect(touched()).toHaveLength(0);
  });

  it('입력이 비어 400 이면 대화를 열지도 않는다 (대조군)', async () => {
    const { status } = await postContact({});
    expect(status).toBe(400);
    expect(rowsOf('conversations', 'upsert')).toHaveLength(0);
    expect(touched()).toHaveLength(0);
  });
});

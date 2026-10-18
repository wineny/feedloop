import { describe, it, expect, vi, beforeEach } from 'vitest';

// I-29 — upsertConversation 이 저장 «전»에 last_message_at 을 찍어, 메시지 저장이 실패하면(I-23 경로)
// 메시지 0건인 «유령 대화»가 /inbox 에 빈 미읽음 줄로 떴다. 목록 조회가 그런 대화를 거른다.
// 같은 자리에서, 한 번의 배치 조회에 잘려 메시지를 못 찾은 대화는 하나씩 다시 봐 채운다 — 잘림을 유령으로 오인하지 않게.

type Row = Record<string, unknown>;
type Err = { message: string } | null;
const tables: {
  conversations: Row[];
  messagesBatch: Row[];
  messagesBatchError: Err;
  messagesByConv: Record<string, Row | null>;
  messagesSingleError: Record<string, Err>;
} = { conversations: [], messagesBatch: [], messagesBatchError: null, messagesByConv: {}, messagesSingleError: {} };
const singleLookups: string[] = [];
// 단건 재조회의 동시 실행 관측 — 상한(10)을 넘지 않는지 본다
const inFlight = { now: 0, max: 0 };

function chain(table: string): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  let convId: string | null = null;
  for (const m of ['select', 'in', 'order', 'limit', 'is', 'not']) c[m] = vi.fn(() => c);
  c.eq = vi.fn((col: string, v: string) => {
    if (col === 'conversation_id') convId = v;
    return c;
  });
  c.maybeSingle = vi.fn(async () => {
    if (convId) singleLookups.push(convId);
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    // 실제 왕복처럼 한 틱 양보해야 겹침이 관측된다
    await new Promise((r) => setTimeout(r, 1));
    inFlight.now -= 1;
    const error = convId ? tables.messagesSingleError[convId] ?? null : null;
    return { data: error ? null : convId ? tables.messagesByConv[convId] ?? null : null, error };
  });
  c.then = (resolve: (v: unknown) => void) =>
    resolve(
      table === 'conversations'
        ? { data: tables.conversations, error: null }
        : tables.messagesBatchError
          ? { data: null, error: tables.messagesBatchError }
          : { data: tables.messagesBatch, error: null },
    );
  return c;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ from: vi.fn((table: string) => chain(table)) }),
}));

import { listConversations, LAST_MESSAGE_LOOKUP_CONCURRENCY } from '@/lib/bot/conversations';

const conv = (id: string, at = '2026-09-16T10:00:00.000Z'): Row => ({
  id, source: 'web', external_user_id: `v-${id}`, contact_name: null, contact_email: null,
  last_message_at: at, operator_read_at: null, escalated_at: null, owner_email_status: null, owner_email_error: null,
});

beforeEach(() => {
  tables.conversations = [];
  tables.messagesBatch = [];
  tables.messagesByConv = {};
  tables.messagesBatchError = null;
  tables.messagesSingleError = {};
  singleLookups.length = 0;
  inFlight.now = 0;
  inFlight.max = 0;
});

describe('listConversations — 메시지 0건 유령 대화 (I-29)', () => {
  it('배치에도 없고 다시 봐도 없는 대화는 목록에서 빠진다', async () => {
    tables.conversations = [conv('c-real'), conv('c-ghost')];
    tables.messagesBatch = [{ conversation_id: 'c-real', body: '쿠폰함이 안 열려요', detected_at: '2026-09-16T10:00:00.000Z' }];

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-real']);
    expect(items[0].lastMessageBody).toBe('쿠폰함이 안 열려요');
    // 유령 후보만 다시 봤다 — 배치에서 찾은 대화는 왕복을 더하지 않는다
    expect(singleLookups).toEqual(['c-ghost']);
  });

  it('배치에서 잘려 빠진 대화는 다시 봐서 채운다 — 잘림을 유령으로 오인하지 않는다', async () => {
    tables.conversations = [conv('c-new'), conv('c-old', '2026-09-01T10:00:00.000Z')];
    tables.messagesBatch = [{ conversation_id: 'c-new', body: '새 메시지', detected_at: '2026-09-16T10:00:00.000Z' }];
    tables.messagesByConv = { 'c-old': { body: '옛 메시지' } };

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-new', 'c-old']);
    expect(items[1].lastMessageBody).toBe('옛 메시지');
  });

  it('전부 배치에서 찾으면 추가 조회가 없다 (대조군)', async () => {
    tables.conversations = [conv('c-1'), conv('c-2')];
    tables.messagesBatch = [
      { conversation_id: 'c-1', body: '하나', detected_at: '2026-09-16T10:00:00.000Z' },
      { conversation_id: 'c-2', body: '둘', detected_at: '2026-09-16T09:00:00.000Z' },
    ];

    const items = await listConversations(['bot-1']);

    expect(items).toHaveLength(2);
    expect(singleLookups).toEqual([]);
  });
});

describe('listConversations — 조회 실패는 유령이 아니다 (리뷰 HIGH)', () => {
  it('배치 메시지 조회가 실패하면 거르지 않고 본문 없이 전부 남긴다 — 받은편지함이 통째로 비면 안 된다', async () => {
    tables.conversations = [conv('c-1'), conv('c-2')];
    tables.messagesBatchError = { message: 'gateway timeout' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-1', 'c-2']);
    expect(items.every((i) => i.lastMessageBody === null)).toBe(true);
    // 장애 중에 대화 수만큼 재조회를 두드리지 않는다
    expect(singleLookups).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('개별 재조회가 실패한 대화는 「모름」으로 남긴다 — 유령으로 오인해 지우지 않는다', async () => {
    tables.conversations = [conv('c-ok'), conv('c-err')];
    tables.messagesBatch = [{ conversation_id: 'c-ok', body: '있음', detected_at: '2026-09-16T10:00:00.000Z' }];
    tables.messagesSingleError = { 'c-err': { message: 'timeout' } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-ok', 'c-err']);
    expect(items[1].lastMessageBody).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('listConversations — 연락처가 붙은 대화는 유령이 아니다 (2차 리뷰 ①)', () => {
  it('메시지 0건이어도 이름·이메일이 있으면 본문 없이 남긴다 — 채널톡 상담 개시·위젯 연락처 라우트', async () => {
    tables.conversations = [
      conv('c-msg'),
      { ...conv('c-lead'), source: 'channel', contact_name: '김리드', contact_email: 'lead@example.com' },
      conv('c-ghost'),
    ];
    tables.messagesBatch = [{ conversation_id: 'c-msg', body: '문의요', detected_at: '2026-09-16T10:00:00.000Z' }];

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-msg', 'c-lead']);
    expect(items[1].lastMessageBody).toBeNull();
    expect(items[1].contactName).toBe('김리드');
  });

  it('전화번호만 있어도 리드다 · 공백뿐인 연락처는 연락처가 아니다', async () => {
    tables.conversations = [
      { ...conv('c-phone'), contact_phone: '010-0000-0000' },
      { ...conv('c-blank'), contact_name: '   ', contact_email: '' },
    ];

    const items = await listConversations(['bot-1']);

    expect(items.map((i) => i.id)).toEqual(['c-phone']);
    // 줄을 살린 이유(전화번호)가 화면까지 간다 — 헤더가 이메일 없으면 이걸 보여 준다
    expect(items[0].contactPhone).toBe('010-0000-0000');
  });
});

describe('listConversations — 재조회 동시 실행 상한 (2차 리뷰 ③)', () => {
  it('배치가 통째로 잘려 25건을 다시 봐도 한 번에 10개까지만 나간다', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c-${i}`);
    tables.conversations = ids.map((id) => conv(id));
    for (const id of ids) tables.messagesByConv[id] = { body: `본문 ${id}` };

    const items = await listConversations(['bot-1']);

    expect(items).toHaveLength(25);
    expect(singleLookups).toHaveLength(25);
    expect(LAST_MESSAGE_LOOKUP_CONCURRENCY).toBe(10);
    expect(inFlight.max).toBeLessThanOrEqual(LAST_MESSAGE_LOOKUP_CONCURRENCY);
    expect(inFlight.max).toBeGreaterThan(1);
  });
});

// 즉답 라우트 → 새 대화 알림 트리거 (2026-09-23 ny 결정: 대화가 새로 열리면 첫 메시지만 실어 한 통).
//
// 지키는 것: ① 첫 «진짜» 메시지에만 건다 ② 이어지는 말엔 안 건다 ③ 칩만 누른 턴은 첫 메시지가 아니다
// ④ 칩 뒤 처음 적은 말이 첫 메시지다 ⑤ 즉답과 독립이다(LLM 결과와 무관하게 건다).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: 1, error: null }) as { data: number | null; error: { message: string } | null }),
  callLlm: vi.fn(async () => JSON.stringify({ response: '네!', insight: null })),
  emailOwnerNewConversation: vi.fn<(input: { botId: string; conversationId: string; messageId: string; firstMessage: string }) => Promise<{ sent: true; to: string }>>(
    async () => ({ sent: true as const, to: 'owner@example.com' }),
  ),
  getRecentTurns: vi.fn(async (): Promise<{ id: string; kind: string; body: string; at: string }[]> => []),
  afterTasks: [] as Promise<unknown>[],
}));

function noopChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => ({ data: null, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return chain;
}

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ rpc: h.rpc, from: vi.fn(() => noopChain()) }) }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).then === 'function') h.afterTasks.push((task as Promise<unknown>).catch(() => {}));
    },
  };
});
vi.mock('@/lib/bot/handler', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/bot/handler')>()), callLlm: h.callLlm }));
vi.mock('@/lib/email/notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/notify')>()),
  emailOwnerNewConversation: h.emailOwnerNewConversation,
}));
vi.mock('@/lib/bot/conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot/conversations')>()),
  saveWebMessage: vi.fn(async () => 'msg-new'),
  saveConversationResponse: vi.fn(async () => 'resp-1'),
  markConversationEscalated: vi.fn(async () => {}),
  touchConversation: vi.fn(async () => {}),
  upsertConversation: vi.fn(async () => ({ id: 'conv-1', contact_name: null, contact_email: null, contact_phone: null })),
  getRecentTurns: h.getRecentTurns,
  getTimeline: vi.fn(async () => []),
}));
vi.mock('@/lib/bot/db', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/bot/db')>()), applyInsightWrite: vi.fn(async () => null) }));
vi.mock('@/lib/groups/auto-grouping', () => ({ scheduleAutoGrouping: vi.fn(async () => {}), shouldScheduleAutoGrouping: () => false }));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/widget/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/widget/http')>()),
  resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: '널널투어' })),
  checkWriteRate: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/core', () => ({
  getBotConfigFromDB: vi.fn(async () => ({
    botId: BOT_ID, mentionPatterns: [], feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: { botName: '널널투어', botTone: '친근', serviceName: '널널투어', serviceUrl: '', serviceDescription: '', serviceCompany: '', targetUsers: '', serviceFeatures: [], loginMethod: '', faq: [], knowledge: '' },
    dailyReplyLimit: 30,
  })),
  invalidateBotCache: vi.fn(),
}));

import { POST } from '@/app/api/widget/[botId]/messages/route';
import { CHIP_ONLY_LABELS } from '@/lib/widget/chips';

const CHIP = CHIP_ONLY_LABELS[0];
let seq = 0;
/** 부를 때마다 1초씩 뒤 시각을 준다 — 나열한 순서가 곧 시간 순서다. */
const turn = (id: string, kind: string, body: string) => ({ id, kind, body, at: new Date(Date.UTC(2026, 8, 23, 0, 0, seq++)).toISOString() });

async function post(text: string) {
  const req = new NextRequest('http://localhost/api/widget/b1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: VISITOR_ID, text }),
  });
  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  await Promise.all(h.afterTasks);
  return res;
}

beforeEach(() => {
  h.afterTasks.length = 0;
  h.emailOwnerNewConversation.mockClear();
  h.getRecentTurns.mockResolvedValue([]);
});

describe('새 대화 알림 트리거', () => {
  it('대화의 첫 진짜 메시지면 소유자 메일을 «한 번» 건다 — 첫 메시지만 실어서', async () => {
    h.getRecentTurns.mockResolvedValue([turn('msg-new', 'user', '설치하는 데 5분이면 되나요?')]);
    const res = await post('설치하는 데 5분이면 되나요?');
    expect(res.status).toBe(200);
    expect(h.emailOwnerNewConversation).toHaveBeenCalledTimes(1);
    expect(h.emailOwnerNewConversation.mock.calls[0][0]).toEqual({
      botId: BOT_ID, conversationId: 'conv-1', messageId: 'msg-new', firstMessage: '설치하는 데 5분이면 되나요?',
    });
  });

  it('앞에 진짜 말이 있으면(두 번째 메시지부터) 걸지 않는다', async () => {
    h.getRecentTurns.mockResolvedValue([
      turn('msg-old', 'user', '설치 5분 맞나요?'), turn('resp-1', 'ai', '네!'), turn('msg-new', 'user', '카톡도 돼요?'),
    ]);
    await post('카톡도 돼요?');
    expect(h.emailOwnerNewConversation).not.toHaveBeenCalled();
  });

  it('칩만 누른 턴은 첫 메시지가 아니다 — 걸지 않는다', async () => {
    h.getRecentTurns.mockResolvedValue([turn('msg-new', 'user', CHIP)]);
    await post(CHIP);
    expect(h.emailOwnerNewConversation).not.toHaveBeenCalled();
  });

  it('칩 뒤에 처음 적은 말이 첫 메시지다 — 그때 건다', async () => {
    h.getRecentTurns.mockResolvedValue([
      turn('msg-chip', 'user', CHIP), turn('resp-1', 'ai', '어떤 기능이요?'), turn('msg-new', 'user', '다크 모드요'),
    ]);
    await post('다크 모드요');
    expect(h.emailOwnerNewConversation).toHaveBeenCalledTimes(1);
    expect(h.emailOwnerNewConversation.mock.calls[0][0]).toMatchObject({ messageId: 'msg-new', firstMessage: '다크 모드요' });
  });

  it('거의 동시에 온 «뒤» 메시지가 최근 턴에 잡혀도, 앞선 진짜 턴이 없으면 건다 (둘 다 물러나 0통이 되지 않게)', async () => {
    h.getRecentTurns.mockResolvedValue([
      { id: 'msg-new', kind: 'user', body: '주차 되나요?', at: '2026-09-23T00:00:01.000Z' },
      { id: 'msg-later', kind: 'user', body: '그리고 쿠폰은요?', at: '2026-09-23T00:00:01.200Z' },
    ]);
    await post('주차 되나요?');
    expect(h.emailOwnerNewConversation).toHaveBeenCalledTimes(1);
    expect(h.emailOwnerNewConversation.mock.calls[0][0]).toMatchObject({ messageId: 'msg-new' });
  });

  it('즉답이 실패해도(LLM null) 알림은 간다 — 들어왔다는 사실과 답은 별개다', async () => {
    h.callLlm.mockResolvedValueOnce(null as unknown as string);
    h.getRecentTurns.mockResolvedValue([turn('msg-new', 'user', '주차 되나요?')]);
    await post('주차 되나요?');
    expect(h.emailOwnerNewConversation).toHaveBeenCalledTimes(1);
  });
});

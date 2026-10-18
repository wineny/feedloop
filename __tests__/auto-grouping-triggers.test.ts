import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// I-10 트리거 — 위젯 즉답이 인사이트를 저장하면 자동 묶기를 «걸고», 안 만들었으면 «안 건다».
// 그리고 /api/auto-dev 의 인사이트 단건 경로는 미묶음이면 409 로 막는다.
//
// 음성 대조가 이 파일의 값어치다: 트리거 호출을 지우면 첫 케이스가 빨개져야 한다.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  schedule: vi.fn(async () => ({ ran: false, reason: 'not_due_or_locked' as const })),
  afterTasks: [] as Promise<unknown>[],
  receipt: { id: 'ins-1', created: true } as { id: string | null; created: boolean },
  llmReply: '' as string,
  session: { user: { id: 'owner' } } as { user: { id: string } } | null,
  insightRow: null as Record<string, unknown> | null,
  botOwner: 'owner' as string,
}));

vi.mock('@/lib/groups/auto-grouping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/groups/auto-grouping')>();
  // 필터(shouldScheduleAutoGrouping)는 진짜를 태운다 — 라우트가 카테고리를 제대로 넘기는지가 관심사다.
  return { ...actual, scheduleAutoGrouping: h.schedule, runGroupingNow: vi.fn(), catchUpAutoGrouping: vi.fn(), readGroupingStatus: vi.fn() };
});

// after() 는 응답 뒤 작업 — 테스트가 직접 기다린다(위젯 라우트는 settle 도 after 안에서 한다).
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).then === 'function') h.afterTasks.push(task as Promise<unknown>);
    },
  };
});

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';
const INSIGHT_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return {
    ...actual,
    callLlm: vi.fn(async () => h.llmReply),
  };
});
vi.mock('@/lib/bot/core', () => ({
  getBotConfigFromDB: vi.fn(async () => ({
    botId: BOT_ID,
    llmApiKeyEncrypted: 'enc:x',
    llmProvider: 'anthropic',
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: 'QA', botTone: '친근', serviceName: 'QA', serviceUrl: '', serviceDescription: '',
      serviceCompany: '', targetUsers: '', serviceFeatures: [], loginMethod: '', faq: [], knowledge: '',
    },
  })),
  invalidateBotCache: vi.fn(),
}));
vi.mock('@/lib/bot/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/conversations')>();
  return {
    ...actual,
    upsertConversation: vi.fn(async () => ({ id: 'conv-1', contact_name: null, contact_email: null, contact_phone: null })),
    saveWebMessage: vi.fn(async () => 'msg-1'),
    saveConversationResponse: vi.fn(async () => 'resp-1'),
    markConversationEscalated: vi.fn(async () => {}),
    getTimeline: vi.fn(async () => []),
    getRecentTurns: vi.fn(async () => []),
    listExtendableInsights: vi.fn(async () => []),
  };
});
vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  return { ...actual, applyInsightWrite: vi.fn(async () => h.receipt) };
});
vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return {
    ...actual,
    resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: 'QA' })),
    checkWriteRate: vi.fn(async () => null),
  };
});
vi.mock('@/lib/llm/usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm/usage')>();
  return {
    ...actual,
    withReplyBudget: vi.fn(async (_b: string, _c: unknown, fn: () => Promise<unknown>) => ({ allowed: true, value: fn() })),
  };
});
vi.mock('next-auth', () => ({ getServerSession: async () => h.session }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from(table: string) {
      // 어떤 체인 메서드든 자기 자신을 돌려주고, await 하면 빈 목록. 단건 조회만 테이블별로 답한다.
      const row = table === 'insights' ? h.insightRow : table === 'bots' ? { id: BOT_ID, github_repo_url: 'https://github.com/o/r', user_id: h.botOwner } : null;
      const chain: Record<string, unknown> = {
        single: async () => ({ data: row, error: row ? null : { message: 'not found' } }),
        maybeSingle: async () => ({ data: row, error: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: any, reject: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject),
      };
      const proxy: Record<string, unknown> = new Proxy(chain, { get: (t, k: string) => (k in t ? t[k] : () => proxy) });
      return proxy;
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.afterTasks.length = 0;
  h.receipt = { id: 'ins-1', created: true };
  h.llmReply = JSON.stringify({ response: '확인해볼게요', insight: { category: 'bug', summary: '쿠폰 버튼 무반응', sentiment: 'negative' } });
  h.insightRow = null;
  h.botOwner = 'owner';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function postWidget(text: string) {
  const { POST } = await import('@/app/api/widget/[botId]/messages/route');
  const req = new NextRequest(`http://localhost/api/widget/${BOT_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: VISITOR_ID, text }),
  });
  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  await Promise.all(h.afterTasks);
  return res;
}

describe('위젯 즉답 → 자동 묶기 트리거', () => {
  it('인사이트가 저장되면(receipt.id) 그 봇에 자동 묶기를 건다', async () => {
    const res = await postWidget('쿠폰 받기를 눌렀는데 아무 반응이 없어요');
    expect(res.status).toBe(200);
    expect(h.schedule).toHaveBeenCalledTimes(1);
    // 마감은 요청 시작 기준으로 넘긴다 — 늦은 답(최대 30초) 뒤에도 대기+묶기가 maxDuration 안에 들게.
    expect(h.schedule).toHaveBeenCalledWith(BOT_ID, { deadlineMs: expect.any(Number) });
    const deadline = ((h.schedule.mock.calls[0] as unknown[])[1] as { deadlineMs: number }).deadlineMs;
    expect(deadline - Date.now()).toBeLessThanOrEqual(290_000);
    expect(deadline - Date.now()).toBeGreaterThan(250_000);
  });

  it('문의(cs)로 분류된 턴은 안 건다 — 묶기 대상이 아닌데 대기자 슬롯을 잡을 이유가 없다', async () => {
    h.llmReply = JSON.stringify({ response: '네, 하루 한 장이에요', insight: { category: 'cs', summary: '쿠폰 한도 문의', sentiment: 'neutral' } });
    const res = await postWidget('쿠폰은 하루 몇 장까지 받나요?');
    expect(res.status).toBe(200);
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('이 턴이 인사이트를 안 만들었으면(receipt.id null) 안 건다 — 음성 대조', async () => {
    h.receipt = { id: null, created: false };
    const res = await postWidget('고마워요!');
    expect(res.status).toBe(200);
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('묶기 트리거가 던져도 응답·저장은 이미 끝났고 after 는 조용히 끝난다', async () => {
    h.schedule.mockRejectedValueOnce(new Error('rpc down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWidget('쿠폰 받기를 눌렀는데 아무 반응이 없어요');
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('POST /api/auto-dev — 인사이트 단건 PR 은 더 이상 없다', () => {
  async function post(body: unknown) {
    const { POST } = await import('@/app/api/auto-dev/route');
    return POST(new NextRequest('http://localhost/api/auto-dev', { method: 'POST', body: JSON.stringify(body) }));
  }

  it('아직 안 묶인 인사이트면 409 + 묶음에서 만들라는 안내', async () => {
    h.insightRow = { id: INSIGHT_ID, bot_id: BOT_ID, category: 'bug', group_id: null };
    const res = await post({ insightId: INSIGHT_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('묶');
  });

  it('남의 봇 인사이트는 상태(묶였는지)를 말하지 않고 403 — 소유권이 409 보다 앞이다', async () => {
    h.insightRow = { id: INSIGHT_ID, bot_id: BOT_ID, category: 'bug', group_id: null };
    h.botOwner = 'someone-else';
    const res = await post({ insightId: INSIGHT_ID });
    expect(res.status).toBe(403);
  });

  it('묶인 인사이트는 그 묶음 경로로 흘러간다(묶음 조회까지 간다)', async () => {
    // 묶음 조회(maybeSingle) 가 insights 행을 돌려주지 않으므로 「묶음을 찾을 수 없습니다」= 묶음 경로에 도달했다는 증거.
    h.insightRow = { id: INSIGHT_ID, bot_id: BOT_ID, category: 'bug', group_id: '44444444-4444-4444-8444-444444444444' };
    const res = await post({ insightId: INSIGHT_ID });
    expect(res.status).not.toBe(409);
  });
});

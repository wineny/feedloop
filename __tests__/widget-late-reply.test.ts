// 즉답 라우트의 «늦은 답» 경로 — 2026-09-23 위젯 「멈춤」 회귀.
//
// 타임아웃은 두 겹이다. 바깥(VISITOR_WAIT_MS)은 방문자를 얼마나 기다리게 할지, 안쪽(LLM_TIMEOUT_MS)은
// provider 요청을 언제 끊을지. 둘을 같은 값으로 두면 바깥이 SLOW_NOTICE 를 보내는 그 순간 안쪽이
// 요청을 끊어 «늦은 답»이 영영 오지 않는다 — 방문자는 「바로 답 드릴게요」 뒤에 아무것도 못 본다.
// 여기서 지키는 것 셋: ① 안쪽 > 바깥 ② 늦은 답은 저장돼 폴링에 뜬다 ③ 늦게도 답이 없으면 대기 답변을 남긴다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: 1, error: null }) as { data: number | null; error: { message: string } | null }),
  callLlm: vi.fn<(config: unknown, system: string, user: string, opts?: { timeoutMs?: number }) => Promise<string | null>>(
    async () => '',
  ),
  saveConversationResponse: vi.fn<(params: { body?: string; responseType?: string }) => Promise<string>>(async () => 'resp-1'),
  markConversationEscalated: vi.fn(async () => {}),
  getBotConfigFromDB: vi.fn(),
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

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ rpc: h.rpc, from: vi.fn(() => noopChain()) }),
}));

// after() 에 넘긴 promise 를 붙잡아 둔다 — 늦은 답 경로는 응답이 나간 «뒤»에 돌기 때문에
// 테스트가 그 끝을 기다릴 손잡이가 필요하다.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).then === 'function') {
        h.afterTasks.push((task as Promise<unknown>).catch(() => {}));
      }
    },
  };
});

vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return { ...actual, callLlm: h.callLlm };
});

vi.mock('@/lib/bot/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/conversations')>();
  return {
    ...actual,
    saveWebMessage: vi.fn(async () => 'msg-1'),
    saveConversationResponse: h.saveConversationResponse,
    markConversationEscalated: h.markConversationEscalated,
    touchConversation: vi.fn(async () => {}),
    upsertConversation: vi.fn(async () => ({
      id: 'conv-1',
      contact_name: null,
      contact_email: null,
      contact_phone: null,
    })),
    getRecentTurns: vi.fn(async () => []),
    getTimeline: vi.fn(async () => []),
  };
});

vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  return { ...actual, applyInsightWrite: vi.fn(async () => null) };
});

vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB: h.getBotConfigFromDB, invalidateBotCache: vi.fn() }));

vi.mock('@/lib/groups/auto-grouping', () => ({
  scheduleAutoGrouping: vi.fn(async () => {}),
  shouldScheduleAutoGrouping: () => false,
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return {
    ...actual,
    resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: '널널투어' })),
    checkWriteRate: vi.fn(async () => null),
  };
});

import { POST } from '@/app/api/widget/[botId]/messages/route';
import { HOLDING_MESSAGE } from '@/lib/bot/holding';

const SLOW_NOTICE = '말씀 잘 받았어요! 확인하고 바로 답 드릴게요 🙌';
const VISITOR_WAIT_MS = 10_000;

function post(text = '어떤 경우에 답변이 생성 안 되나요?') {
  const request = new NextRequest('http://localhost/api/widget/b1/messages?locale=ko', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: VISITOR_ID, text }),
  });
  return POST(request, { params: Promise.resolve({ botId: BOT_ID }) });
}

/** 우리가 «직접» 풀어 주기 전까지 안 끝나는 LLM 호출. 실제 지연을 흉내 낸다. */
function deferredLlm() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolve = r; });
  h.callLlm.mockReturnValue(promise);
  return { resolve };
}

const savedBodies = () => h.saveConversationResponse.mock.calls.map((c) => c[0].body);

beforeEach(() => {
  vi.useFakeTimers();
  h.afterTasks.length = 0;
  h.rpc.mockClear();
  h.callLlm.mockReset();
  h.saveConversationResponse.mockClear();
  h.markConversationEscalated.mockClear();
  h.getBotConfigFromDB.mockResolvedValue({
    botId: BOT_ID,
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: '널널투어', botTone: '친근', serviceName: '널널투어', serviceUrl: '',
      serviceDescription: '', serviceCompany: '', targetUsers: '', serviceFeatures: [],
      loginMethod: '', faq: [], knowledge: '',
    },
    dailyReplyLimit: 30,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/widget/[botId]/messages — 늦은 답 경로', () => {
  it('provider 요청 상한(SDK timeout)은 방문자 대기보다 길다 — 같으면 늦은 답이 올 통로가 없다', async () => {
    h.callLlm.mockResolvedValue(JSON.stringify({ response: '네!', insight: null }));
    const res = await post();
    expect(res.status).toBe(200);
    const opts = h.callLlm.mock.calls[0][3];
    expect(opts?.timeoutMs).toBeDefined();
    expect(opts!.timeoutMs!).toBeGreaterThan(VISITOR_WAIT_MS);
  });

  it('제때 오면 안내 없이 답을 저장한다 (대조군)', async () => {
    h.callLlm.mockResolvedValue(JSON.stringify({ response: '네, 됩니다!', insight: null }));
    const res = await post();
    const body = (await res.json()) as { notice: string | null };
    expect(body.notice).toBeNull();
    expect(savedBodies()).toEqual(['네, 됩니다!']);
  });

  it('10초를 넘기면 SLOW_NOTICE 를 먼저 보내고, 늦게 온 답을 저장해 폴링에 띄운다', async () => {
    const llm = deferredLlm();
    const pending = post();
    await vi.advanceTimersByTimeAsync(VISITOR_WAIT_MS);
    const res = await pending;
    const body = (await res.json()) as { notice: string | null };
    expect(body.notice).toBe(SLOW_NOTICE);
    // 응답이 나간 시점엔 아무것도 저장되지 않았다 — 안내는 저장하지 않는다.
    expect(h.saveConversationResponse).not.toHaveBeenCalled();

    // 2초 뒤 답이 도착한다(안쪽 상한 30초 안).
    await vi.advanceTimersByTimeAsync(2_000);
    llm.resolve(JSON.stringify({ response: '두 가지 경우예요!', insight: null }));
    await Promise.all(h.afterTasks);

    expect(savedBodies()).toEqual(['두 가지 경우예요!']);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(h.saveConversationResponse.mock.calls[0][0].responseType).toBe('ai');
    // 늦었을 뿐 답이 나왔다 — 사람이 이어받을 일이 없다.
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
  });

  it('늦게도 답이 없으면(상한 초과·provider 오류) 대기 답변을 남기고 담당자에게 넘긴다', async () => {
    const llm = deferredLlm();
    const pending = post();
    await vi.advanceTimersByTimeAsync(VISITOR_WAIT_MS);
    const res = await pending;
    expect(((await res.json()) as { notice: string | null }).notice).toBe(SLOW_NOTICE);

    llm.resolve(null); // callLlm 은 실패를 null 로 돌린다(던지지 않는다)
    await Promise.all(h.afterTasks);

    // 「바로 답 드릴게요」 뒤에 아무것도 없으면 방문자는 영영 기다린다 — 대기 «답변»을 ai 로 남긴다.
    expect(savedBodies()).toEqual([HOLDING_MESSAGE]);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(h.saveConversationResponse.mock.calls[0][0].responseType).toBe('ai');
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
  });

  it('늦은 결과 처리 중 예외가 나도(then 을 못 탐) 대기 답변은 한 번 저장되고 담당자에게 넘어간다', async () => {
    // callLlm 은 던지지 않지만 그 뒤 결과 처리(extractResult 등)가 던지면 replying 이 reject 한다.
    // race 는 .catch(() => null) 로 이걸 «늦음»으로 보고 SLOW_NOTICE 를 보낸다 — 그 뒤 통로는 catch 뿐이다.
    let reject!: (e: unknown) => void;
    h.callLlm.mockReturnValue(new Promise<string | null>((_, r) => { reject = r; }));
    const pending = post();
    await vi.advanceTimersByTimeAsync(VISITOR_WAIT_MS);
    const res = await pending;
    expect(((await res.json()) as { notice: string | null }).notice).toBe(SLOW_NOTICE);

    reject(new Error('boom'));
    await Promise.all(h.afterTasks);

    expect(savedBodies()).toEqual([HOLDING_MESSAGE]);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
  });

  it('늦은 답을 저장한 «뒤»의 단계가 던져도 다시 저장하지 않는다', async () => {
    const { applyInsightWrite } = await import('@/lib/bot/db');
    (applyInsightWrite as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new Error('insight_persistence_failed'),
    );
    const llm = deferredLlm();
    const pending = post();
    await vi.advanceTimersByTimeAsync(VISITOR_WAIT_MS);
    await pending;
    llm.resolve(JSON.stringify({
      response: '늦은 답',
      insight: { category: 'bug', summary: '늦은 답 뒤 단계가 던짐', sentiment: 'negative' },
    }));
    await Promise.all(h.afterTasks);

    expect(savedBodies()).toEqual(['늦은 답']);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
  });

  it('자동 묶기 마감은 요청 시작 기준으로 넘긴다 — 늦은 답 30초 뒤에도 maxDuration 안에 든다', () => {
    const src = readFileSync('src/app/api/widget/[botId]/messages/route.ts', 'utf8');
    expect(src).toMatch(/scheduleAutoGrouping\(botId, \{ deadlineMs: reqStartedAt \+ GROUPING_DEADLINE_FROM_START_MS \}\)/);
    expect(src).toMatch(/const GROUPING_DEADLINE_FROM_START_MS = 290_000;/);
  });

  it('위젯은 늦은 답이 도착하면 「바로 답 드릴게요」 안내를 지운다 — 답 밑에 안내가 남지 않게', () => {
    const src = readFileSync('public/widget.js', 'utf8');
    const poll = src.slice(src.indexOf('function poll()'), src.indexOf('function notifyParent'));
    expect(poll).toContain('if (added > 0) state.notice = null;');
  });

  it('제때 답한 대화는 늦은 경로가 다시 저장하지 않는다 (이중 저장 방지)', async () => {
    h.callLlm.mockResolvedValue(JSON.stringify({ response: '바로 답', insight: null }));
    await post();
    await vi.advanceTimersByTimeAsync(VISITOR_WAIT_MS + 1_000);
    await Promise.all(h.afterTasks);
    expect(savedBodies()).toEqual(['바로 답']);
  });
});

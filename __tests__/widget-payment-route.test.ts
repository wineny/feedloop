// Widget route × payment router (design v2 §2): the branch point is this one route.
//
//   PayPal connected + payment message  → payment agent runs, callLlm does not, reply saved as 'payment_agent'
//   PayPal connected + ordinary message → callLlm as before, reply saved as 'ai'
//   PayPal not connected + "refund"     → callLlm as before (a plain CS question for that bot)
//   agent failure                       → English fallback saved, conversation escalated
//   slow / rate / budget / no config    → English notice on the payment path, Korean on the ordinary one
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  checkWidgetWriteRate: vi.fn<() => Promise<unknown>>(async () => ({ ok: true })),
  callLlm: vi.fn<(config: unknown, system: string, user: string, opts?: unknown) => Promise<string>>(
    async () => JSON.stringify({ response: '앗 불편하셨겠어요!', insight: null }),
  ),
  runPaymentAgent: vi.fn<(input: { prompt: string; system: string; tools: unknown }) => Promise<unknown>>(
    async () => ({ text: 'Sure — what is your PayPal order id and the email you paid with?', steps: 1, finishReason: 'stop', toolTrace: [] }),
  ),
  // `client` is what the route hands to the visitor tools; the agent itself is mocked, so it is never called.
  resolvePayPalBot: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, bot: { id: 'b', client: {} } })),
  hasOpenPaymentAction: vi.fn<() => Promise<boolean>>(async () => false),
  resolveModel: vi.fn(async () => ({ model: { id: 'mock' }, usingOwnKey: false, provider: 'gemini', modelId: 'm' })),
  recordLlmFailure: vi.fn(async () => {}),
  saveConversationResponse: vi.fn<(params: { body?: string; responseType?: string }) => Promise<string>>(async () => 'resp-1'),
  markConversationEscalated: vi.fn(async () => true),
  getRecentTurns: vi.fn<() => Promise<unknown[]>>(async () => []),
  getBotConfigFromDB: vi.fn(),
  applyInsightWrite: vi.fn(async () => null),
  // the visitor tools are real; we only capture what the route wires into them
  toolDeps: null as null | Record<string, unknown>,
  emailOwnerRefundApproval: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({ sent: true, to: 'owner@example.com' })),
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
  getServiceRoleClient: () => ({ rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn(() => noopChain()) }),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).catch === 'function') {
        (task as Promise<unknown>).catch(() => {});
      }
    },
  };
});

vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return { ...actual, callLlm: h.callLlm, recordLlmFailure: h.recordLlmFailure };
});

vi.mock('@/lib/llm/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/llm/provider')>();
  return { ...actual, resolveModel: h.resolveModel };
});

vi.mock('@/lib/paypal/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/paypal/agent')>();
  return { ...actual, runPaymentAgent: h.runPaymentAgent };
});

vi.mock('@/lib/paypal/bot', () => ({ resolvePayPalBot: h.resolvePayPalBot }));
vi.mock('@/lib/paypal/visitor-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/paypal/visitor-tools')>();
  return {
    ...actual,
    createVisitorTools: (deps: Parameters<typeof actual.createVisitorTools>[0]) => {
      h.toolDeps = deps as unknown as Record<string, unknown>;
      return actual.createVisitorTools(deps);
    },
  };
});
vi.mock('@/lib/email/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/notify')>();
  return { ...actual, emailOwnerRefundApproval: h.emailOwnerRefundApproval };
});
vi.mock('@/lib/paypal/actions', () => ({ hasOpenPaymentAction: h.hasOpenPaymentAction }));

vi.mock('@/lib/bot/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/conversations')>();
  return {
    ...actual,
    saveWebMessage: vi.fn(async () => 'msg-1'),
    saveConversationResponse: h.saveConversationResponse,
    markConversationEscalated: h.markConversationEscalated,
    touchConversation: vi.fn(async () => {}),
    upsertConversation: vi.fn(async () => ({ id: 'conv-1', contact_name: null, contact_email: null, contact_phone: null })),
    getRecentTurns: h.getRecentTurns,
    getTimeline: vi.fn(async () => []),
  };
});

vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  return { ...actual, applyInsightWrite: h.applyInsightWrite };
});

vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB: h.getBotConfigFromDB, invalidateBotCache: vi.fn() }));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return {
    ...actual,
    resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: 'Feedloop' })),
    checkWidgetWriteRate: h.checkWidgetWriteRate,
  };
});

import { POST } from '@/app/api/widget/[botId]/messages/route';
import {
  PAYMENT_AGENT_FALLBACK,
  PAYMENT_HOLDING_NOTICE,
  PAYMENT_LIMIT_NOTICE,
  PAYMENT_RATE_NOTICE,
  PAYMENT_SLOW_NOTICE,
} from '@/lib/paypal/notices';
import { PAYMENT_AGENT_RESPONSE_TYPE } from '@/lib/paypal/response-types';
import { HOLDING_MESSAGE_EN, HOLDING_NOTICE } from '@/lib/bot/holding';

function post(text: string, locale?: 'ko' | 'en') {
  const request = new NextRequest(`http://localhost/api/widget/b1/messages${locale ? `?locale=${locale}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: VISITOR_ID, text }),
  });
  return POST(request, { params: Promise.resolve({ botId: BOT_ID }) });
}

const saved = () => h.saveConversationResponse.mock.calls[0]?.[0];

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.checkWidgetWriteRate.mockResolvedValue({ ok: true });
  h.resolvePayPalBot.mockResolvedValue({ ok: true, bot: { id: BOT_ID, client: {} } });
  h.hasOpenPaymentAction.mockResolvedValue(false);
  h.getRecentTurns.mockResolvedValue([]);
  h.runPaymentAgent.mockResolvedValue({
    text: 'Sure — what is your PayPal order id and the email you paid with?',
    steps: 1,
    finishReason: 'stop',
    toolTrace: [],
  });
  h.callLlm.mockResolvedValue(JSON.stringify({ response: '앗 불편하셨겠어요!', insight: null }));
  h.getBotConfigFromDB.mockResolvedValue({
    botId: BOT_ID,
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: 'Feedloop', botTone: 'friendly', serviceName: 'Feedloop', serviceUrl: '',
      serviceDescription: '', serviceCompany: '', targetUsers: '', serviceFeatures: [],
      loginMethod: '', faq: [], knowledge: '',
    },
    dailyReplyLimit: 30,
  });
});

describe('payment route', () => {
  it('sends a refund request to the payment agent and saves the reply as payment_agent', async () => {
    const res = await post('I want a refund for my order');
    expect(res.status).toBe(200);

    expect(h.runPaymentAgent).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
    const input = h.runPaymentAgent.mock.calls[0][0];
    expect(input.prompt).toContain("Visitor's message:\nI want a refund for my order");
    expect(input.system).toContain('payment assistant for Feedloop');
    // The four visitor wrappers, nothing from the toolkit, no list_* tool.
    expect(Object.keys(input.tools as Record<string, unknown>).sort()).toEqual(
      ['create_checkout', 'find_my_payment', 'get_payment_status', 'request_refund'],
    );

    expect(saved()).toMatchObject({
      responseType: PAYMENT_AGENT_RESPONSE_TYPE,
      body: 'Sure — what is your PayPal order id and the email you paid with?',
    });
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.notice).toBeNull();
  });

  it('wires onPendingApproval: a pending refund mails the owner once (the badge is raised by the RPC, not here)', async () => {
    await post('I want a refund for my order');
    const onPending = (h.toolDeps as { onPendingApproval?: (a: unknown) => void } | null)?.onPendingApproval;
    expect(typeof onPending).toBe('function');
    const action = { id: 'act-1', status: 'pending', conversation_id: 'conv-1', bot_id: BOT_ID };
    onPending!(action);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
    expect(h.emailOwnerRefundApproval).toHaveBeenCalledTimes(1);
    expect(h.emailOwnerRefundApproval.mock.calls[0][0]).toMatchObject({ botId: BOT_ID, conversationId: 'conv-1', action });
    // never through `escalate` on the result: the agent's own answer was saved untouched
    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE });
  });

  it('keeps an ordinary message on the existing path', async () => {
    await post('The login button is broken');
    expect(h.callLlm).toHaveBeenCalledTimes(1);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ responseType: 'ai' });
  });

  it('does not route when the bot has no PayPal connection', async () => {
    h.resolvePayPalBot.mockResolvedValue({ ok: false, reason: 'not_connected' });
    await post('I want a refund');
    expect(h.callLlm).toHaveBeenCalledTimes(1);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
  });

  it('does not route when the PayPal lookup throws', async () => {
    h.resolvePayPalBot.mockRejectedValue(new Error('db down'));
    await post('refund please');
    expect(h.callLlm).toHaveBeenCalledTimes(1);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
  });

  it('routes a bare follow-up because the previous reply came from the payment agent', async () => {
    h.getRecentTurns.mockResolvedValue([
      { id: 'm0', kind: 'user', body: 'refund please', at: '2026-10-20T00:00:00Z' },
      { id: 'r0', kind: 'ai', body: 'What is your order id?', at: '2026-10-20T00:00:01Z', responseType: PAYMENT_AGENT_RESPONSE_TYPE },
      { id: 'msg-1', kind: 'user', body: 'abc@example.com', at: '2026-10-20T00:00:02Z' },
    ]);
    await post('abc@example.com');
    expect(h.runPaymentAgent).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
    expect(h.runPaymentAgent.mock.calls[0][0].prompt).toContain('Feedloop: What is your order id?');
  });

  it('routes any message while a refund action is open', async () => {
    h.hasOpenPaymentAction.mockResolvedValue(true);
    await post('any news?');
    expect(h.runPaymentAgent).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
  });

  it('a chip-only turn never routes', async () => {
    await post('의견 남기기');
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
  });

  it('on agent failure saves the English fallback, records the LLM failure and escalates', async () => {
    h.runPaymentAgent.mockRejectedValue(new Error('provider 500'));
    const res = await post('refund please');
    expect(res.status).toBe(200);
    expect(h.recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE, body: PAYMENT_AGENT_FALLBACK });
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
  });

  it('when the loop ends without text, saves the fallback and escalates (no failure record)', async () => {
    h.runPaymentAgent.mockResolvedValue({ text: null, steps: 4, finishReason: 'tool-calls', toolTrace: [] });
    await post('refund please');
    expect(h.recordLlmFailure).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ body: PAYMENT_AGENT_FALLBACK });
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
  });
});

describe('payment route — every notice is English', () => {
  /** Hands back the agent's settle/reject handles so a test can decide when (and how) it finishes. */
  function slowAgent() {
    let settle!: (value: unknown) => void;
    let fail!: (err: unknown) => void;
    h.runPaymentAgent.mockImplementationOnce(
      () => new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
    );
    return { settle: (v: unknown) => settle(v), fail: (e: unknown) => fail(e) };
  }

  it('slow agent: English slow notice now, the late reply saved once as payment_agent', async () => {
    vi.useFakeTimers();
    const agent = slowAgent();
    const pending = post('I want a refund');
    await vi.advanceTimersByTimeAsync(10_001);
    const json = await (await pending).json();
    expect(json.notice).toBe(PAYMENT_SLOW_NOTICE);
    expect(h.saveConversationResponse).not.toHaveBeenCalled();

    agent.settle({ text: 'Please share your order id.', steps: 1, finishReason: 'stop', toolTrace: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE, body: 'Please share your order id.' });
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
  });

  it('slow agent that then fails: English fallback saved as the late answer, conversation escalated', async () => {
    vi.useFakeTimers();
    const agent = slowAgent();
    const pending = post('I want a refund');
    await vi.advanceTimersByTimeAsync(10_001);
    const json = await (await pending).json();
    expect(json.notice).toBe(PAYMENT_SLOW_NOTICE);

    agent.fail(new Error('provider 500'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE, body: PAYMENT_AGENT_FALLBACK });
    expect(h.recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
  });

  it('hourly bot cap: English rate notice, agent not called, message still stored', async () => {
    h.checkWidgetWriteRate.mockResolvedValue({ ok: false, limit: 'bot', response: new Response(null, { status: 429 }) });
    const res = await post('I want a refund');
    expect(res.status).toBe(200);
    expect((await res.json()).notice).toBe(PAYMENT_RATE_NOTICE);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
  });

  it('daily budget exhausted: English limit notice, agent not called', async () => {
    const cfg = await h.getBotConfigFromDB();
    h.getBotConfigFromDB.mockResolvedValue({ ...cfg, dailyReplyLimit: 0 });
    const json = await (await post('I want a refund')).json();
    expect(json.notice).toBe(PAYMENT_LIMIT_NOTICE);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
    expect(h.markConversationEscalated).not.toHaveBeenCalled();
  });

  it('no bot config: English holding notice and the conversation is escalated', async () => {
    h.getBotConfigFromDB.mockResolvedValue(null);
    const json = await (await post('I want a refund')).json();
    expect(json.notice).toBe(PAYMENT_HOLDING_NOTICE);
    expect(h.runPaymentAgent).not.toHaveBeenCalled();
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
  });

  it('the ordinary path keeps its Korean notice for a Korean widget (no config, non-payment message)', async () => {
    h.getBotConfigFromDB.mockResolvedValue(null);
    const json = await (await post('The login button is broken', 'ko')).json();
    expect(json.notice).toBe(HOLDING_NOTICE);
  });

  it('the ordinary path answers in English when the widget sends no locale or en', async () => {
    h.getBotConfigFromDB.mockResolvedValue(null);
    for (const locale of [undefined, 'en'] as const) {
      const json = await (await post('The login button is broken', locale)).json();
      expect(json.notice).toBe(`Got it! ${HOLDING_MESSAGE_EN}`);
    }
  });
});

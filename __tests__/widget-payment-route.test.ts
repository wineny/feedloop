// Widget route × payment router (design v2 §2): the branch point is this one route.
//
//   PayPal connected + payment message  → payment agent runs, callLlm does not, reply saved as 'payment_agent'
//   PayPal connected + ordinary message → callLlm as before, reply saved as 'ai'
//   PayPal not connected + "refund"     → callLlm as before (a plain CS question for that bot)
//   agent failure                       → English fallback saved, conversation escalated
//   slow / rate / budget / no config    → English notice on the payment path, Korean on the ordinary one
//   refund with a product-problem reason → classified after the answer → one groupable insight → auto-grouping (§7)
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
  scheduleAutoGrouping: vi.fn(async () => ({ ran: false, reason: 'not_waiter' })),
  rpc: vi.fn<(name: string) => Promise<unknown>>(async () => ({ data: 1, error: null })),
  listExtendableInsights: vi.fn<() => Promise<unknown[]>>(async () => []),
  // every after() task, so a test can wait for the post-response work
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

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).catch === 'function') {
        h.afterTasks.push((task as Promise<unknown>).catch(() => {}));
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

vi.mock('@/lib/bot/reply-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/reply-context')>();
  return { ...actual, listExtendableInsights: h.listExtendableInsights };
});

vi.mock('@/lib/groups/auto-grouping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/groups/auto-grouping')>();
  return { ...actual, scheduleAutoGrouping: h.scheduleAutoGrouping };
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
import { buildInsightRefMap } from '@/lib/bot/reply-context';

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
  h.afterTasks.length = 0;
  h.rpc.mockResolvedValue({ data: 1, error: null });
  h.applyInsightWrite.mockResolvedValue(null);
  h.listExtendableInsights.mockResolvedValue([]);
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

describe('payment route → insights and grouping (design §7)', () => {
  const REASON = 'The receipt showed the wrong currency';
  const refundTrace = (reason: string, status = 'waiting_for_approval') => [
    { toolName: 'find_my_payment', input: { order_id: '5O190127TN364715T', email: 'a@b.c' }, output: { found: true } },
    { toolName: 'request_refund', input: { reason }, output: { status, amount: '$29' } },
  ];
  const classified = (category: string, summary: string) =>
    JSON.stringify({ response: 'ignored', insight: { category, summary, sentiment: 'negative' } });
  /** after() tasks may add more after() tasks; drain until none are left. */
  async function drainAfter() {
    for (let seen = 0; seen < h.afterTasks.length; ) {
      const batch = h.afterTasks.slice(seen);
      seen += batch.length;
      await Promise.all(batch);
    }
  }
  const insightWrites = () =>
    (h.applyInsightWrite.mock.calls as unknown as Array<[string, string, { category: string; summary: string } | null, boolean, { action: string }]>);

  it('refund + bug reason: the answer goes out first, then one groupable insight and auto-grouping', async () => {
    h.runPaymentAgent.mockResolvedValue({
      text: 'Your refund is waiting for the owner to approve.',
      steps: 3,
      finishReason: 'stop',
      toolTrace: refundTrace(REASON),
    });
    let release!: (raw: string) => void;
    h.callLlm.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    h.applyInsightWrite.mockResolvedValue({ id: 'ins-1', created: true } as never);

    const res = await post('5O190127TN364715T a@b.c');
    // The visitor already has the agent's answer while the classifier is still running.
    expect(res.status).toBe(200);
    expect((await res.json()).notice).toBeNull();
    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE, body: 'Your refund is waiting for the owner to approve.' });
    expect(h.applyInsightWrite).not.toHaveBeenCalled();

    release(classified('bug', 'Receipt shows the wrong currency'));
    await drainAfter();

    // The existing feedback classifier, fed the refund reason (not this turn's email), no key-failure record.
    expect(h.callLlm).toHaveBeenCalledTimes(1);
    const [, system, user, opts] = h.callLlm.mock.calls[0];
    expect(system).toContain('## Classification');
    expect(user).toContain(`Visitor: ${REASON}`);
    expect(user).not.toContain('a@b.c');
    expect(opts).toMatchObject({ recordKeyFailure: false });
    // Counted against the same daily budget: one bump for the agent, one for the classifier.
    expect(h.rpc.mock.calls.filter(([name]) => name === 'bump_bot_usage')).toHaveLength(2);

    expect(insightWrites()).toHaveLength(1);
    const [botId, messageId, insight, , plan] = insightWrites()[0];
    expect({ botId, messageId, plan: plan.action }).toEqual({ botId: BOT_ID, messageId: 'msg-1', plan: 'insert' });
    expect(insight).toMatchObject({ category: 'bug', summary: 'Receipt shows the wrong currency' });
    expect(h.scheduleAutoGrouping).toHaveBeenCalledTimes(1);
    expect(h.scheduleAutoGrouping.mock.calls[0]).toEqual([BOT_ID, expect.objectContaining({ deadlineMs: expect.any(Number) })]);
    // The classifier's own reply text is never shown or saved.
    expect(h.saveConversationResponse).toHaveBeenCalledTimes(1);
  });

  it('same problem reported earlier in this conversation: the refund reason extends it (update, no second insight)', async () => {
    const earlier = { id: 'ins-earlier', category: 'bug', summary: 'Receipt shows the wrong currency', source_message_ids: [] };
    h.listExtendableInsights.mockResolvedValue([earlier]);
    const [ref] = [...buildInsightRefMap([earlier]).keys()];
    h.runPaymentAgent.mockResolvedValue({ text: 'Waiting for approval.', steps: 3, finishReason: 'stop', toolTrace: refundTrace(REASON) });
    h.callLlm.mockResolvedValue(JSON.stringify({
      response: 'ignored',
      insight: { category: 'bug', summary: 'Receipt shows the wrong currency', sentiment: 'negative' },
      extends: ref,
    }));
    h.applyInsightWrite.mockResolvedValue({ id: 'ins-earlier', created: false } as never);
    await post('5O190127TN364715T a@b.c');
    await drainAfter();

    // The classifier was shown this conversation's reports, so it could point at the earlier one.
    expect(h.callLlm.mock.calls[0][2]).toContain(`[${ref}] bug · Receipt shows the wrong currency`);
    expect(insightWrites()).toHaveLength(1);
    expect(insightWrites()[0][4]).toEqual({ action: 'update', id: 'ins-earlier' });
    // An update keeps the grouping debounce moving, as for any supplement.
    expect(h.scheduleAutoGrouping).toHaveBeenCalledTimes(1);
  });

  it('status-only question: no classifier call, no insight, no grouping', async () => {
    h.runPaymentAgent.mockResolvedValue({
      text: 'Your payment of $29 is complete.',
      steps: 2,
      finishReason: 'stop',
      toolTrace: [{ toolName: 'get_payment_status', input: {}, output: { verified: true, payment_status: 'paid', refund: null } }],
    });
    await post('where is my order?');
    await drainAfter();

    expect(h.callLlm).not.toHaveBeenCalled();
    expect(insightWrites()).toHaveLength(1);
    expect(insightWrites()[0][2]).toBeNull();
    expect(insightWrites()[0][4]).toEqual({ action: 'skip' });
    expect(h.scheduleAutoGrouping).not.toHaveBeenCalled();
  });

  it('"changed my mind": the insight is kept in a category that is never grouped', async () => {
    h.runPaymentAgent.mockResolvedValue({ text: 'Refunded.', steps: 3, finishReason: 'stop', toolTrace: refundTrace('I changed my mind', 'refunded') });
    h.callLlm.mockResolvedValue(classified('other', 'Refund requested after a change of mind'));
    h.applyInsightWrite.mockResolvedValue({ id: 'ins-2', created: true } as never);
    await post('I changed my mind, refund please');
    await drainAfter();

    expect(insightWrites()).toHaveLength(1);
    expect(insightWrites()[0][2]).toMatchObject({ category: 'other' });
    expect(h.scheduleAutoGrouping).not.toHaveBeenCalled();
  });

  it('a refund call the system turned away (not verified) is not classified', async () => {
    h.runPaymentAgent.mockResolvedValue({
      text: 'I need your order id and email first.',
      steps: 2,
      finishReason: 'stop',
      toolTrace: [{ toolName: 'request_refund', input: { reason: REASON }, output: { status: 'not_verified' } }],
    });
    await post(`refund please, ${REASON}`);
    await drainAfter();
    expect(h.callLlm).not.toHaveBeenCalled();
    expect(insightWrites()[0][2]).toBeNull();
  });

  it('daily budget used up by the agent call: the classifier is not called, no insight', async () => {
    let bumps = 0;
    h.rpc.mockImplementation(async (name: string) => ({ data: name === 'bump_bot_usage' ? (bumps += 30) : 1, error: null }));
    h.runPaymentAgent.mockResolvedValue({ text: 'Waiting for approval.', steps: 3, finishReason: 'stop', toolTrace: refundTrace(REASON) });
    await post('5O190127TN364715T a@b.c');
    await drainAfter();

    expect(h.runPaymentAgent).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
    expect(insightWrites()[0][2]).toBeNull();
    expect(h.scheduleAutoGrouping).not.toHaveBeenCalled();
  });

  it('agent failure path unchanged: fallback + escalate, no classifier, no insight, no grouping', async () => {
    h.runPaymentAgent.mockRejectedValue(new Error('provider 500'));
    await post('refund please');
    await drainAfter();

    expect(saved()).toMatchObject({ responseType: PAYMENT_AGENT_RESPONSE_TYPE, body: PAYMENT_AGENT_FALLBACK });
    expect(h.recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(h.markConversationEscalated).toHaveBeenCalledTimes(1);
    expect(h.callLlm).not.toHaveBeenCalled();
    expect(insightWrites()).toHaveLength(1);
    expect(insightWrites()[0][2]).toBeNull();
    expect(h.scheduleAutoGrouping).not.toHaveBeenCalled();
  });

  it('a late agent answer with a refund reason is classified on the late path too', async () => {
    vi.useFakeTimers();
    let settle!: (v: unknown) => void;
    h.runPaymentAgent.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    h.callLlm.mockResolvedValue(classified('bug', 'Receipt shows the wrong currency'));
    h.applyInsightWrite.mockResolvedValue({ id: 'ins-3', created: true } as never);
    const pending = post('5O190127TN364715T a@b.c');
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await (await pending).json()).notice).toBe(PAYMENT_SLOW_NOTICE);

    settle({ text: 'Waiting for approval.', steps: 3, finishReason: 'stop', toolTrace: refundTrace(REASON) });
    await vi.advanceTimersByTimeAsync(1);
    await drainAfter();
    expect(h.callLlm).toHaveBeenCalledTimes(1);
    expect(insightWrites()[0][2]).toMatchObject({ category: 'bug' });
    expect(h.scheduleAutoGrouping).toHaveBeenCalledTimes(1);
  });
});

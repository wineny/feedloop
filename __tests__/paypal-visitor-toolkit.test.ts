// The PayPal Agent Toolkit lookups a visitor's payment agent gets (paypal_get_order / paypal_get_refund).
// The toolkit tools accept any id, so the guard in visitor-tools.ts is the whole security story:
// only the payment verified in this conversation may be read. Fakes only — no PayPal, no DB.
import { describe, expect, it, vi } from 'vitest';
import { generateText, type Tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { runPaymentAgent } from '@/lib/paypal/agent';
import { PAYPAL_WRITE_TOOL_NAMES, createPayPalTools } from '@/lib/paypal/toolkit';
import type { PaymentActionRow } from '@/lib/paypal/store';
import {
  TOOLKIT_VERIFICATION_TTL_MS,
  TOOLKIT_VISITOR_TOOL_NAMES,
  VISITOR_TOOL_NAMES,
  createVisitorTools,
} from '@/lib/paypal/visitor-tools';
import { BOT, BUYER_EMAIL, CONVERSATION, OTHER_BOT, fakePayPal, memoryStore, orderRow } from './fixtures/paypal/fakes';

const ORDER = 'ORDER0000001';
const CAPTURE = `CAP${ORDER}`;
const REFUND = 'REFUND00000000001';
const ORIGIN = 'https://shop.test';

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
function run(tools: ToolSet, name: string, input: unknown = {}, abortSignal?: AbortSignal) {
  const t = tools[name] as { execute?: Exec } | undefined;
  if (!t?.execute) throw new Error(`tool ${name} missing`);
  return t.execute(input, { toolCallId: 't', messages: [], abortSignal });
}

/** The toolkit's other failure shape: run() returns JSON.stringify(LlmError), which has no `error` key. */
const LLM_ERROR = { ok: false, status: 404, code: 'PAYPAL_API_HTTP_ERROR', message: 'x' };

/** What PayPal's GET /v2/checkout/orders/{id} returns, with the merchant-internal fields the summary must drop. */
function paypalOrder(id = ORDER) {
  return {
    id,
    status: 'COMPLETED',
    intent: 'CAPTURE',
    create_time: '2026-10-18T09:59:00Z',
    update_time: '2026-10-18T10:00:00Z',
    payer: { email_address: BUYER_EMAIL, payer_id: 'PAYERID123', name: { given_name: 'B' } },
    payment_source: { paypal: { email_address: BUYER_EMAIL, account_id: 'PAYERID123' } },
    purchase_units: [
      {
        description: 'Pro',
        custom_id: 'internal-custom',
        amount: { value: '29.00', currency_code: 'USD' },
        payee: { email_address: 'merchant@shop.test', merchant_id: 'MERCHANT1' },
        items: [{ name: 'Pro', quantity: '1', unit_amount: { value: '29.00', currency_code: 'USD' } }],
        payments: {
          captures: [
            {
              id: CAPTURE,
              status: 'PARTIALLY_REFUNDED',
              amount: { value: '29.00', currency_code: 'USD' },
              create_time: '2026-10-18T10:00:00Z',
              seller_receivable_breakdown: { paypal_fee: { value: '1.20', currency_code: 'USD' } },
              seller_protection: { status: 'ELIGIBLE' },
            },
          ],
          refunds: [{ id: REFUND, status: 'COMPLETED', amount: { value: '5.00', currency_code: 'USD' }, create_time: '2026-10-19T08:00:00Z' }],
        },
      },
    ],
    links: [{ href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/x', rel: 'self' }],
  };
}

function paypalRefund(id = REFUND) {
  return {
    id,
    status: 'COMPLETED',
    amount: { value: '5.00', currency_code: 'USD' },
    seller_payable_breakdown: { paypal_fee: { value: '0.10', currency_code: 'USD' } },
    payer: { email_address: 'merchant@shop.test', merchant_id: 'MERCHANT1' },
    invoice_id: 'INV-1',
    create_time: '2026-10-19T08:00:00Z',
    update_time: '2026-10-19T08:00:01Z',
    links: [],
  };
}

/** A toolkit double: the toolkit returns JSON strings, like PayPalAgentToolkit.run(). */
function fakeToolkit(overrides: { order?: unknown; refund?: unknown } = {}) {
  const get_order = vi.fn<Exec>(async (input) => JSON.stringify(overrides.order ?? paypalOrder((input as { id: string }).id)));
  const get_refund = vi.fn<Exec>(async (input) => JSON.stringify(overrides.refund ?? paypalRefund((input as { refund_id: string }).refund_id)));
  const list_disputes = vi.fn<Exec>(async () => '{}');
  const create_refund = vi.fn<Exec>(async () => '{}');
  const toolkit = {
    get_order: { execute: get_order },
    get_refund: { execute: get_refund },
    list_disputes: { execute: list_disputes },
    create_refund: { execute: create_refund },
  } as unknown as Record<string, Tool>;
  return { toolkit, get_order, get_refund, list_disputes, create_refund };
}

function refundAction(overrides: Partial<PaymentActionRow> = {}): PaymentActionRow {
  return {
    id: 'act-1',
    bot_id: BOT,
    conversation_id: CONVERSATION,
    kind: 'refund',
    target_id: CAPTURE,
    amount_cents: 500,
    currency: 'USD',
    customer_key: BUYER_EMAIL,
    origin: 'auto',
    status: 'executed',
    reason: 'wrong size',
    guardrail: null,
    paypal_ref: REFUND,
    error: null,
    decided_by: null,
    decided_at: null,
    created_at: '2026-10-19T08:00:00Z',
    updated_at: '2026-10-19T08:00:01Z',
    reconcile_attempts: 0,
    reconcile_attempted_at: null,
    sent_at: '2026-10-19T08:00:00Z',
    send_attempts: 1,
    ...overrides,
  };
}

function setup(opts: { verified?: boolean; toolkit?: ReturnType<typeof fakeToolkit> } = {}) {
  const store = memoryStore({
    orders: [
      orderRow({ order_id: ORDER, status: 'captured', capture_id: CAPTURE, payer_email: BUYER_EMAIL, captured_at: '2026-10-18T10:00:00Z' }),
      orderRow({ order_id: 'ORDER0000002', status: 'captured', capture_id: 'CAPORDER0000002', payer_email: 'other@example.com' }),
    ],
  });
  const pp = fakePayPal();
  pp.seedCaptured(ORDER, '29.00', 'USD', { captureTime: '2026-10-18T10:00:00Z' });
  const tk = opts.toolkit ?? fakeToolkit();
  const tools = createVisitorTools({ botId: BOT, conversationId: CONVERSATION, store, paypal: pp.client, origin: () => ORIGIN, toolkit: tk.toolkit });
  return { store, pp, tk, tools };
}

async function verify(tools: ToolSet) {
  const r = await run(tools, 'find_my_payment', { order_id: ORDER, email: BUYER_EMAIL });
  expect(r).toMatchObject({ found: true });
}

describe('tool set with the toolkit', () => {
  it('adds only the two guarded lookups — never a raw toolkit tool', () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual([...VISITOR_TOOL_NAMES, ...TOOLKIT_VISITOR_TOOL_NAMES].sort());
    for (const raw of ['get_order', 'get_refund', 'list_disputes', 'get_dispute', ...PAYPAL_WRITE_TOOL_NAMES]) {
      expect(tools).not.toHaveProperty(raw);
    }
  });

  it('without a toolkit (null) is the four visitor tools as before', () => {
    const store = memoryStore();
    const tools = createVisitorTools({ botId: BOT, conversationId: CONVERSATION, store, paypal: fakePayPal().client, origin: () => ORIGIN, toolkit: null });
    expect(Object.keys(tools).sort()).toEqual([...VISITOR_TOOL_NAMES].sort());
  });

  it('built from the real toolkit adapter: lookups present, schemas non-empty, no write tool', async () => {
    const store = memoryStore();
    const toolkit = createPayPalTools({ clientId: 'x', clientSecret: 'y' });
    const tools = createVisitorTools({ botId: BOT, conversationId: CONVERSATION, store, paypal: fakePayPal().client, origin: () => ORIGIN, toolkit });
    expect(Object.keys(tools).sort()).toEqual([...VISITOR_TOOL_NAMES, ...TOOLKIT_VISITOR_TOOL_NAMES].sort());
    let seen: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen = (options.tools ?? []) as never;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    await generateText({ model, tools, prompt: 'hi' });
    expect(Object.keys(seen.find((t) => t.name === 'paypal_get_order')?.inputSchema?.properties ?? {})).toEqual(['order_id']);
    expect(Object.keys(seen.find((t) => t.name === 'paypal_get_refund')?.inputSchema?.properties ?? {})).toEqual(['refund_id']);
    for (const w of PAYPAL_WRITE_TOOL_NAMES) expect(seen.map((t) => t.name)).not.toContain(w);
  });
});

describe('paypal_get_order guard', () => {
  it('refuses when nothing is verified, without calling the toolkit', async () => {
    const { tk, tools } = setup();
    expect(await run(tools, 'paypal_get_order', { order_id: ORDER })).toEqual({ ok: false, reason: 'not_verified' });
    expect(tk.get_order).not.toHaveBeenCalled();
  });

  it("refuses another order id (someone else's, or made up) after verification, without calling the toolkit", async () => {
    const { tk, tools } = setup();
    await verify(tools);
    for (const id of ['ORDER0000002', 'ORDER0000999', '5O190127TN364715T']) {
      expect(await run(tools, 'paypal_get_order', { order_id: id })).toEqual({ ok: false, reason: 'not_your_payment' });
    }
    expect(tk.get_order).not.toHaveBeenCalled();
  });

  it("refuses a verification recorded for another bot", async () => {
    const { store, tk, tools } = setup();
    await store.upsertVerification({
      conversation_id: CONVERSATION, bot_id: OTHER_BOT, order_id: ORDER, capture_id: CAPTURE,
      payer_email: BUYER_EMAIL, amount_cents: 2900, currency: 'USD', captured_at: null,
    });
    expect(await run(tools, 'paypal_get_order', { order_id: ORDER })).toEqual({ ok: false, reason: 'not_verified' });
    expect(tk.get_order).not.toHaveBeenCalled();
  });

  it('allows the verified order id (case/space-insensitive) and returns a summary without merchant fields', async () => {
    const { tk, tools } = setup();
    await verify(tools);
    const r = await run(tools, 'paypal_get_order', { order_id: ` ${ORDER.toLowerCase()} ` });
    expect(tk.get_order).toHaveBeenCalledTimes(1);
    // The toolkit got the server's id, not the model's text.
    expect(tk.get_order.mock.calls[0][0]).toEqual({ id: ORDER });
    expect(r).toEqual({
      ok: true,
      source: 'paypal_agent_toolkit',
      order_id: ORDER,
      status: 'COMPLETED',
      created_at: '2026-10-18T09:59:00Z',
      updated_at: '2026-10-18T10:00:00Z',
      purchases: [
        {
          description: 'Pro',
          amount: '29.00 USD',
          items: [{ name: 'Pro', quantity: '1', unit_amount: '29.00 USD' }],
          captures: [{ status: 'PARTIALLY_REFUNDED', amount: '29.00 USD', created_at: '2026-10-18T10:00:00Z', updated_at: null }],
          refunds: [{ status: 'COMPLETED', amount: '5.00 USD', created_at: '2026-10-19T08:00:00Z', updated_at: null }],
        },
      ],
    });
    const text = JSON.stringify(r);
    for (const leak of ['merchant@shop.test', 'MERCHANT1', 'PAYERID123', 'paypal_fee', 'internal-custom', 'seller_', 'links']) {
      expect(text).not.toContain(leak);
    }
  });

  it.each([
    ['an error string', { error: { message: 'RESOURCE_NOT_FOUND', type: 'paypal_error' } }],
    ['a serialized LlmError', LLM_ERROR],
    // Well-formed but for another order: only the id-equality check catches this one.
    ['a different order', paypalOrder('ORDER0000002')],
  ])('answers unavailable when the toolkit returns %s', async (_label, order) => {
    const { tools } = setup({ toolkit: fakeToolkit({ order }) });
    await verify(tools);
    expect(await run(tools, 'paypal_get_order', { order_id: ORDER })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('paypal_get_refund guard', () => {
  it('refuses when nothing is verified, without calling the toolkit', async () => {
    const { tk, tools } = setup();
    expect(await run(tools, 'paypal_get_refund', { refund_id: REFUND })).toEqual({ ok: false, reason: 'not_verified' });
    expect(tk.get_refund).not.toHaveBeenCalled();
  });

  it('refuses a refund id we did not record on the verified capture, without calling the toolkit', async () => {
    const { store, tk, tools } = setup();
    store.actions.push(refundAction());
    // A refund recorded on another capture, and another bot's refund on this capture.
    store.actions.push(refundAction({ id: 'act-2', target_id: 'CAPORDER0000002', paypal_ref: 'REFUND00000000002' }));
    store.actions.push(refundAction({ id: 'act-3', bot_id: OTHER_BOT, paypal_ref: 'REFUND00000000003' }));
    await verify(tools);
    for (const id of ['REFUND00000000002', 'REFUND00000000003', 'REFUND00000000999']) {
      expect(await run(tools, 'paypal_get_refund', { refund_id: id })).toEqual({ ok: false, reason: 'not_your_payment' });
    }
    expect(tk.get_refund).not.toHaveBeenCalled();
  });

  it('answers no_refund when the verified capture has no recorded refund', async () => {
    const { tk, tools } = setup();
    await verify(tools);
    expect(await run(tools, 'paypal_get_refund', {})).toEqual({ ok: false, reason: 'no_refund' });
    expect(tk.get_refund).not.toHaveBeenCalled();
  });

  it('allows a recorded refund id, and the latest one when refund_id is omitted', async () => {
    const { store, tk, tools } = setup();
    store.actions.push(refundAction({ id: 'old', paypal_ref: 'REFUND00000000000', created_at: '2026-10-18T12:00:00Z' }));
    store.actions.push(refundAction());
    await verify(tools);

    const r = await run(tools, 'paypal_get_refund', { refund_id: REFUND.toLowerCase() });
    expect(tk.get_refund.mock.calls[0][0]).toEqual({ refund_id: REFUND });
    expect(r).toEqual({
      ok: true,
      source: 'paypal_agent_toolkit',
      refund_id: REFUND,
      status: 'COMPLETED',
      status_reason: null,
      amount: '5.00 USD',
      created_at: '2026-10-19T08:00:00Z',
      updated_at: '2026-10-19T08:00:01Z',
    });
    const text = JSON.stringify(r);
    for (const leak of ['merchant@shop.test', 'MERCHANT1', 'paypal_fee', 'INV-1']) expect(text).not.toContain(leak);

    // Omitted → the latest recorded refund (REFUND, not the older one), served from this turn's lookup.
    expect(await run(tools, 'paypal_get_refund', {})).toEqual(r);
    expect(tk.get_refund).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an error string', { error: { message: 'boom', type: 'paypal_error' } }],
    ['a serialized LlmError', LLM_ERROR],
    ['a different refund', paypalRefund('REFUND00000000009')],
  ])('answers unavailable when the toolkit returns %s', async (_label, refund) => {
    const { store, tools } = setup({ toolkit: fakeToolkit({ refund }) });
    store.actions.push(refundAction());
    await verify(tools);
    expect(await run(tools, 'paypal_get_refund', {})).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('toolkit lookup hardening', () => {
  it('returns unavailable when the tool signal aborts while the toolkit hangs (the toolkit ignores the signal)', async () => {
    const hang = fakeToolkit();
    hang.get_order.mockImplementation(() => new Promise(() => {}));
    hang.get_refund.mockImplementation(() => new Promise(() => {}));
    const { store, tools } = setup({ toolkit: hang });
    store.actions.push(refundAction());
    await verify(tools);
    for (const [name, input] of [['paypal_get_order', { order_id: ORDER }], ['paypal_get_refund', {}]] as const) {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10);
      await expect(run(tools, name, input, ctrl.signal)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('within the agent loop, toolMs holds against a hung toolkit call', async () => {
    const hang = fakeToolkit();
    hang.get_order.mockImplementation(() => new Promise(() => {}));
    const { tools } = setup({ toolkit: hang });
    await verify(tools);
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const first = calls++ === 0;
        return {
          content: first
            ? [{ type: 'tool-call', toolCallId: 'o1', toolName: 'paypal_get_order', input: JSON.stringify({ order_id: ORDER }) }]
            : [{ type: 'text', text: 'PayPal is slow right now.' }],
          finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'x' },
          usage,
          warnings: [],
        };
      },
    });
    const started = Date.now();
    const outcome = await runPaymentAgent({ model, tools, system: 's', prompt: 'when did I pay?', timeout: { totalMs: 2000, stepMs: 1000, toolMs: 20 } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(outcome.text).toBe('PayPal is slow right now.');
    const lookup = outcome.toolTrace.find((t) => t.toolName === 'paypal_get_order');
    // Either our race answered (output) or the SDK cut it (error) — never a hang.
    expect(lookup?.output ?? lookup?.error).toBeDefined();
  });

  it('parallel and repeated lookups in one turn reach PayPal once per id', async () => {
    const { store, tk, tools } = setup();
    store.actions.push(refundAction());
    await verify(tools);
    const [a, b] = await Promise.all([
      run(tools, 'paypal_get_order', { order_id: ORDER }),
      run(tools, 'paypal_get_order', { order_id: ORDER.toLowerCase() }),
    ]);
    await run(tools, 'paypal_get_order', { order_id: ORDER });
    expect(a).toEqual(b);
    expect(tk.get_order).toHaveBeenCalledTimes(1);

    await Promise.all([run(tools, 'paypal_get_refund', {}), run(tools, 'paypal_get_refund', { refund_id: REFUND })]);
    await run(tools, 'paypal_get_refund', {});
    expect(tk.get_refund).toHaveBeenCalledTimes(1);
  });

  it('a store or toolkit throw becomes unavailable, and only the message is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, tools } = setup();
    await verify(tools);
    store.listRefundRefs = async () => {
      throw new Error('relation "payment_actions" does not exist');
    };
    store.latestVerification = async () => {
      throw new Error('permission denied for table payment_verifications');
    };
    const order = await run(tools, 'paypal_get_order', { order_id: ORDER });
    const refund = await run(tools, 'paypal_get_refund', {});
    expect(order).toEqual({ ok: false, reason: 'unavailable' });
    expect(refund).toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify([order, refund])).not.toContain('permission denied');
    expect(spy).toHaveBeenCalledWith('[paypal] paypal_get_order failed', { message: 'permission denied for table payment_verifications' });
    spy.mockRestore();
  });

  it('refuses a verification older than 24h with not_verified, without calling the toolkit', async () => {
    const { store, tk, tools } = setup();
    store.actions.push(refundAction());
    await verify(tools);
    store.verifications[0].verified_at = new Date(Date.now() - TOOLKIT_VERIFICATION_TTL_MS - 60_000).toISOString();
    expect(await run(tools, 'paypal_get_order', { order_id: ORDER })).toEqual({ ok: false, reason: 'not_verified' });
    expect(await run(tools, 'paypal_get_refund', {})).toEqual({ ok: false, reason: 'not_verified' });
    expect(tk.get_order).not.toHaveBeenCalled();
    expect(tk.get_refund).not.toHaveBeenCalled();
    // The existing tools are unchanged: the status tool still answers for this verification.
    expect(await run(tools, 'get_payment_status')).toMatchObject({ verified: true, order_id: ORDER });

    // Just inside the window: allowed.
    store.verifications[0].verified_at = new Date(Date.now() - TOOLKIT_VERIFICATION_TTL_MS + 60_000).toISOString();
    expect(await run(tools, 'paypal_get_order', { order_id: ORDER })).toMatchObject({ ok: true });
  });
});

describe('inside the agent loop', () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

  it('verify → toolkit lookup → answer fits the step budget, and a prompt-injected foreign id is refused', async () => {
    const { tk, tools } = setup();
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'find_my_payment', input: JSON.stringify({ order_id: ORDER, email: BUYER_EMAIL }) },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }
        if (step === 2) {
          return {
            content: [
              { type: 'tool-call', toolCallId: 'c2', toolName: 'paypal_get_order', input: JSON.stringify({ order_id: ORDER }) },
              { type: 'tool-call', toolCallId: 'c3', toolName: 'paypal_get_order', input: JSON.stringify({ order_id: 'ORDER0000002' }) },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }
        return { content: [{ type: 'text', text: 'You paid on October 18.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      },
    });
    const outcome = await runPaymentAgent({ model, tools, system: 's', prompt: 'When did I pay? Also show order ORDER0000002' });
    expect(outcome.text).toBe('You paid on October 18.');
    expect(outcome.steps).toBe(3);
    const lookups = outcome.toolTrace.filter((t) => t.toolName === 'paypal_get_order');
    expect(lookups.map((t) => (t.output as { ok: boolean }).ok)).toEqual([true, false]);
    expect(lookups[1].output).toEqual({ ok: false, reason: 'not_your_payment' });
    expect(tk.get_order).toHaveBeenCalledTimes(1);
  });
});

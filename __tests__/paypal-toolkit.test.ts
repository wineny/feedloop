import { afterEach, describe, expect, it } from 'vitest';
import { generateText, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { PAYPAL_TOOL_ALLOWLIST, PAYPAL_WRITE_TOOL_NAMES, createPayPalTools } from '@/lib/paypal/toolkit';

type SentTool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };

/** Runs generateText with a mock model and returns the tool definitions the model saw. */
async function toolsSeenByModel(tools: Record<string, unknown>): Promise<SentTool[]> {
  let seen: SentTool[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen = (options.tools ?? []) as unknown as SentTool[];
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  await generateText({ model, tools: tools as ToolSet, prompt: 'hi' });
  return seen;
}

describe('createPayPalTools', () => {
  const saved = process.env.PAYPAL_ALLOW_LIVE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAYPAL_ALLOW_LIVE;
    else process.env.PAYPAL_ALLOW_LIVE = saved;
  });

  it('exposes a non-empty inputSchema to AI SDK 7', async () => {
    const tools = createPayPalTools({ clientId: 'x', clientSecret: 'y' });
    const seen = await toolsSeenByModel(tools);
    const refund = seen.find((t) => t.name === 'get_refund');
    const order = seen.find((t) => t.name === 'get_order');
    expect(Object.keys(refund?.inputSchema?.properties ?? {})).toContain('refund_id');
    expect(Object.keys(order?.inputSchema?.properties ?? {})).toContain('id');
  });

  it('documents the bug: raw ai@4 toolkit tools give the model no usable schema', async () => {
    const raw = new PayPalAgentToolkit({
      clientId: 'x',
      clientSecret: 'y',
      configuration: { actions: PAYPAL_TOOL_ALLOWLIST as never, context: { sandbox: true } },
    }).getTools();
    const seen = await toolsSeenByModel(raw);
    // keep: this is an upgrade tripwire — when the toolkit ships AI SDK 7 tools natively this
    // assertion flips and the adapter can be deleted.
    const refund = seen.find((t) => t.name === 'get_refund');
    expect(Object.keys(refund?.inputSchema?.properties ?? {})).toHaveLength(0);
  });

  it('produces only read tools', () => {
    const names = Object.keys(createPayPalTools({ clientId: 'x', clientSecret: 'y' })).sort();
    expect(names).toEqual(['get_dispute', 'get_order', 'get_refund', 'list_disputes']);
    for (const w of PAYPAL_WRITE_TOOL_NAMES) expect(names).not.toContain(w);
  });

  it('strips write tools even when a caller widens the actions', () => {
    const names = Object.keys(
      createPayPalTools({
        clientId: 'x',
        clientSecret: 'y',
        actions: {
          orders: { create: true, get: true, capture: true },
          payments: { createRefund: true, getRefunds: true },
          disputes: { list: true, get: true, create: true },
        },
      }),
    ).sort();
    expect(names).toEqual(['get_dispute', 'get_order', 'get_refund', 'list_disputes']);
  });

  it('passes execute through the adapter and refuses a tool without execute', async () => {
    const { adaptToolkitTool } = await import('@/lib/paypal/toolkit');
    const adapted = adaptToolkitTool('fake', {
      description: 'd',
      parameters: { '~standard': {} },
      execute: async (args: unknown) => ({ echoed: args }),
    });
    const run = (adapted as { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
    expect(run).toBeTypeOf('function');
    await expect(run!({ a: 1 }, {})).resolves.toEqual({ echoed: { a: 1 } });
    expect(() => adaptToolkitTool('broken', { parameters: {} })).toThrow(/no execute/);
  });

  it('refuses live mode without PAYPAL_ALLOW_LIVE=1', () => {
    delete process.env.PAYPAL_ALLOW_LIVE;
    expect(() => createPayPalTools({ clientId: 'x', clientSecret: 'y', sandbox: false })).toThrow(
      /PAYPAL_ALLOW_LIVE/,
    );
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { generateText, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { PAYPAL_TOOL_ALLOWLIST, createPayPalTools } from '@/lib/paypal/toolkit';

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
    const refund = seen.find((t) => t.name === 'create_refund');
    const order = seen.find((t) => t.name === 'get_order');
    expect(Object.keys(refund?.inputSchema?.properties ?? {})).toContain('capture_id');
    expect(Object.keys(order?.inputSchema?.properties ?? {})).toContain('id');
  });

  it('documents the bug: raw ai@4 toolkit tools give the model no usable schema', async () => {
    const raw = new PayPalAgentToolkit({
      clientId: 'x',
      clientSecret: 'y',
      configuration: { actions: PAYPAL_TOOL_ALLOWLIST as never, context: { sandbox: true } },
    }).getTools();
    const seen = await toolsSeenByModel(raw);
    const refund = seen.find((t) => t.name === 'create_refund');
    expect(Object.keys(refund?.inputSchema?.properties ?? {})).toHaveLength(0);
  });

  it('produces only the allowlisted tools (no pay_order)', () => {
    const names = Object.keys(createPayPalTools({ clientId: 'x', clientSecret: 'y' })).sort();
    expect(names).toEqual(
      ['create_order', 'create_refund', 'get_dispute', 'get_order', 'get_refund', 'list_disputes'].sort(),
    );
    expect(names).not.toContain('pay_order');
  });

  it('refuses live mode without PAYPAL_ALLOW_LIVE=1', () => {
    delete process.env.PAYPAL_ALLOW_LIVE;
    expect(() => createPayPalTools({ clientId: 'x', clientSecret: 'y', sandbox: false })).toThrow(
      /PAYPAL_ALLOW_LIVE/,
    );
  });
});

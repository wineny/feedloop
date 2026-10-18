// Adapter that exposes the PayPal Agent Toolkit to AI SDK 7.
//
// Why an adapter: @paypal/agent-toolkit bundles its own nested ai@4. Its tools only carry
// `parameters` (zod 3). AI SDK 7 reads `inputSchema`, so passing the raw tools to
// generateText() sends the model an EMPTY schema and it cannot call them properly
// (reproduced 2026-10-18). We re-wrap each tool with `tool({ inputSchema })`.
//
// The toolkit is for read/explain and low-risk calls. Money-moving calls (capture, refund)
// go through PayPalClient in ./client.ts, where our guardrails and idempotency live.

import { tool, type Tool } from 'ai';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { assertLiveAllowed, readPayPalEnv } from './env';

/**
 * Minimal allowlist. `orders.capture` is deliberately absent (it would add `pay_order`),
 * so the model can create/read orders and refunds but never capture on its own.
 */
export const PAYPAL_TOOL_ALLOWLIST = {
  orders: { create: true, get: true },
  payments: { createRefund: true, getRefunds: true },
  disputes: { list: true, get: true },
} as const;

export type PayPalToolAllowlist = Record<string, Record<string, boolean>>;

/** Shape of a toolkit tool, which comes from the toolkit's nested ai@4 `Tool` type. */
interface ToolkitTool {
  description?: string;
  parameters: unknown;
  execute?: (args: unknown, options: unknown) => Promise<unknown>;
}

/**
 * Wraps one ai@4 toolkit tool as an AI SDK 7 tool.
 *
 * The result of `execute` is returned untouched. NOTE: the toolkit does not throw on
 * failure, it returns a string like `{"error": ...}`. Callers must parse the result to
 * decide success; a resolved promise alone does not mean PayPal accepted the call.
 */
export function adaptToolkitTool(name: string, v4tool: unknown): Tool {
  const t = v4tool as ToolkitTool;
  const run = t.execute;
  if (!run) throw new Error(`PayPal toolkit tool "${name}" has no execute function`);
  // Narrow casts: the toolkit's schema is zod 3 (exposes ~standard, which v7 accepts)
  // but its static type comes from ai@4, so TypeScript cannot relate it to v7's types.
  return tool({
    description: t.description,
    inputSchema: t.parameters as never,
    execute: (input: unknown, options: unknown) => run(input, options),
  } as never) as Tool;
}

export interface CreatePayPalToolsOptions {
  clientId: string;
  clientSecret: string;
  actions?: PayPalToolAllowlist;
  /** Defaults to true. false requires PAYPAL_ALLOW_LIVE=1. */
  sandbox?: boolean;
}

export function createPayPalTools(opts: CreatePayPalToolsOptions): Record<string, Tool> {
  const sandbox = opts.sandbox ?? true;
  assertLiveAllowed(sandbox);
  const toolkit = new PayPalAgentToolkit({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    configuration: {
      actions: (opts.actions ?? PAYPAL_TOOL_ALLOWLIST) as never,
      context: { sandbox },
    },
  });
  const raw = toolkit.getTools() as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).map(([name, t]) => [name, adaptToolkitTool(name, t)]),
  );
}

/** Builds the allowlisted tools from PAYPAL_* environment variables. */
export function toolkitFromEnv(): Record<string, Tool> {
  const env = readPayPalEnv();
  return createPayPalTools({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    sandbox: env.sandbox,
  });
}

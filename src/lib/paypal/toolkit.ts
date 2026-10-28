// Adapter that exposes the PayPal Agent Toolkit to AI SDK 7.
//
// Why an adapter: @paypal/agent-toolkit bundles its own nested ai@4. Its tools only carry
// `parameters` (zod 3). AI SDK 7 reads `inputSchema`, so passing the raw tools to
// generateText() sends the model an EMPTY schema and it cannot call them properly
// (reproduced 2026-10-18). We re-wrap each tool with `tool({ inputSchema })`.
//
// The toolkit is READ-ONLY here. Every call that moves money or picks an amount (create order,
// capture, refund) goes through PayPalClient in ./client.ts behind our own server tools, where
// the guardrail RPC, the price table and PayPal-Request-Id idempotency live. Giving the model the
// toolkit's own write tools would let a prompt-injected visitor refund or order any amount with
// no cap and no audit row (review 2026-10-19, five reviewers agreed).

import { tool, type Tool } from 'ai';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import type { PayPalBot } from './bot';
import { assertLiveAllowed, readPayPalEnv } from './env';

/**
 * Read-only allowlist. No `orders.create` (model-chosen amounts), no `orders.capture`
 * (`pay_order`), no `payments.createRefund` (bypasses the guardrail RPC and lets the model omit
 * the amount, which PayPal treats as a full refund). `__tests__/paypal-toolkit.test.ts` pins this.
 */
export const PAYPAL_TOOL_ALLOWLIST = {
  orders: { get: true },
  payments: { getRefunds: true },
  disputes: { list: true, get: true },
} as const;

/** Tool names that must never reach the model through this adapter, whatever the allowlist says. */
export const PAYPAL_WRITE_TOOL_NAMES = ['create_order', 'pay_order', 'create_refund', 'accept_dispute_claim'] as const;

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
  // Second line of defence: even a widened `actions` argument cannot hand the model a write tool.
  const writes = new Set<string>(PAYPAL_WRITE_TOOL_NAMES);
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([name]) => !writes.has(name))
      .map(([name, t]) => [name, adaptToolkitTool(name, t)]),
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

/**
 * The toolkit tools a bot's visitor agent gets, built from the bot's own PayPal keys (per-bot keys,
 * or the deployment's PAYPAL_* keys for the demo bot — same resolution as `bot.client`).
 *
 * These are RAW lookups: any order or refund id. They must never reach the model directly — the
 * visitor tools (visitor-tools.ts) wrap get_order / get_refund behind the verified-payment guard.
 * Sandbox only: a live bot gets none (null), and so does a bot whose toolkit cannot be built — the
 * agent then answers with its own four tools, as before.
 */
export function toolkitToolsForBot(bot: Pick<PayPalBot, 'id' | 'sandbox' | 'credentials'>): Record<string, Tool> | null {
  if (!bot.sandbox) return null;
  try {
    return createPayPalTools({ ...bot.credentials(), sandbox: true });
  } catch (err) {
    console.error('[paypal] toolkit unavailable for bot', { botId: bot.id, message: (err as Error).message });
    return null;
  }
}

/**
 * Reads what a toolkit tool returned. The toolkit's `run()` never throws. On failure it returns a
 * JSON string: `{"error": ...}`, or a serialized LlmError `{"ok":false,"status":404,"code":...,"message":...}`
 * (no `error` key). Returns the parsed object on success, null on anything else (either error shape,
 * a non-object, unparsable text). Callers still check the object is the record they asked for.
 */
export function parseToolkitResult(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('error' in value || (value as { ok?: unknown }).ok === false) return null;
  return value as Record<string, unknown>;
}

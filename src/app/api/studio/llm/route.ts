// Refund Studio's LLM turn — AG Studio's Agent Framework, answered by Claude.
//
// The browser adapter (`lib/studio/claude-adapter.ts`) posts one AG Studio turn (`AgLlmRequest`: conversation,
// instructions, tool schemas). This route translates it for the AI SDK, calls Claude once (no tool execution here —
// Studio runs every tool in the page), and streams back NDJSON events the adapter turns into AG Studio events.
//
// Public on purpose (Refund Studio works logged out), so it is bounded: see `lib/studio/llm-guard.ts`, plus a model
// allow-list and an output cap. Production reads only STUDIO_ANTHROPIC_API_KEY. It reads and writes nothing in the database.

import { NextResponse, type NextRequest } from 'next/server';
import { jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readBoundedJson } from '@/lib/http/body';
import { clientIp } from '@/lib/widget/http';
import { studioLlmKey, STUDIO_MODELS, STUDIO_DEFAULT_MODEL } from '@/lib/studio/llm-config';
import {
  createStudioLimiter,
  hashIp,
  isSameOriginRequest,
  MAX_BODY_BYTES,
  parseStudioRequest,
  STUDIO_SYSTEM_GUARD,
  STUDIO_TOOLS,
} from '@/lib/studio/llm-guard';
import type { StudioStreamEvent } from '@/lib/studio/llm-protocol';

export const maxDuration = 120;

const MAX_OUTPUT_TOKENS = 4096;
const limit = createStudioLimiter();
const TURN_FAILED = 'The Refund Studio agent could not finish this turn. Try again.';
const NOT_ACCEPTED = 'Request not accepted. If this chat is long, start a new chat.';
const LIMIT_MESSAGE = {
  minute: 'Too many agent requests. Try again in a minute.',
  day: 'You have reached the agent limit for today.',
  global: 'The agent has reached its limit for today.',
};

// --- AG Studio request (subset this route reads) ------------------------------------------------

type AgItem =
  | { kind: 'input'; type: 'message'; role: 'user' | 'system'; content: { type: string; text?: string }[] }
  | { kind: 'output'; type: 'message'; role: 'assistant'; content: { type: string; text?: string; refusal?: string }[] }
  | { kind: 'output'; type: 'function_call'; callId: string; name: string; arguments: string }
  | { kind?: 'input'; type: 'function_call_output'; callId: string; output: string }
  | { kind: 'output'; type: 'reasoning' };

interface AgRequest {
  input: AgItem[];
  instructions?: string;
  tools?: { name: string; description?: string; parameters?: Record<string, unknown>; kind?: string }[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?: { type: 'text' } | { type: 'json'; name: string; description?: string; schema: unknown };
  model?: { id?: string };
}

const textOf = (parts: { type: string; text?: string; refusal?: string }[]) =>
  (Array.isArray(parts) ? parts : []).map((p) => p.text ?? p.refusal ?? '').filter(Boolean).join('\n');

/** AG Studio conversation → AI SDK messages. Assistant text + tool calls of one turn share a message; results group too. */
function toMessages(items: AgItem[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  type AssistantPart = { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };
  type ToolPart = { type: 'tool-result'; toolCallId: string; toolName: string; output: { type: 'text'; value: string } };

  const lastAssistant = (): AssistantPart[] => {
    const last = out.at(-1);
    if (last?.role === 'assistant' && Array.isArray(last.content)) return last.content as AssistantPart[];
    const content: AssistantPart[] = [];
    out.push({ role: 'assistant', content } as ModelMessage);
    return content;
  };
  const lastTool = (): ToolPart[] => {
    const last = out.at(-1);
    if (last?.role === 'tool') return last.content as ToolPart[];
    const content: ToolPart[] = [];
    out.push({ role: 'tool', content } as ModelMessage);
    return content;
  };

  for (const item of items) {
    if (item.type === 'reasoning') continue;
    if (item.type === 'message' && item.kind === 'input') {
      const text = textOf(item.content);
      if (!text) continue;
      // Mid-conversation system notes from Studio go in as user turns, labelled — Claude takes one system prompt.
      out.push({ role: 'user', content: item.role === 'system' ? `[Studio note]\n${text}` : text });
    } else if (item.type === 'message') {
      const text = textOf(item.content);
      if (text) lastAssistant().push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      toolNames.set(item.callId, item.name);
      let input: unknown = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        input = {};
      }
      lastAssistant().push({ type: 'tool-call', toolCallId: item.callId, toolName: item.name, input });
    } else if (item.type === 'function_call_output') {
      lastTool().push({
        type: 'tool-result',
        toolCallId: item.callId,
        toolName: toolNames.get(item.callId) ?? 'tool',
        output: { type: 'text', value: item.output || '(empty)' },
      });
    }
  }
  // Claude needs the conversation to start with a user turn.
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(Start.)' });
  return out;
}

/** Claude requires an object root for tool input. Wrap anything else rather than reject the whole turn. */
function objectSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (schema && schema.type === 'object') return schema;
  return { type: 'object', properties: schema ? { value: schema } : {}, ...(schema ? { required: ['value'] } : {}) };
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req.headers)) return NextResponse.json({ error: { message: 'Not allowed.' } }, { status: 403 });
  const key = studioLlmKey();
  if (!key) return NextResponse.json({ error: { message: 'The Refund Studio agent is not configured.' } }, { status: 503 });

  const read = await readBoundedJson<unknown>(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: { message: NOT_ACCEPTED } }, { status: read.status });
  const parsed = parseStudioRequest(read.value);
  if (!parsed) return NextResponse.json({ error: { message: NOT_ACCEPTED } }, { status: 400 });

  // After validation, so malformed requests cannot use up the day's limit for everyone.
  const ip = clientIp(req);
  const verdict = limit(ip);
  if (verdict !== 'ok') {
    console.warn(JSON.stringify({ event: 'studio_llm_limited', limit: verdict, ip: hashIp(ip) }));
    return NextResponse.json({ error: { message: LIMIT_MESSAGE[verdict] } }, { status: 429 });
  }
  const body = parsed as unknown as AgRequest;

  const modelId = body.model?.id && STUDIO_MODELS.includes(body.model.id) ? body.model.id : STUDIO_DEFAULT_MODEL;

  const tools: ToolSet = {};
  // `wrapped` remembers which tools got an object wrapper, so their input is unwrapped on the way back.
  const wrapped = new Set<string>();
  for (const t of body.tools ?? []) {
    if (t.kind === 'provided' || !STUDIO_TOOLS.has(t.name)) continue; // provider-hosted tools are OpenAI-specific
    const params = t.parameters as Record<string, unknown> | undefined;
    if (!params || params.type !== 'object') wrapped.add(t.name);
    tools[t.name] = tool({ description: t.description ?? '', inputSchema: jsonSchema(objectSchema(params)) });
  }

  let system = `${STUDIO_SYSTEM_GUARD}\n\n${body.instructions ?? ''}`;
  if (body.responseFormat?.type === 'json') {
    system +=
      `\n\nRespond with only a JSON value (no prose, no code fence) matching this JSON Schema` +
      `${body.responseFormat.name ? ` ("${body.responseFormat.name}")` : ''}:\n${JSON.stringify(body.responseFormat.schema)}`;
  }

  // Claude Sonnet 5.5 rejects forced tool choice (`tool` / `any`): "not supported for this model". Studio asks for it
  // on some turns, so the request goes out as `auto` with the requirement written into the system prompt instead.
  const tc = body.toolChoice;
  const hasTools = Object.keys(tools).length > 0;
  let toolChoice: 'auto' | 'none' | undefined = hasTools ? 'auto' : undefined;
  if (hasTools && tc === 'none') toolChoice = 'none';
  else if (hasTools && tc === 'required') system += '\n\nThis turn you must call one of the available tools.';
  else if (hasTools && typeof tc === 'object' && tc && STUDIO_TOOLS.has(tc.name) && tools[tc.name]) system += `\n\nThis turn you must call the tool "${tc.name}".`;

  const result = streamText({
    model: createAnthropic({ apiKey: key })(modelId),
    system,
    messages: toMessages(body.input),
    tools: Object.keys(tools).length ? tools : undefined,
    toolChoice,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 1,
    abortSignal: req.signal,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StudioStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta' && part.text) send({ t: 'text', delta: part.text });
          else if (part.type === 'tool-call') {
            const input = wrapped.has(part.toolName) ? (part.input as { value?: unknown })?.value : part.input;
            // Input cut off at the output cap arrives as raw text; left as it is so AG Studio can repair the JSON.
            send({ t: 'tool', id: part.toolCallId, name: part.toolName, args: typeof input === 'string' ? input : JSON.stringify(input ?? {}) });
          } else if (part.type === 'error') {
            console.error('studio_llm_error', part.error instanceof Error ? part.error.message : String(part.error));
            send({ t: 'error', message: TURN_FAILED });
          } else if (part.type === 'finish') {
            const u = part.totalUsage;
            const usage = { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0 };
            console.log(JSON.stringify({ event: 'studio_llm', ip: hashIp(ip), model: modelId, finishReason: part.finishReason, ...usage }));
            send({ t: 'done', model: modelId, finishReason: part.finishReason, usage });
          }
        }
      } catch (err) {
        console.error('studio_llm_error', err instanceof Error ? err.message : String(err));
        send({ t: 'error', message: TURN_FAILED });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}

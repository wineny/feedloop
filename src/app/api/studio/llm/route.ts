// Refund Studio's LLM turn — AG Studio's Agent Framework, answered by Claude.
//
// The browser adapter (`lib/studio/claude-adapter.ts`) posts one AG Studio turn (`AgLlmRequest`: conversation,
// instructions, tool schemas). This route translates it for the AI SDK, calls Claude once (no tool execution here —
// Studio runs every tool in the page), and streams back NDJSON events the adapter turns into AG Studio events.
//
// Public on purpose (Refund Studio works logged out), so it is bounded: model allow-list, output cap, per-IP limits,
// and in production a dedicated key (STUDIO_ANTHROPIC_API_KEY) whose spend limit is set in the Anthropic Console.
// It reads and writes nothing in the database.

import { NextResponse, type NextRequest } from 'next/server';
import { jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { clientIp } from '@/lib/widget/http';
import { studioLlmKey, STUDIO_MODELS, STUDIO_DEFAULT_MODEL } from '@/lib/studio/llm-config';
import type { StudioStreamEvent } from '@/lib/studio/llm-protocol';

export const maxDuration = 120;

const MAX_OUTPUT_TOKENS = 4096;
const MAX_BODY_BYTES = 400_000;
const PER_MINUTE = 30;
const PER_DAY = 400;

const minuteHits = new Map<string, number[]>();
const dayHits = new Map<string, { day: string; n: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (minuteHits.get(ip) ?? []).filter((t) => t > now - 60_000);
  recent.push(now);
  minuteHits.set(ip, recent);
  const day = new Date(now).toISOString().slice(0, 10);
  const d = dayHits.get(ip);
  const n = d && d.day === day ? d.n + 1 : 1;
  dayHits.set(ip, { day, n });
  if (minuteHits.size > 5000) minuteHits.clear();
  if (dayHits.size > 5000) dayHits.clear();
  return recent.length > PER_MINUTE || n > PER_DAY;
}

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
  parts.map((p) => p.text ?? p.refusal ?? '').filter(Boolean).join('\n');

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
  const key = studioLlmKey();
  if (!key) return NextResponse.json({ error: { message: 'The Refund Studio agent is not configured.' } }, { status: 503 });
  if (rateLimited(clientIp(req))) {
    return NextResponse.json({ error: { message: 'Too many agent requests. Try again in a minute.' } }, { status: 429 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: { message: 'Request too large.' } }, { status: 413 });
  let body: AgRequest;
  try {
    body = JSON.parse(raw) as AgRequest;
  } catch {
    return NextResponse.json({ error: { message: 'Request body must be JSON.' } }, { status: 400 });
  }
  if (!Array.isArray(body.input)) return NextResponse.json({ error: { message: 'Missing input.' } }, { status: 400 });

  const modelId = body.model?.id && STUDIO_MODELS.includes(body.model.id) ? body.model.id : STUDIO_DEFAULT_MODEL;

  const tools: ToolSet = {};
  // `wrapped` remembers which tools got an object wrapper, so their input is unwrapped on the way back.
  const wrapped = new Set<string>();
  for (const t of body.tools ?? []) {
    if (t.kind === 'provided' || !t.name) continue; // provider-hosted tools are OpenAI-specific; not offered to Claude
    const params = t.parameters as Record<string, unknown> | undefined;
    if (!params || params.type !== 'object') wrapped.add(t.name);
    tools[t.name] = tool({ description: t.description ?? '', inputSchema: jsonSchema(objectSchema(params)) });
  }

  let system = body.instructions ?? '';
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
  else if (hasTools && typeof tc === 'object' && tools[tc.name]) system += `\n\nThis turn you must call the tool "${tc.name}".`;

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
            send({ t: 'tool', id: part.toolCallId, name: part.toolName, args: JSON.stringify(input ?? {}) });
          } else if (part.type === 'error') {
            send({ t: 'error', message: part.error instanceof Error ? part.error.message : String(part.error) });
          } else if (part.type === 'finish') {
            const u = part.totalUsage;
            send({ t: 'done', model: modelId, finishReason: part.finishReason, usage: { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0 } });
          }
        }
      } catch (err) {
        send({ t: 'error', message: err instanceof Error ? err.message : 'LLM call failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}

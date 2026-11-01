// AG Studio LLM adapter (`AgLlmAdapter`) for Claude. Runs in the browser and holds no key: it posts each turn to
// `/api/studio/llm`, which calls Claude through the AI SDK and streams back small NDJSON events
// (`llm-protocol.ts`). This file turns those into AG Studio's events (AG-UI shapes) and the turn's final response.
//
// AG Studio ships an OpenAI adapter only; translating on the server keeps this side short — no JSON Schema
// rewriting, no provider stream format.

import type { AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from 'ag-studio';
import type { StudioStreamEvent } from './llm-protocol';

interface Outcome {
  response?: AgLlmResponse;
  error?: Error;
}

let seq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

async function* streamTurn(endpoint: string, request: AgLlmRequest, outcome: Outcome, signal?: AbortSignal): AsyncGenerator<AgAiEvent> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }

  const messageId = newId('msg');
  let text = '';
  let textOpen = false;
  const calls: AgAiOutputItem[] = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = function* (e: StudioStreamEvent): Generator<AgAiEvent> {
    if (e.t === 'text') {
      if (!textOpen) {
        textOpen = true;
        yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } as AgAiEvent;
      }
      text += e.delta;
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: e.delta } as AgAiEvent;
    } else if (e.t === 'tool') {
      if (textOpen) {
        textOpen = false;
        yield { type: 'TEXT_MESSAGE_END', messageId } as AgAiEvent;
      }
      yield { type: 'TOOL_CALL_START', toolCallId: e.id, toolCallName: e.name } as AgAiEvent;
      yield { type: 'TOOL_CALL_ARGS', toolCallId: e.id, delta: e.args } as AgAiEvent;
      yield { type: 'TOOL_CALL_END', toolCallId: e.id } as AgAiEvent;
      calls.push({ id: e.id, kind: 'output', type: 'function_call', callId: e.id, name: e.name, arguments: e.args, status: 'completed' });
    } else if (e.t === 'error') {
      outcome.error ??= new Error(e.message);
    } else if (e.t === 'done') {
      const output: AgAiOutputItem[] = [
        ...(text ? [{ id: messageId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] } as AgAiOutputItem] : []),
        ...calls,
      ];
      outcome.response = {
        id: newId('resp'),
        createdAt: Math.floor(Date.now() / 1000),
        model: e.model,
        status: e.finishReason === 'length' ? 'incomplete' : 'completed',
        incompleteDetails: e.finishReason === 'length' ? { reason: 'max_output_tokens' } : undefined,
        output,
        usage: { inputTokens: e.usage.input, outputTokens: e.usage.output, totalTokens: e.usage.input + e.usage.output },
      } as AgLlmResponse;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield* handle(JSON.parse(line) as StudioStreamEvent);
      } catch (err) {
        outcome.error ??= err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield* handle(JSON.parse(buffer) as StudioStreamEvent);
    } catch {
      // A cut-off last line: the turn has no `done`, which is reported below.
    }
  }
  if (textOpen) yield { type: 'TEXT_MESSAGE_END', messageId } as AgAiEvent;
}

export function claudeAdapter({ endpoint = '/api/studio/llm' }: { endpoint?: string } = {}): AgLlmAdapter {
  return {
    executeTurn(request, options): AgLlmResponseHandler {
      const outcome: Outcome = {};
      let resolve!: (r: AgLlmResponse) => void;
      let reject!: (e: Error) => void;
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A consumer that stops reading early never awaits `complete`; keep that rejection observed.
      void complete.catch(() => {});

      // The failure is reported once, through `complete` (same contract as AG Studio's example adapter).
      async function* wrapped(): AsyncGenerator<AgAiEvent> {
        try {
          yield* streamTurn(endpoint, request, outcome, options?.signal);
        } catch (err) {
          outcome.error ??= err instanceof Error ? err : new Error(String(err));
        }
        if (outcome.error) reject(outcome.error);
        else if (outcome.response) resolve(outcome.response);
        else reject(new Error('The agent stream ended without a response.'));
      }
      const it = wrapped();
      return { stream: { [Symbol.asyncIterator]: () => it }, complete };
    },
  };
}

// The NDJSON lines `/api/studio/llm` streams to the browser adapter — one JSON object per line.
// Small on purpose: the adapter rebuilds AG Studio's own event stream from these.

export type StudioStreamEvent =
  | { t: 'text'; delta: string }
  | { t: 'tool'; id: string; name: string; args: string }
  | { t: 'error'; message: string }
  | { t: 'done'; model: string; finishReason: string; usage: { input: number; output: number } };

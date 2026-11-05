import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createStudioLimiter,
  isSameOriginRequest,
  MAX_BODY_BYTES,
  parseStudioRequest,
  STUDIO_TOOLS,
} from '@/lib/studio/llm-guard';

const streamText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), streamText }));

const turn = (over: Record<string, unknown> = {}) => ({
  input: [{ kind: 'input', type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  instructions: 'Dashboard help',
  tools: [{ name: 'view_page', parameters: { type: 'object', properties: {} } }],
  ...over,
});

describe('STUDIO_TOOLS', () => {
  it('covers every built-in tool in the installed ag-studio bundle', () => {
    const bundle = readFileSync('node_modules/ag-studio/dist/package/main.esm.mjs', 'utf8');
    const names = [...bundle.matchAll(/\bname: "([a-z]+(?:_[a-z]+)+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(15);
    expect(names.filter((n) => !STUDIO_TOOLS.has(n))).toEqual([]);
  });
});

describe('parseStudioRequest', () => {
  it('accepts a Studio turn, with extra fields left alone', () => {
    expect(parseStudioRequest(turn({ responseFormat: { type: 'text' }, toolChoice: { name: 'complete_task' } }))).not.toBeNull();
  });

  it('rejects a request without tools, so it cannot be a plain chat', () => {
    expect(parseStudioRequest(turn({ tools: [] }))).toBeNull();
  });

  it('rejects a request whose tools are all invented', () => {
    expect(parseStudioRequest(turn({ tools: [{ name: 'my_tool' }] }))).toBeNull();
  });

  it('rejects oversized instructions and conversations', () => {
    expect(parseStudioRequest(turn({ instructions: 'x'.repeat(30_001) }))).toBeNull();
    expect(parseStudioRequest(turn({ input: Array(121).fill({ type: 'message' }) }))).toBeNull();
  });

  it.each([[null], ['text'], [{ input: 'x' }], [turn({ tools: 'x' })], [turn({ toolChoice: 3 })]])('rejects malformed body %#', (body) => {
    expect(parseStudioRequest(body)).toBeNull();
  });

  it('knows the Refund Watch tools', () => {
    for (const name of ['scan_refund_reasons', 'find_fix_for_reason', 'add_reason_alert']) expect(STUDIO_TOOLS.has(name)).toBe(true);
  });
});

describe('isSameOriginRequest', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it('accepts the page calling its own host', () => {
    expect(isSameOriginRequest(headers({ origin: 'https://feedloop-demo.vercel.app', host: 'feedloop-demo.vercel.app', 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('prefers the forwarded host', () => {
    expect(isSameOriginRequest(headers({ origin: 'https://a.example', host: 'internal', 'x-forwarded-host': 'a.example' }))).toBe(true);
  });

  it('rejects another site, a missing Origin, and a bad Origin', () => {
    expect(isSameOriginRequest(headers({ origin: 'https://evil.example', host: 'feedloop-demo.vercel.app' }))).toBe(false);
    expect(isSameOriginRequest(headers({ host: 'feedloop-demo.vercel.app' }))).toBe(false);
    expect(isSameOriginRequest(headers({ origin: 'null', host: 'feedloop-demo.vercel.app' }))).toBe(false);
  });

  it('rejects a cross-site fetch even when Origin matches', () => {
    expect(isSameOriginRequest(headers({ origin: 'https://a.example', host: 'a.example', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });
});

describe('createStudioLimiter', () => {
  const NOON = Date.parse('2026-11-05T12:00:00Z');

  it('limits one IP to 30 calls a minute, then lets it back', () => {
    const check = createStudioLimiter();
    for (let i = 0; i < 30; i++) expect(check('a', NOON)).toBe('ok');
    expect(check('a', NOON)).toBe('minute');
    expect(check('b', NOON)).toBe('ok');
    expect(check('a', NOON + 61_000)).toBe('ok');
  });

  it('limits one IP per day, and resets the next day', () => {
    const check = createStudioLimiter();
    for (let i = 0; i < 200; i++) expect(check('a', NOON + i * 3_000)).toBe('ok');
    expect(check('a', NOON + 300 * 3_000)).toBe('day');
    expect(check('a', NOON + 86_400_000)).toBe('ok');
  });

  it('stops everyone at the daily total, and resets the next day', () => {
    const check = createStudioLimiter();
    for (let i = 0; i < 400; i++) expect(check(`ip${i}`, NOON)).toBe('ok');
    expect(check('new', NOON)).toBe('global');
    expect(check('new', NOON + 86_400_000)).toBe('ok');
  });

  it('does not reset live counters when many IPs arrive', () => {
    const check = createStudioLimiter();
    for (let i = 0; i < 30; i++) check('a', NOON);
    for (let i = 0; i < 5002; i++) check(`flood${i}`, NOON);
    expect(check('a', NOON)).toBe('minute');
  });

  it('does not count refused calls toward the daily limit', () => {
    const check = createStudioLimiter();
    for (let i = 0; i < 30; i++) check('a', NOON);
    for (let i = 0; i < 500; i++) expect(check('a', NOON)).toBe('minute');
    for (let i = 0; i < 170; i++) expect(check('a', NOON + 3_600_000 + i * 3_000)).toBe('ok');
  });
});

describe('POST /api/studio/llm', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    streamText.mockClear();
  });

  const call = async (body: string, headers: Record<string, string> = {}) => {
    vi.stubEnv('STUDIO_ANTHROPIC_API_KEY', 'test-key');
    const { POST } = await import('@/app/api/studio/llm/route');
    const res = await POST(new NextRequest('https://a.example/api/studio/llm', { method: 'POST', body, headers: { host: 'a.example', origin: 'https://a.example', ...headers } }));
    return res.status;
  };

  it('refuses other origins without calling Claude', async () => {
    expect(await call(JSON.stringify(turn()), { origin: 'https://evil.example' })).toBe(403);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('refuses malformed bodies and oversized bodies without calling Claude', async () => {
    expect(await call('{not json')).toBe(400);
    expect(await call(JSON.stringify({ input: 'x' }))).toBe(400);
    expect(await call(JSON.stringify(turn({ instructions: '한'.repeat(MAX_BODY_BYTES / 2) })))).toBe(413);
    expect(streamText).not.toHaveBeenCalled();
  });

  it('does not send provider error text to the browser', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    streamText.mockReturnValue({ fullStream: (async function* () { yield { type: 'error', error: new Error('credit balance too low') }; })() });
    vi.stubEnv('STUDIO_ANTHROPIC_API_KEY', 'test-key');
    const { POST } = await import('@/app/api/studio/llm/route');
    const res = await POST(new NextRequest('https://a.example/api/studio/llm', { method: 'POST', body: JSON.stringify(turn()), headers: { host: 'a.example', origin: 'https://a.example' } }));
    const text = await res.text();
    expect(text).toContain('could not finish');
    expect(text).not.toContain('credit balance');
  });

  it('puts the fixed purpose first and drops tools Studio does not have', async () => {
    streamText.mockReturnValue({ fullStream: (async function* () {})() });
    expect(await call(JSON.stringify(turn({ tools: [{ name: 'view_page' }, { name: 'my_tool' }] })))).toBe(200);
    const args = streamText.mock.calls[0][0];
    expect(args.system.startsWith('You work only inside Refund Studio')).toBe(true);
    expect(Object.keys(args.tools)).toEqual(['view_page']);
  });
});

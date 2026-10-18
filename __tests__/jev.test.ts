import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJevRequest, JEV_TIMEOUT_MS, parseJevResponse, refineCategoryWithJev } from '@/lib/classify/jev';
import { TAXONOMY_BLOCK } from '@/lib/classify/taxonomy';

const insight = { category: 'ux', sentiment: 'negative', summary: '결제 불편', follow_up_needed: true };
const answer = (confidence = 0.8, choice = 'bug') => JSON.stringify({
  answers: { category: { choice, confidence }, sentiment: { choice: 'positive' }, follow_up: { noul: 0 } },
});
const fetchMock = vi.fn();
beforeEach(() => { vi.stubEnv('JEV_API_KEY', 'test-key'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Jev category refinement', () => {
  it('overrides at the threshold and preserves all other LLM fields', async () => {
    fetchMock.mockResolvedValue(new Response(answer(0.7)));
    expect(await refineCategoryWithJev('결제 안 돼요', insight)).toEqual({ ...insight, category: 'bug', classified_by: 'jev', classify_confidence: 0.7 });
    expect(fetchMock).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    }));
    expect(buildJevRequest('test').questions.category.instructions).toContain(TAXONOMY_BLOCK);
  });
  it('retains LLM category below the threshold while recording confidence', async () => {
    fetchMock.mockResolvedValue(new Response(answer(0.69)));
    expect(await refineCategoryWithJev('test', insight)).toEqual({ ...insight, classified_by: 'llm', classify_confidence: 0.69 });
  });
  it('does not call fetch without a key', async () => {
    vi.stubEnv('JEV_API_KEY', '');
    expect(await refineCategoryWithJev('test', insight)).toEqual({ ...insight, classified_by: 'llm', classify_confidence: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['http', 'network', 'schema'])('falls back on %s without logging input', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('private visitor text'));
    else fetchMock.mockResolvedValue(new Response(failure === 'schema' ? answer(0.9, 'invalid') : '', { status: failure === 'http' ? 500 : 200 }));
    expect(await refineCategoryWithJev('private visitor text', insight)).toEqual({ ...insight, classified_by: 'llm', classify_confidence: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private visitor text');
  });
  it('aborts after three seconds and preserves the insight', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    try {
      const result = refineCategoryWithJev('test', insight);
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
      expect(await result).toEqual({ ...insight, classified_by: 'llm', classify_confidence: null });
      expect(JEV_TIMEOUT_MS).toBe(3000);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it.each(['null', '{}', 'bad json', answer(2), answer(-1)])('rejects malformed response %s', (raw) => {
    expect(parseJevResponse(raw)).toBeNull();
  });
});

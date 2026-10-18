import { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrReview, mergeBlockedBy } from '@/lib/auto-dev/pr-review';

const auth = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/auto-dev/github-auth', () => ({
  octokitForBot: async () => ({ octokit: auth.client, source: 'platform', botId: null }),
  noteGithubError: vi.fn(),
}));

let requests: URL[];
let lateStatus: string;
let lateCheck: string;
let denied: string | null;
beforeEach(() => {
  requests = []; lateStatus = 'success'; lateCheck = 'success'; denied = null;
  // Real Octokit pagination and response normalization, with only HTTP transport replaced.
  auth.client = new Octokit({ request: { fetch: async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input.toString());
    requests.push(new URL(url));
    const responseUrl = url.toString();
    const pathname = url.pathname;
    const page = url.searchParams.get('page') ?? '1';
    let data: unknown;
    let link: string | undefined;
    if (denied && pathname.endsWith(denied)) return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
    if (pathname.endsWith('/pulls/8')) data = { number: 8, state: 'open', draft: true, merged: false, created_at: '2026-10-09T00:00:00Z', head: { sha: 'head-sha', ref: 'fix/x' }, base: { ref: 'main' } };
    else if (pathname.endsWith('/check-runs')) {
      data = { total_count: 101, check_runs: page === '1' ? Array.from({ length: 100 }, (_, i) => ({ name: `check-${i}`, status: 'completed', conclusion: 'success' })) : [{ name: 'last-check', status: lateCheck === 'pending' ? 'in_progress' : 'completed', conclusion: lateCheck, details_url: 'https://github.com/check-log' }] };
      if (page === '1') { url.searchParams.set('page', '2'); link = `<${url}>; rel="next"`; }
    } else if (pathname.endsWith('/statuses')) {
      data = page === '1' ? Array.from({ length: 100 }, (_, i) => ({ context: i === 0 ? 'Vercel' : `status-${i}`, state: 'success', updated_at: '2026-10-09T01:00:00Z' })) : [
        { context: 'late-status', state: lateStatus, target_url: 'https://github.com/status-log', updated_at: '2026-10-09T00:00:00Z' },
        { context: 'Vercel', state: 'failure', updated_at: '2026-10-08T00:00:00Z' },
      ];
      if (page === '1') { url.searchParams.set('page', '2'); link = `<${url}>; rel="next"`; }
    } else data = [];
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...(link ? { link } : {}) } });
    Object.defineProperty(response, 'url', { value: responseUrl });
    return response;
  } } });
});

describe('all CI pages through real Octokit', () => {
  it.each(['failure', 'pending'])('later check %s is not hidden behind 100 successful statuses and checks', async (state) => {
    lateCheck = state;
    const review = await getPrReview('https://github.com/o/r', 8);
    expect(review.build.state).toBe(state);
    expect(mergeBlockedBy(review)).toBe(state === 'failure' ? 'build_failed' : 'build_pending');
    if (state === 'failure') expect(review.build.failedChecks).toEqual([{ name: 'last-check', url: 'https://github.com/check-log' }]);
    expect(requests.filter((u) => u.pathname.endsWith('/check-runs'))).toHaveLength(2);
  });
  it('later status failure is included while obsolete status failure is ignored', async () => {
    lateStatus = 'failure';
    const review = await getPrReview('https://github.com/o/r', 8);
    expect(review.build.state).toBe('failure');
    expect(review.build.failedChecks).toEqual([{ name: 'late-status', url: 'https://github.com/status-log' }]);
    expect(requests.filter((u) => u.pathname.endsWith('/statuses'))).toHaveLength(2);
  });
  it('all latest signals pass despite old failed status on later page', async () => {
    const review = await getPrReview('https://github.com/o/r', 8);
    expect(review.build).toMatchObject({ state: 'success', unavailable: false, failedChecks: [] });
    expect(requests.find((u) => u.pathname.endsWith('/check-runs'))?.searchParams.get('filter')).toBe('latest');
  });
  it.each(['/check-runs', '/statuses'])('cannot claim a complete pass when %s is denied', async (path) => {
    denied = path;
    expect((await getPrReview('https://github.com/o/r', 8)).build).toMatchObject({ state: 'unknown', unavailable: true });
  });
  it.each(['failure', 'pending'])('keeps observed %s even if other source is denied', async (state) => {
    denied = '/statuses'; lateCheck = state;
    expect((await getPrReview('https://github.com/o/r', 8)).build).toMatchObject({ state, unavailable: true });
  });
});

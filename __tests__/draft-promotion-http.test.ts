import { beforeEach, expect, it, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
const auth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auto-dev/github-auth', () => ({ octokitForBot: auth, noteGithubError: vi.fn() }));
vi.mock('@/lib/auto-dev/draft-gate-lock', () => ({ acquireDraftGateLease: async () => ({ assertOwned: async () => {}, release: async () => {} }) }));
import { reviewAndPromoteDraft, DRAFT_FAILED_MARKER } from '@/lib/auto-dev/draft-promotion';
import { mergeBlockedBy } from '@/lib/auto-dev/pr-review';
import { effectiveBlock } from '@/lib/hooks/usePrReview';
let draft: boolean;
let failed: boolean;
let mutations: number;
let creates: number;
let requestedPages: number[];
let deniedStatus: number | null;
let comments: { id: number; body: string; user?: { login: string } }[];
function response(data: unknown, headers?: Record<string, string>, status = 200) {
  const res = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(res, 'url', { value: 'https://api.github.com/repos/o/r/commits/sha/statuses?per_page=100' });
  return res;
}
beforeEach(() => {
  draft = true; failed = false; mutations = 0; creates = 0; comments = []; requestedPages = []; deniedStatus = null;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    if (path === '/user') return response({ login: 'owner' });
    if (path === '/graphql') {
      expect(method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      if (body.query.startsWith('query DraftHistory')) return response({ data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } } });
      // Transport validates exact mutation and variable binding, not a canned arbitrary result.
      expect(body.query).toBe('mutation Ready($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { isDraft } } }');
      expect(body.variables).toEqual({ pullRequestId: 'PR_http' });
      if (!draft) throw new Error('duplicate promotion');
      draft = false; mutations++;
      return response({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (path === '/repos/o/r/pulls/1') return response({ number: 1, node_id: 'PR_http', html_url: 'https://github.com/o/r/pull/1', state: 'open', merged: false, draft, created_at: '2026-01-01T00:00:00Z', mergeable: true, head: { sha: 'sha', ref: 'fix', repo: { full_name: 'o/r' } }, base: { ref: 'main' }, body: '## 자동 검사 대기' });
    if (path.endsWith('/files') || path.endsWith('/deployments')) return response([]);
    if (deniedStatus && (path.endsWith('/check-runs') || path.endsWith('/commits/sha/statuses'))) {
      return response({ message: 'Signal unavailable' }, undefined, deniedStatus);
    }
    if (path.endsWith('/check-runs')) return response({ total_count: 0, check_runs: [] });
    if (path.endsWith('/commits/sha/statuses')) return response( [{ context: 'Vercel', state: failed ? 'failure' : 'success', target_url: 'https://vercel.com/log' }]);
    if (path === '/repos/o/r/issues/1/comments' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1'); requestedPages.push(page);
      return response(comments.slice((page - 1) * 100, page * 100), comments.length > page * 100 ? { link: '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next"' } : undefined);
    }
    if (path === '/repos/o/r/issues/1/comments' && method === 'POST') {
      const body = JSON.parse(String(init?.body)); creates++;
      const comment = { id: comments.length + 1, body: body.body, user: { login: 'owner' } }; comments.push(comment);
      return response(comment);
    }
    if (path.startsWith('/repos/o/r/issues/comments/') && method === 'PATCH') {
      const id = Number(path.split('/').at(-1)); const comment = comments.find(c => c.id === id);
      if (!comment) throw new Error('unknown comment');
      comment.body = JSON.parse(String(init?.body)).body; return response(comment);
    }
    throw new Error(`Unexpected GitHub request ${method} ${url}`);
  });
  auth.mockResolvedValue({ octokit: new Octokit({ auth: 'test', request: { fetch } }), source: 'platform' });
});
it.each([403, 404])('real HTTP %s pauses automatic promotion but allows explicit human promotion', async status => {
  deniedStatus = status;
  const automatic = await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(automatic).toMatchObject({ draft: true, draftGate: 'awaiting_human', build: { state: 'unknown', unavailable: true }, draftGateBlocked: 'checks_unavailable' });
  expect(effectiveBlock({ review: automatic, blockedBy: mergeBlockedBy(automatic), legacyExplanation: null, pickedTargets: [], pickedShots: [] })).toBeNull();
  expect(mutations).toBe(0); expect(creates).toBe(0);
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true })).toMatchObject({ draft: false, draftGate: 'promoted' });
  expect(mutations).toBe(1);
  expect(comments[0].body).toContain('권한이 없어 담당자 판단으로 반영');
  expect(comments[0].body).not.toContain('자동 검사를 통과');
  await reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true });
  expect(mutations).toBe(1);
});
it.each([500, 502, 503])('real HTTP %s stays an error even for explicit human merge', async status => {
  deniedStatus = status;
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true })).rejects.toMatchObject({ status });
  expect(mutations).toBe(0); expect(creates).toBe(0);
});
it('real Octokit and real review promote with correct GraphQL request once across polls', async () => {
  expect((await reviewAndPromoteDraft('https://github.com/o/r', 1)).draftGate).toBe('promoted');
  expect((await reviewAndPromoteDraft('https://github.com/o/r', 1)).draft).toBe(false);
  expect(mutations).toBe(1); expect(creates).toBe(1);
  expect(comments[0].body).toContain('자동 검사를 통과해 검토 요청으로 바꿨습니다');
});
it('real pagination finds marker on HTTP page two and avoids failure comment duplication', async () => {
  failed = true;
  comments = [...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'discussion' })), { id: 101, body: DRAFT_FAILED_MARKER, user: { login: 'owner' } }];
  const review = await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(review.draftGate).toBe('failed'); expect(review.build.failedChecks).toEqual([{ name: 'Vercel', url: 'https://vercel.com/log' }]);
  expect(requestedPages).toEqual([1, 2]); expect(creates).toBe(0); expect(mutations).toBe(0);
});

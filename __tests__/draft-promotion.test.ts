import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReview } from '@/lib/auto-dev/pr-review';
const mocks = vi.hoisted(() => ({ leaseOwner: null as string | null, expired: false, rpc: vi.fn(), review: vi.fn(), auth: vi.fn(), note: vi.fn(), comments: [] as { id: number; body: string; user?: { login: string; type?: string }; performed_via_github_app?: { slug: string } }[], draft: true, create: vi.fn(), update: vi.fn(), history: vi.fn(), graphql: vi.fn(), get: vi.fn(), paginate: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/lib/auto-dev/github-auth', () => ({ octokitForBot: mocks.auth, noteGithubError: mocks.note }));
vi.mock('@/lib/auto-dev/pr-review', async (original) => ({ ...await original<typeof import('@/lib/auto-dev/pr-review')>(), getPrReview: mocks.review }));
import { decideDraftPromotion, reviewAndPromoteDraft, DRAFT_FAILED_MARKER, DRAFT_PROMOTION_MARKER } from '@/lib/auto-dev/draft-promotion';
const base: PrReview = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'open', merged: false, draft: true, draftGate: 'waiting', createdAt: '2026-01-01T00:00:00Z', mergeable: true, mergeableState: 'clean', headRef: 'fix', headSha: 'sha', headRepo: 'o/r', baseRef: 'main', additions: 1, deletions: 0, changedFiles: 0, files: [], filesTruncated: false, preview: { url: null, state: 'unknown' }, build: { state: 'success', description: null, targetUrl: null, updatedAt: null, unavailable: false }, body: '## 자동 검사 대기' };

it('explicit human merge promotes unavailable draft without claiming check success', async () => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'unknown', unavailable: true } });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true })).toMatchObject({ draft: false, draftGate: 'promoted' });
  expect(mocks.graphql).toHaveBeenCalledTimes(1);
  expect(mocks.comments).toHaveLength(1);
  expect(mocks.comments[0].body).toContain('검사 결과를 읽을 권한이 없어 담당자 판단으로 반영');
  expect(mocks.comments[0].body).not.toContain('자동 검사를 통과');
});
it.each(['failure', 'pending'] as const)('human merge never overrides known %s despite unavailable signals', async state => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state, unavailable: true } });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true })).toMatchObject({ draft: true });
  expect(mocks.graphql).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it('explicit unavailable merge click is a new human decision even after a previous manual hold', async () => {
  mocks.review.mockResolvedValue({ ...base, body: null, build: { ...base.build, state: 'unknown', unavailable: true } });
  mocks.history.mockResolvedValue({ repository: { pullRequest: { timelineItems: { nodes: [{ id: 'manual-redraft' }] } } } });
  expect((await reviewAndPromoteDraft('https://github.com/o/r', 1, { allowUnavailableForMerge: true })).draft).toBe(false);
  expect(mocks.history).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.note.mockResolvedValue(undefined); mocks.leaseOwner = null; mocks.expired = false;
  mocks.rpc.mockImplementation(async (name, args) => {
    if (name === 'claim_draft_pr_gate') {
      if (mocks.leaseOwner) return { data: false, error: null };
      mocks.leaseOwner = args.p_owner; return { data: true, error: null };
    }
    if (name === 'owns_draft_pr_gate') return { data: !mocks.expired && mocks.leaseOwner === args.p_owner, error: null };
    if (name === 'release_draft_pr_gate' && mocks.leaseOwner === args.p_owner) mocks.leaseOwner = null;
    return { data: true, error: null };
  });
  mocks.comments = []; mocks.draft = true;
  mocks.review.mockImplementation(async () => ({ ...base, draft: mocks.draft, draftGate: mocks.draft ? 'waiting' : 'not_draft' }));
  mocks.paginate.mockImplementation(async () => mocks.comments);
  mocks.create.mockImplementation(async ({ body }) => { const c = { id: mocks.comments.length + 1, body, user: { login: 'owner' } }; mocks.comments.push(c); return { data: c }; });
  mocks.update.mockImplementation(async ({ comment_id, body }) => { mocks.comments.find(c => c.id === comment_id)!.body = body; return { data: {} }; });
  mocks.history.mockResolvedValue({ repository: { pullRequest: { timelineItems: { nodes: [] } } } });
  mocks.graphql.mockImplementation(async () => { mocks.draft = false; return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }; });
  mocks.get.mockImplementation(async () => ({ data: { state: 'open', merged: false, draft: mocks.draft, head: { sha: 'sha' }, node_id: 'PR_1' } }));
  mocks.auth.mockResolvedValue({ source: 'platform', octokit: { users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'owner' } }) }, paginate: mocks.paginate, graphql: (query: string, args: unknown) => query.startsWith('query ') ? mocks.history(query, args) : mocks.graphql(query, args), pulls: { get: mocks.get }, issues: { listComments: vi.fn(), createComment: mocks.create, updateComment: mocks.update } } });
});
describe('draft promotion decision', () => {
  it.each([['success', 'promote'], ['failure', 'keep_failed'], ['pending', 'wait']] as const)('%s -> %s', (state, expected) => {
    expect(decideDraftPromotion({ ...base, build: { ...base.build, state } })).toBe(expected);
  });
  it.each([false, true])('unknown unavailable=%s waits exactly ten minutes', (unavailable) => {
    const input = { ...base, build: { ...base.build, state: 'unknown' as const, unavailable } };
    expect(decideDraftPromotion({ ...input, now: Date.parse(base.createdAt) + 599999 })).toBe('wait');
    expect(decideDraftPromotion({ ...input, now: Date.parse(base.createdAt) + 600000 })).toBe(unavailable ? 'wait' : 'promote');
  });
  it('does not promote a ready PR or an invalid creation date', () => {
    expect(decideDraftPromotion({ ...base, draft: false })).toBe('not_draft');
    expect(decideDraftPromotion({ ...base, createdAt: 'invalid', build: { ...base.build, state: 'unknown' } })).toBe('wait');
  });
});
describe('draft gate executor', () => {
  it('promotes using scoped bot auth and returns updated fields', async () => {
    expect(await reviewAndPromoteDraft('https://github.com/o/r', 1, { botId: 'bot' })).toMatchObject({ draft: false, draftGate: 'promoted' });
    expect(mocks.auth).toHaveBeenCalledWith('bot', { repoUrl: 'https://github.com/o/r', timeoutMs: 15000 });
    expect(mocks.graphql).toHaveBeenCalledWith(expect.stringContaining('markPullRequestReadyForReview'), { pullRequestId: 'PR_1' });
    expect(mocks.comments).toHaveLength(1);
    expect(mocks.comments[0].body).toContain('자동 검사를 통과해 검토 요청으로 바꿨습니다');
  });
  it('serializes concurrent polls and deduplicates mutation and comments', async () => {
    await Promise.all([reviewAndPromoteDraft('https://github.com/o/r', 1), reviewAndPromoteDraft('https://github.com/o/r', 1)]);
    expect(mocks.graphql).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('returns actual ready state on failed completion comment and skips ready gate retries', async () => {
    mocks.update.mockRejectedValueOnce(new Error('network'));
    await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).resolves.toMatchObject({ draft: false, draftGateBlocked: 'write_failed' });
    expect(mocks.draft).toBe(false);
    expect((await reviewAndPromoteDraft('https://github.com/o/r', 1)).draft).toBe(false);
    expect(mocks.graphql).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it('records failure only once and sanitizes names and links', async () => {
    mocks.review.mockResolvedValue({ ...base, draftGate: 'failed', build: { ...base.build, state: 'failure', failedChecks: [{ name: '[evil](javascript:x)', url: 'javascript:x' }, { name: 'build', url: 'https://ci.test/log' }] } });
    await reviewAndPromoteDraft('https://github.com/o/r', 1); await reviewAndPromoteDraft('https://github.com/o/r', 1);
    expect(mocks.graphql).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.comments[0].body).toContain(DRAFT_FAILED_MARKER);
    expect(mocks.comments[0].body).toContain('\\[evil\\]'); expect(mocks.comments[0].body).toContain('<https://ci.test/log>');
    expect(mocks.comments[0].body).not.toContain('<javascript:');
  });
  it.each([{ state: 'closed' }, { merged: true }, { draftGate: 'unsupported' }, { build: { ...base.build, state: 'pending' } }])('does not mutate blocked states %j', async (override) => {
    mocks.review.mockResolvedValue({ ...base, ...override });
    await reviewAndPromoteDraft('https://github.com/o/r', 1);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it('does not promote when the head changes after reading checks', async () => {
    mocks.get.mockResolvedValue({ data: { state: 'open', merged: false, draft: true, head: { sha: 'new' } } });
    await reviewAndPromoteDraft('https://github.com/o/r', 1); expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it('reuses persisted promotion intent on retry', async () => {
    mocks.comments.push({ id: 2, body: DRAFT_PROMOTION_MARKER, user: { login: 'owner' } });
    await reviewAndPromoteDraft('https://github.com/o/r', 1); expect(mocks.create).not.toHaveBeenCalled();
  });
});

it('leaves ordinary ready PRs read-only without requesting comment permissions', async () => {
  mocks.review.mockResolvedValue({ ...base, draft: false, body: null });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.auth).not.toHaveBeenCalled();
});
it('passes request timeout through repository-scoped credentials', async () => {
  await reviewAndPromoteDraft('https://github.com/o/r', 1, { botId: 'b', timeoutMs: 1000 });
  expect(mocks.auth).toHaveBeenCalledWith('b', { repoUrl: 'https://github.com/o/r', timeoutMs: 1000 });
});
it('finds failure markers in the fully paginated result', async () => {
  mocks.comments = [...Array.from({ length: 100 }, (_, id) => ({ id, body: 'discussion' })), { id: 101, body: DRAFT_FAILED_MARKER, user: { login: 'owner' } }];
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'failure' } });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.paginate).toHaveBeenCalledWith(expect.any(Function), { owner: 'o', repo: 'r', issue_number: 1, per_page: 100 });
  expect(mocks.create).not.toHaveBeenCalled();
});
it('reports failures from both build sources with safe URLs', async () => {
  const { summarizeBuild } = await import('@/lib/auto-dev/pr-review');
  const selected = summarizeBuild([{ context: 'Vercel', state: 'failure', target_url: 'https://vercel.com/log' }, { context: 'other', state: 'failure', target_url: 'https://other.test' }], [{ name: 'ignored', status: 'completed', conclusion: 'failure' }]);
  expect(selected.failedChecks).toEqual([{ name: 'Vercel', url: 'https://vercel.com/log' }, { name: 'other', url: 'https://other.test' }, { name: 'ignored', url: null }]);
  expect(summarizeBuild([], [{ name: 'Vercel Preview Comments', status: 'completed', conclusion: 'failure' }, { name: 'build', status: 'completed', conclusion: 'failure', details_url: 'javascript:x' }]).failedChecks).toEqual([{ name: 'build', url: null }]);
});
it('recovers a lost mutation response after GitHub made the PR ready', async () => {
  mocks.graphql.mockImplementationOnce(async () => { mocks.draft = false; throw new Error('lost response'); });
  expect((await reviewAndPromoteDraft('https://github.com/o/r', 1)).draftGate).toBe('promoted');
  expect(mocks.comments[0].body).toContain('바꿨습니다');
});
it('does not report promotion when GitHub rejects the transition', async () => {
  mocks.graphql.mockRejectedValueOnce(new Error('denied'));
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).resolves.toMatchObject({ draft: true, draftGateBlocked: 'write_failed' });
  expect(mocks.comments[0].body).not.toContain('바꿨습니다');
  expect(mocks.update).not.toHaveBeenCalled();
});
it('explains grace promotion without claiming checks passed', async () => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'unknown', unavailable: false } });
  expect((await reviewAndPromoteDraft('https://github.com/o/r', 1)).draft).toBe(false);
  expect(mocks.comments[0].body).toContain('확인할 수 있는 검사가 없어');
  expect(mocks.comments[0].body).not.toContain('검사를 통과');
});

it('shared lease contention returns read-only without any GitHub writes', async () => {
  mocks.leaseOwner = 'other-instance';
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.leaseOwner).toBe('other-instance');
});
it('expired lease fails closed before the first GitHub write', async () => {
  mocks.expired = true;
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).resolves.toMatchObject({ draft: true, draftGate: 'waiting', draftGateBlocked: 'lock_unavailable' });
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.graphql).not.toHaveBeenCalled();
  expect(mocks.leaseOwner).toBeNull();
});
it('rechecks lease before mutation after creating intent', async () => {
  mocks.get.mockImplementationOnce(async () => { mocks.expired = true; return { data: { state: 'open', draft: true, head: { sha: 'sha' }, node_id: 'PR_1' } }; });
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).resolves.toMatchObject({ draft: true, draftGate: 'waiting', draftGateBlocked: 'lock_unavailable' });
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.graphql).not.toHaveBeenCalled();
});
it.each(['missing RPC', 'database error', 'network rejection'])('returns the original review without GitHub writes when claim fails: %s', async (failure) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (failure === 'network rejection') mocks.rpc.mockRejectedValue(new Error('network down'));
  else mocks.rpc.mockResolvedValue({ data: null, error: { message: failure, code: failure === 'missing RPC' ? 'PGRST202' : 'XX000' } });
  const result = await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(result).toMatchObject({ draft: true, draftGate: 'waiting', draftGateBlocked: 'lock_unavailable' });
  expect(mocks.review).toHaveBeenCalledTimes(1);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.graphql).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledTimes(1);
  warning.mockRestore();
});
it('release RPC failure preserves the completed promotion result', async () => {
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((name, args) => name === 'release_draft_pr_gate'
    ? Promise.resolve({ data: null, error: { message: 'release missing' } }) : original(name, args));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: false, draftGate: 'promoted' });
  expect(mocks.graphql).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
  warning.mockRestore();
});
it('ownership and release RPC failures log once and keep the actual failed draft state', async () => {
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation((name, args) => name === 'claim_draft_pr_gate' ? original(name, args)
    : Promise.resolve({ data: null, error: { message: 'RPC unavailable' } }));
  mocks.review.mockResolvedValue({ ...base, draftGate: 'failed', build: { ...base.build, state: 'failure' } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGate: 'failed' });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.note).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledTimes(1);
  warning.mockRestore();
});
it('read-only pending checks do not depend on the lease database', async () => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'pending' } });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('ready PR skips comment recovery even after build changes', async () => {
  mocks.review.mockImplementation(async () => ({ ...base, draft: mocks.draft, build: { ...base.build, state: mocks.draft ? 'unknown' : 'failure' } }));
  mocks.update.mockRejectedValueOnce(new Error('network'));
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).resolves.toMatchObject({ draft: false, draftGateBlocked: 'write_failed' });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.comments[0].body).toContain('reason:grace');
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it('lease helper enforces independent owner claims and releases only its identity', async () => {
  const { acquireDraftGateLease } = await import('@/lib/auto-dev/draft-gate-lock');
  const first = await acquireDraftGateLease('o/r/1');
  expect(first).not.toBeNull();
  expect(await acquireDraftGateLease('o/r/1')).toBeNull();
  await first!.assertOwned();
  await first!.release();
  const second = await acquireDraftGateLease('o/r/1');
  expect(second).not.toBeNull();
  await expect(first!.assertOwned()).rejects.toThrow('lease expired');
  await first!.release();
  await second!.assertOwned();
  await second!.release();
});

it.each(['success', 'unknown'] as const)('still-draft retry persists current %s reason before promotion', async (state) => {
  mocks.comments.push({ id: 1, body: DRAFT_PROMOTION_MARKER + (state === 'success' ? '\n<!-- feedloop:draft-gate:reason:grace -->' : ''), user: { login: 'owner' } });
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state } });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.comments[0].body).toContain(state === 'success' ? '검사를 통과' : '확인할 수 있는 검사가 없어');
  expect(mocks.update).toHaveBeenCalledTimes(2);
});

it.each([DRAFT_PROMOTION_MARKER, DRAFT_FAILED_MARKER])('ignores forged marker %s', async (marker) => {
  mocks.comments.push({ id: 41, body: marker, user: { login: 'attacker' } });
  if (marker === DRAFT_FAILED_MARKER) mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'failure' } });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.update).not.toHaveBeenCalledWith(expect.objectContaining({ comment_id: 41 }));
  expect(mocks.comments[0].body).toBe(marker);
});
it('does not honor a forged completed promotion marker', async () => {
  mocks.comments.push({ id: 41, body: DRAFT_PROMOTION_MARKER + '\n검토 요청으로 바꿨습니다', user: { login: 'attacker' } });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: false });
  expect(mocks.graphql).toHaveBeenCalledTimes(1);
});
it.each(['success', 'failure'] as const)('holds manually redrafted %s PR with trusted completed comment', async state => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state } });
  mocks.comments.push({ id: 1, body: DRAFT_PROMOTION_MARKER + '\n검토 요청으로 바꿨습니다', user: { login: 'owner' } });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGateBlocked: 'manual_draft' });
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.graphql).not.toHaveBeenCalled();
});
it('holds manual redraft after the success comment was lost', async () => {
  mocks.comments.push({ id: 1, body: DRAFT_PROMOTION_MARKER, user: { login: 'owner' } });
  mocks.history.mockResolvedValue({ repository: { pullRequest: { timelineItems: { nodes: [{ id: 'conversion' }] } } } });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGateBlocked: 'manual_draft' });
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.graphql).not.toHaveBeenCalled();
});
it.each([null, 'ordinary PR body'])('does not gate manual draft without automatic waiting section: %s', async body => {
  mocks.review.mockResolvedValue({ ...base, body });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled();
});
it('ready automatic PR reads review once without lease or comments', async () => {
  mocks.review.mockResolvedValue({ ...base, draft: false });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.review).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled();
});
it('reuses the review already read for actionable draft', async () => {
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.review).toHaveBeenCalledTimes(1);
});
it('escapes user and team mentions in failure names', async () => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'failure', failedChecks: [{ name: '@person @org/team', url: null }] } });
  await reviewAndPromoteDraft('https://github.com/o/r', 1);
  expect(mocks.comments[0].body).toContain('@\u200bperson @\u200borg/team');
  expect(mocks.comments[0].body).not.toContain('@org/team');
});
it.each(['comments', 'history', 'create', 'mutation', 'update'] as const)('returns actual review after %s failure and records correct operation', async operation => {
  const error = Object.assign(new Error('permission denied'), { status: 403 });
  ({ comments: mocks.paginate, history: mocks.history, create: mocks.create, mutation: mocks.graphql, update: mocks.update })[operation].mockRejectedValueOnce(error);
  const result = await reviewAndPromoteDraft('https://github.com/o/r', 1, { botId: 'b' });
  expect(result).toMatchObject({ draft: operation !== 'update', draftGateBlocked: ['comments', 'history'].includes(operation) ? 'gate_failed' : 'write_failed' });
  expect(mocks.note).toHaveBeenCalledWith('b', 'platform', error, { write: !['comments', 'history'].includes(operation) });
});
it('does not mark secondary rate limits as missing push permission', async () => {
  mocks.create.mockRejectedValueOnce(Object.assign(new Error('secondary rate limit'), { status: 403 }));
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1, { botId: 'b' })).toMatchObject({ draftGateBlocked: 'write_failed' });
  expect(mocks.note).not.toHaveBeenCalled();
});
it('does not hide initial PR read failures', async () => {
  mocks.review.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(reviewAndPromoteDraft('https://github.com/o/r', 1)).rejects.toThrow('read unavailable');
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('returns review if authentication or history data is unavailable', async () => {
  mocks.auth.mockRejectedValueOnce(new Error('auth unavailable'));
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGateBlocked: 'gate_failed' });
  mocks.history.mockResolvedValueOnce({ repository: null });
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGateBlocked: 'gate_failed' });
  expect(mocks.graphql).not.toHaveBeenCalled();
});
it.each([
  ['feedloop', 'feedloop[bot]', 'Bot', true],
  ['other', 'feedloop[bot]', 'Bot', false],
  ['feedloop', 'other[bot]', 'Bot', false],
  ['feedloop', 'feedloop[bot]', 'User', false],
] as const)('installation marker requires app=%s login=%s type=%s', async (slug, login, type, trusted) => {
  vi.stubEnv('GITHUB_APP_ID', '1'); vi.stubEnv('GITHUB_APP_SLUG', 'feedloop'); vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'key'); vi.stubEnv('GITHUB_APP_CLIENT_ID', 'id'); vi.stubEnv('GITHUB_APP_CLIENT_SECRET', 'secret');
  try {
    const auth = await mocks.auth(); mocks.auth.mockResolvedValue({ ...auth, source: 'installation' });
    mocks.comments.push({ id: 1, body: DRAFT_FAILED_MARKER, user: { login, type }, performed_via_github_app: { slug } });
    mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state: 'failure' } });
    await reviewAndPromoteDraft('https://github.com/o/r', 1);
    expect(mocks.create).toHaveBeenCalledTimes(trusted ? 0 : 1);
    expect(auth.octokit.users.getAuthenticated).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

 it.each(['success', 'unknown', 'failure', 'pending'] as const)('does not write when either build source is unreadable: %s', async state => {
  mocks.review.mockResolvedValue({ ...base, build: { ...base.build, state, unavailable: true } });
  expect(decideDraftPromotion({ ...base, build: { state, unavailable: true }, now: Date.parse(base.createdAt) + 3600000 })).toBe(state === 'failure' ? 'keep_failed' : 'wait');
  expect(await reviewAndPromoteDraft('https://github.com/o/r', 1)).toMatchObject({ draft: true, draftGateBlocked: 'checks_unavailable' });
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.graphql).not.toHaveBeenCalled();
});

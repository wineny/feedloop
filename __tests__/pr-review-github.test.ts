import { describe, it, expect, vi, beforeEach } from 'vitest';

// getPrReview — fine-grained 토큰에 Deployments·Checks·Commit statuses 권한이 없으면 그 셋은 403 이다.
// diff(listFiles)만 필수이고 나머지 조회 실패는 화면을 유지하되 검사를 확인할 때까지 반영을 막는다.

const { octokit, noteGithubError } = vi.hoisted(() => ({
  octokit: {
    paginate: vi.fn(async (method, args) => { const { data } = await method(args); return data.check_runs ?? data; }),
    pulls: { get: vi.fn(), listFiles: vi.fn() },
    repos: { listDeployments: vi.fn(), listCommitStatusesForRef: vi.fn(), listDeploymentStatuses: vi.fn() },
    checks: { listForRef: vi.fn() },
  },
  noteGithubError: vi.fn(async () => {}),
}));
vi.mock('@/lib/auto-dev/github-auth', () => ({
  octokitForBot: vi.fn(async () => ({ octokit, source: 'bot' })),
  noteGithubError,
}));

const forbidden = () => Promise.reject(Object.assign(new Error('Resource not accessible by personal access token'), { status: 403 }));

beforeEach(() => {
  vi.clearAllMocks();
  octokit.pulls.get.mockResolvedValue({ data: {
    number: 8, html_url: 'https://github.com/o/r/pull/8', state: 'open', merged: false, mergeable: true, mergeable_state: 'clean',
    head: { ref: 'fix/x', sha: 'sha', repo: { full_name: 'o/r' } }, base: { ref: 'main' },
    additions: 1, deletions: 0, changed_files: 1, body: null,
  } });
  octokit.pulls.listFiles.mockResolvedValue({ data: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '+x' }] });
});

describe('getPrReview 권한 없는 부가 신호', () => {
  it('배포·체크·상태가 403 이어도 diff는 오고 담당자가 확인 없이 반영할 수 있다', async () => {
    octokit.repos.listDeployments.mockImplementation(forbidden);
    octokit.checks.listForRef.mockImplementation(forbidden);
    octokit.repos.listCommitStatusesForRef.mockImplementation(forbidden);
    const { getPrReview, mergeBlockedBy } = await import('@/lib/auto-dev/pr-review');
    const review = await getPrReview('https://github.com/o/r', 8, { botId: 'bot-1' });
    expect(review.files).toHaveLength(1);
    expect(review.preview.state).toBe('unknown');
    expect(review.build.state).toBe('unknown');
    // «못 물어봤다»는 표시 — 전체 통과를 확인하기 전에는 반영할 수 없다.
    expect(review.build.unavailable).toBe(true);
    expect(mergeBlockedBy(review)).toBeNull();
    // 부가 신호의 403 은 토큰 실패로 «적지 않는다» — 권한을 안 준 것이지 토큰이 죽은 게 아니다
    expect(noteGithubError).not.toHaveBeenCalled();
  });
  it('diff(listFiles) 의 403 은 필수라 throw 하고 봇 토큰 실패로 적는다', async () => {
    octokit.pulls.listFiles.mockImplementation(forbidden);
    octokit.repos.listDeployments.mockResolvedValue({ data: [] });
    octokit.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
    octokit.repos.listCommitStatusesForRef.mockResolvedValue({ data: [] });
    const { getPrReview } = await import('@/lib/auto-dev/pr-review');
    await expect(getPrReview('https://github.com/o/r', 8, { botId: 'bot-1' })).rejects.toThrow('Resource not accessible');
    expect(noteGithubError).toHaveBeenCalledWith('bot-1', 'bot', expect.objectContaining({ status: 403 }));
  });
  it('배포·체크가 «있고» 상태가 온 경우엔 unavailable 이 아니다 (Vercel 미연결 레포와 구분)', async () => {
    octokit.repos.listDeployments.mockResolvedValue({ data: [] });
    octokit.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
    octokit.repos.listCommitStatusesForRef.mockResolvedValue({ data: [] });
    const { getPrReview } = await import('@/lib/auto-dev/pr-review');
    const review = await getPrReview('https://github.com/o/r', 8, { botId: 'bot-1' });
    expect(review.build).toMatchObject({ state: 'unknown', unavailable: false });
  });
  it('부가 신호의 5xx 는 삼키지 않는다 — 「모름」이 장애를 가리면 안 된다', async () => {
    octokit.repos.listDeployments.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    octokit.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
    octokit.repos.listCommitStatusesForRef.mockResolvedValue({ data: [] });
    const { getPrReview } = await import('@/lib/auto-dev/pr-review');
    await expect(getPrReview('https://github.com/o/r', 8, { botId: 'bot-1' })).rejects.toThrow('Bad Gateway');
  });
});

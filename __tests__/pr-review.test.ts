import { describe, it, expect } from 'vitest';
import {
  summarizeBuild,
  pickPreview,
  safePreviewUrl,
  truncatePatch,
  mergeBlockedBy,
  PATCH_CHARS_MAX,
} from '@/lib/auto-dev/pr-review';

// 실측(2026-09-13, 데모 레포 PR #8·#10): 빌드는 Combined Status 의 context 'Vercel',
// 프리뷰 URL 은 배포 상태의 environment_url. Checks 엔 「Vercel Preview Comments」만 있다.

describe('summarizeBuild', () => {
  const previewComments = [{ name: 'Vercel Preview Comments', status: 'completed', conclusion: 'success' }];

  it('Vercel status with only informational checks succeeds', () => {
    const out = summarizeBuild(
      [{ context: 'Vercel', state: 'success', description: 'Deployment has completed', target_url: 'https://vercel.com/x', updated_at: '2026-09-13T06:42:59Z' }],
      previewComments,
    );
    expect(out).toEqual({
      state: 'success', failedChecks: [], description: 'Deployment has completed', targetUrl: 'https://vercel.com/x', updatedAt: '2026-09-13T06:42:59Z',
    });
  });

  it('pending → pending, failure/error → failure. 다른 봇의 success 에 가려지지 않는다', () => {
    expect(summarizeBuild([{ context: 'Vercel', state: 'pending' }, { context: 'other-bot', state: 'success' }], []).state).toBe('pending');
    expect(summarizeBuild([{ context: 'Vercel', state: 'error' }], []).state).toBe('failure');
    expect(summarizeBuild([{ context: 'Vercel – app', state: 'failure' }], []).state).toBe('failure');
  });

  it('statuses and checks both contribute (Preview Comments excluded)', () => {
    expect(summarizeBuild([{ context: 'ci/lint', state: 'success' }, { context: 'ci/test', state: 'pending' }], []).state).toBe('pending');
    expect(summarizeBuild([], [...previewComments, { name: 'build', status: 'in_progress', conclusion: null }]).state).toBe('pending');
    expect(summarizeBuild([], [...previewComments, { name: 'build', status: 'completed', conclusion: 'failure', details_url: 'u' }])).toMatchObject({ state: 'failure', targetUrl: 'u' });
    expect(summarizeBuild([], [...previewComments, { name: 'build', status: 'completed', conclusion: 'success' }]).state).toBe('success');
  });

  it.each(['failure', 'in_progress'])('Vercel success cannot hide Actions %s or another status', (result) => {
    const statuses = [{ context: 'Vercel', state: 'success' }];
    const build = summarizeBuild(statuses, [{ name: 'tests', status: result === 'failure' ? 'completed' : result, conclusion: result === 'failure' ? 'failure' : null }]);
    expect(build.state).toBe(result === 'failure' ? 'failure' : 'pending');
    expect(mergeBlockedBy({ state: 'open', merged: false, mergeable: true, build: { ...build, unavailable: false } })).toBe(result === 'failure' ? 'build_failed' : 'build_pending');
    expect(summarizeBuild([...statuses, { context: 'security', state: result === 'failure' ? 'error' : 'pending' }], []).state).toBe(build.state);
  });
  it('collects failure names and safe links across both sources', () => {
    expect(summarizeBuild([{ context: 'Vercel', state: 'failure', target_url: 'https://vercel.com/log' }, { context: 'security', state: 'error', target_url: 'javascript:x' }], [{ name: 'tests', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/log' }]).failedChecks).toEqual([
      { name: 'Vercel', url: 'https://vercel.com/log' }, { name: 'security', url: null }, { name: 'tests', url: 'https://github.com/log' },
    ]);
  });
  it('skipped only is no evidence; neutral or success with skipped is success', () => {
    const skipped = { name: 'skip', status: 'completed', conclusion: 'skipped' };
    expect(summarizeBuild([], [skipped]).state).toBe('unknown');
    for (const conclusion of ['success', 'neutral']) expect(summarizeBuild([], [skipped, { name: 'actual', status: 'completed', conclusion }]).state).toBe('success');
  });
  it.each([null, 'unexpected'])('unrecognized completed conclusion %s does not pass or use no-CI grace', (conclusion) => {
    expect(summarizeBuild([], [{ name: 'tests', status: 'completed', conclusion }]).state).toBe('pending');
  });
  it('latest status wins per context, retaining different contexts', () => {
    expect(summarizeBuild([{ context: 'ci', state: 'failure', updated_at: '2020' }, { context: 'ci', state: 'success', updated_at: '2021' }], []).state).toBe('success');
  });

  it('정보가 아예 없으면 unknown — Vercel 미연결 레포. 반영을 막지 않는 상태', () => {
    expect(summarizeBuild([], []).state).toBe('unknown');
    expect(summarizeBuild([], previewComments).state).toBe('unknown');
  });
});

describe('pickPreview', () => {
  it('최신 상태로 판정하고 URL 이 있는 것을 고른다', () => {
    const out = pickPreview([
      { state: 'pending', environment_url: null, created_at: '2026-09-13T06:40:00Z' },
      { state: 'success', environment_url: 'https://x-abc.vercel.app', created_at: '2026-09-13T06:42:59Z' },
    ]);
    expect(out).toEqual({ url: 'https://x-abc.vercel.app', state: 'ready' });
  });

  it('배포가 없으면 unknown, 진행 중이면 building, 실패면 failed', () => {
    expect(pickPreview([])).toEqual({ url: null, state: 'unknown' });
    expect(pickPreview([{ state: 'in_progress', created_at: 'a' }]).state).toBe('building');
    expect(pickPreview([{ state: 'error', created_at: 'a' }]).state).toBe('failed');
  });
});

describe('safePreviewUrl — 배포 상태는 누구나 쓸 수 있는 값이라 Vercel 도메인만 링크로', () => {
  it('vercel.app https 만 통과', () => {
    expect(safePreviewUrl('https://demo-git-fix-x.vercel.app')).toBe('https://demo-git-fix-x.vercel.app');
    expect(safePreviewUrl('http://demo.vercel.app')).toBeNull();
    expect(safePreviewUrl('https://evil.example/?vercel.app')).toBeNull();
    expect(safePreviewUrl('https://notvercel.app')).toBeNull();
    expect(safePreviewUrl('javascript:alert(1)')).toBeNull();
    expect(safePreviewUrl(null)).toBeNull();
  });
});

describe('truncatePatch', () => {
  it('상한을 넘으면 자르고 표시한다, 없으면 null', () => {
    expect(truncatePatch(undefined)).toEqual({ patch: null, truncated: false });
    expect(truncatePatch('abc')).toEqual({ patch: 'abc', truncated: false });
    const long = 'x'.repeat(PATCH_CHARS_MAX + 10);
    const out = truncatePatch(long);
    expect(out.truncated).toBe(true);
    expect(out.patch!.startsWith('x'.repeat(PATCH_CHARS_MAX))).toBe(true);
    expect(out.patch).toContain('이하 생략');
  });
});

describe('mergeBlockedBy — 화면과 라우트가 같은 판정을 본다', () => {
  const ok = { state: 'open' as const, merged: false, mergeable: true, build: { state: 'success' as const, description: null, targetUrl: null, updatedAt: null, unavailable: false } };

  it('통과·unknown 은 막지 않는다', () => {
    expect(mergeBlockedBy(ok)).toBeNull();
    expect(mergeBlockedBy({ ...ok, build: { ...ok.build, state: 'unknown' } })).toBeNull();
    // GitHub 가 아직 계산 중(null)이면 충돌로 보지 않는다
    expect(mergeBlockedBy({ ...ok, mergeable: null })).toBeNull();
  });

  it.each(['success', 'unknown'] as const)('allows human merge with %s evidence when CI is unavailable', (state) => {
    expect(mergeBlockedBy({ ...ok, build: { ...ok.build, state, unavailable: true } })).toBeNull();
  });
  it.each(['failure', 'pending'] as const)('still blocks known %s even with unavailable signals', (state) => {
    expect(mergeBlockedBy({ ...ok, build: { ...ok.build, state, unavailable: true } })).toBe(state === 'failure' ? 'build_failed' : 'build_pending');
  });

  it('실패·진행 중·충돌·이미 머지/닫힘은 막는다 (우선순위: merged > closed > build > conflict)', () => {
    expect(mergeBlockedBy({ ...ok, build: { ...ok.build, state: 'failure' } })).toBe('build_failed');
    expect(mergeBlockedBy({ ...ok, build: { ...ok.build, state: 'pending' } })).toBe('build_pending');
    expect(mergeBlockedBy({ ...ok, mergeable: false })).toBe('conflict');
    expect(mergeBlockedBy({ ...ok, state: 'closed' })).toBe('closed');
    expect(mergeBlockedBy({ ...ok, merged: true, state: 'closed' })).toBe('merged');
    expect(mergeBlockedBy({ ...ok, merged: false, state: 'closed', build: { ...ok.build, state: 'failure' } })).toBe('closed');
  });
});

describe('safeExternalUrl — 빌드 로그 링크는 https 만', () => {
  it('javascript:/data: 는 null, https 는 그대로', async () => {
    const { safeExternalUrl } = await import('@/lib/auto-dev/pr-review');
    expect(safeExternalUrl('https://vercel.com/x/y')).toBe('https://vercel.com/x/y');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('http://x')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe('canDeleteBranch — 같은 레포의 비-base 브랜치만', () => {
  it('fork 의 브랜치·base 브랜치는 지우지 않는다', async () => {
    const { canDeleteBranch } = await import('@/lib/auto-dev/pr-review');
    expect(canDeleteBranch({ headRef: 'fix/x', headRepo: 'o/r', baseRef: 'main' }, 'o/r')).toBe(true);
    expect(canDeleteBranch({ headRef: 'fix/x', headRepo: 'O/R', baseRef: 'main' }, 'o/r')).toBe(true);
    expect(canDeleteBranch({ headRef: 'fix/x', headRepo: 'fork/r', baseRef: 'main' }, 'o/r')).toBe(false);
    expect(canDeleteBranch({ headRef: 'fix/x', headRepo: null, baseRef: 'main' }, 'o/r')).toBe(false);
    expect(canDeleteBranch({ headRef: 'develop', headRepo: 'o/r', baseRef: 'develop' }, 'o/r')).toBe(false);
    expect(canDeleteBranch({ headRef: '', headRepo: 'o/r', baseRef: 'main' }, 'o/r')).toBe(false);
  });
});

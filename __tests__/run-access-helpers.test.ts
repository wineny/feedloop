import { describe, it, expect } from 'vitest';
import { commitTitleFrom, crossOriginProblem, readJsonBounded, ACTION_BODY_MAX } from '@/lib/auto-dev/run-access';

describe('commitTitleFrom — 방문자 텍스트에서 파생된 제목을 커밋 제목으로', () => {
  it('개행을 접고 72자 안에 (#N) 을 붙인다', () => {
    expect(commitTitleFrom('쿠폰함\n오류', 8)).toBe('쿠폰함 오류 (#8)');
    const long = commitTitleFrom('가'.repeat(200), 123);
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith(' (#123)')).toBe(true);
    expect(long).toContain('…');
  });
});

describe('crossOriginProblem', () => {
  const mk = (origin?: string, extra: Record<string, string> = {}) =>
    new Request('https://feedloop.test/api/x', { method: 'POST', headers: { ...(origin ? { origin } : {}), ...extra } });
  it('Origin 없음·같은 호스트·x-forwarded-host 일치는 통과', () => {
    expect(crossOriginProblem(mk())).toBeNull();
    expect(crossOriginProblem(mk('https://feedloop.test'))).toBeNull();
    expect(crossOriginProblem(mk('https://trae-kappa.vercel.app', { 'x-forwarded-host': 'trae-kappa.vercel.app' }))).toBeNull();
  });
  it('다른 호스트·깨진 Origin 은 거절', () => {
    expect(crossOriginProblem(mk('https://evil.example'))).not.toBeNull();
    expect(crossOriginProblem(mk('null'))).not.toBeNull();
  });
});

describe('readJsonBounded', () => {
  it('상한을 넘으면 413, 깨진 JSON 은 400', async () => {
    const big = new Request('https://x', { method: 'POST', body: 'x'.repeat(ACTION_BODY_MAX + 1) });
    expect(await readJsonBounded(big)).toMatchObject({ ok: false, status: 413 });
    const bad = new Request('https://x', { method: 'POST', body: '{nope' });
    expect(await readJsonBounded(bad)).toMatchObject({ ok: false, status: 400 });
    const good = new Request('https://x', { method: 'POST', body: '{"index":1}' });
    expect(await readJsonBounded(good)).toEqual({ ok: true, value: { index: 1 } });
  });
});

describe('repoUrlOfPr — PR 이 열린 레포는 pr_url 이 안다', () => {
  it('앵커된 PR URL 에서 레포를 뽑고, 아니면 null', async () => {
    const { repoUrlOfPr } = await import('@/lib/auto-dev/run-access');
    expect(repoUrlOfPr('https://github.com/wineny/nullnul-tour-demo/pull/6')).toBe('https://github.com/wineny/nullnul-tour-demo');
    expect(repoUrlOfPr('https://github.com/o/r/pull/6/')).toBe('https://github.com/o/r');
    expect(repoUrlOfPr('https://evil.example/?github.com/o/r/pull/6')).toBeNull();
    expect(repoUrlOfPr('https://github.com/o/r')).toBeNull();
    expect(repoUrlOfPr(null)).toBeNull();
  });
});

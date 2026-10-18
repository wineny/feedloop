import { describe, it, expect } from 'vitest';
import { githubPatPrefillUrl, GITHUB_PAT_URL } from '@/lib/github/pat-link';

/** 링크의 쿼리만 꺼내 본다 — 순서가 아니라 «무엇이 담겼나» 를 단언하려고 */
function q(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('githubPatPrefillUrl — 토큰 발급 폼 미리 채우기', () => {
  it('레포가 읽히면 이름·대상 계정·권한 넷을 채운다', () => {
    const url = githubPatPrefillUrl('https://github.com/wineny/nullnul-tour', '널널투어');
    expect(url.startsWith(`${GITHUB_PAT_URL}?`)).toBe(true);
    const p = q(url);
    expect(p.get('name')).toBe('Feedloop wineny/nullnul-tour');
    expect(p.get('target_name')).toBe('wineny');
    expect(p.get('expires_in')).toBe('90');
    expect(p.get('contents')).toBe('write');
    expect(p.get('pull_requests')).toBe('write');
    expect(p.get('deployments')).toBe('read');
    expect(p.get('statuses')).toBe('read');
    expect(p.get('description')).toContain('Feedloop auto PR');
    expect((p.get('description') ?? '').length).toBeLessThanOrEqual(1024);
  });

  it('레포가 없으면 서비스 이름으로 이름만 채우고 대상 계정은 추측하지 않는다', () => {
    const p = q(githubPatPrefillUrl(null, 'rona.so'));
    expect(p.get('name')).toBe('Feedloop rona.so');
    expect(p.has('target_name')).toBe(false);
    expect(p.get('contents')).toBe('write');
  });

  it('읽을 수 없는 레포 URL 은 레포가 없는 것과 같이 다룬다', () => {
    // 앵커되지 않은 URL(호스트가 github.com 이 아님) — parseRepoInfo 가 거절한다
    const p = q(githubPatPrefillUrl('https://evil.example/?x=github.com/a/b', 'rona.so'));
    expect(p.get('name')).toBe('Feedloop rona.so');
    expect(p.has('target_name')).toBe(false);
  });

  it('토큰 이름은 40자에서 자른다', () => {
    const long = 'https://github.com/gpters-ai-community/feedloop-integration-playground';
    const p = q(githubPatPrefillUrl(long, '아주 긴 서비스 이름'));
    const name = p.get('name') ?? '';
    expect(name.length).toBe(40);
    expect(name).toBe('Feedloop gpters-ai-community/feedloop-in');
    // 자르더라도 대상 계정은 온전해야 한다 — 여기가 틀리면 토큰이 레포에 안 닿는다
    expect(p.get('target_name')).toBe('gpters-ai-community');
  });

  it('조직 레포는 조직을 대상 계정으로, 값은 인코딩돼 실린다', () => {
    const url = githubPatPrefillUrl('https://github.com/my-org/repo.name', 'My Service & Co');
    expect(url).toContain('target_name=my-org');
    // 공백·&(서비스 이름 경로)와 / 가 원문 그대로 새지 않는다
    expect(url).not.toContain(' ');
    expect(q(url).get('name')).toBe('Feedloop my-org/repo.name');
    expect(q(githubPatPrefillUrl(null, 'My Service & Co')).get('name')).toBe('Feedloop My Service & Co');
  });
});

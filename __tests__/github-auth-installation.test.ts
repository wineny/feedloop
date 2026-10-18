import { describe, it, expect, vi, beforeEach } from 'vitest';

// src/lib/auto-dev/github-auth.ts — NEW 우선순위: 설치(GitHub App) → 봇 토큰(PAT) → 플랫폼 (B5 안 B).
// 기존 __tests__/github-auth.test.ts(봇 토큰 vs 플랫폼)는 그대로 두고, 설치 분기만 여기서 본다.

const { maybeSingle } = vi.hoisted(() => ({ maybeSingle: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.update = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.not = vi.fn(() => chain);
      chain.maybeSingle = maybeSingle;
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

const octokitCalls: { auth?: string; authStrategy?: unknown; installationId?: number }[] = [];
vi.mock('@octokit/rest', () => ({
  Octokit: function (opts: { auth?: string; authStrategy?: unknown; auth_?: never }) {
    const withAuthObj = opts as { auth?: unknown; authStrategy?: unknown };
    const installationId =
      typeof withAuthObj.auth === 'object' && withAuthObj.auth !== null
        ? (withAuthObj.auth as { installationId?: number }).installationId
        : undefined;
    octokitCalls.push({
      auth: typeof withAuthObj.auth === 'string' ? withAuthObj.auth : undefined,
      authStrategy: withAuthObj.authStrategy,
      installationId,
    });
    return { opts };
  },
}));

const APP_ENV = {
  GITHUB_APP_ID: '999',
  GITHUB_APP_SLUG: 'feedloop-app',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  GITHUB_APP_CLIENT_ID: 'client-id',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
};

const BOT_TOKEN_ROW = { github_token_encrypted: null, github_installation_id: 42, github_installation_login: 'wineny', github_installation_lost_at: null };

let mod: typeof import('@/lib/auto-dev/github-auth');

beforeEach(async () => {
  vi.clearAllMocks();
  octokitCalls.length = 0;
  process.env.BOT_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  process.env.GITHUB_TOKEN = 'ghp_platform000000000000000000000000';
  for (const k of Object.keys(APP_ENV)) delete process.env[k];
  vi.resetModules();
  mod = await import('@/lib/auto-dev/github-auth');
});

function withAppEnv() {
  Object.assign(process.env, APP_ENV);
}

describe('octokitForBot — 설치 우선', () => {
  it('설치 id 가 있고 앱 env 가 있으면 installation 소스로, authStrategy+installationId 를 넘긴다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('installation');
    expect(octokitCalls).toHaveLength(1);
    expect(octokitCalls[0].authStrategy).toBeTruthy();
    expect(octokitCalls[0].installationId).toBe(42);
  });
  it('github_installation_lost_at 이 찍혀 있으면 설치를 건너뛰고 봇 토큰/플랫폼으로', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: { ...BOT_TOKEN_ROW, github_installation_lost_at: '2026-09-13T00:00:00Z' }, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('platform');
    expect(octokitCalls[0].authStrategy).toBeUndefined();
  });
  it('repoUrl 의 소유자가 설치 계정과 다르면 설치를 건너뛴다(대소문자 무시는 유지)', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: 'https://github.com/other-owner/repo' });
    expect(source).toBe('platform');
  });
  it('repoUrl 소유자가 설치 계정과 대소문자만 다르면 설치를 그대로 쓴다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: 'https://github.com/WineNy/repo' });
    expect(source).toBe('installation');
  });
  it('repoUrl 을 안 주면(호출부가 모름) 설치를 우선한다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('installation');
  });
  it('앱 env 가 없으면(미설정) 설치 id 가 있어도 봇 토큰/플랫폼으로 흐른다 + console.error 로 남긴다', async () => {
    // withAppEnv() 를 호출하지 않음 — env 없음
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('platform');
    expect(err).toHaveBeenCalledWith('[github-auth] installation recorded but GitHub App env missing', expect.objectContaining({ botId: 'bot-1', installationId: 42 }));
  });
  it('설치 id 가 없으면(일반 PAT 봇) 예전과 같이 봇 토큰/플랫폼', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: { ...BOT_TOKEN_ROW, github_installation_id: null }, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('platform');
  });
  it('installation_login 이 비어 있으면(레거시 행) repoUrl 을 줘도 설치를 건너뛴다(fail-closed)', async () => {
    // 리뷰 반영: repoUrl 이 명시적으로 주어졌는데 어느 계정에 설치됐는지 모르면(login 없음)
    // «같다»로 관대하게 보지 않고 봇 토큰/플랫폼으로 내려간다.
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: { ...BOT_TOKEN_ROW, github_installation_login: null }, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: 'https://github.com/anyone/repo' });
    expect(source).toBe('platform');
    expect(octokitCalls[0].authStrategy).toBeUndefined();
  });
  it('repoUrl 이 빈 문자열이면(명시적으로 없음) 설치를 건너뛴다(fail-closed)', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: '' });
    expect(source).toBe('platform');
  });
  it('repoUrl 이 null 이면(명시적으로 없음) 설치를 건너뛴다(fail-closed) — undefined(안 줌)와 다르다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: null });
    expect(source).toBe('platform');
  });
  it('repoUrl 이 파싱 안 되는 값이면(못 읽음) 설치를 건너뛴다(fail-closed) — «같다»로 관대하게 보지 않는다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: BOT_TOKEN_ROW, error: null });
    const { source } = await mod.octokitForBot('bot-1', { repoUrl: 'not-a-github-url' });
    expect(source).toBe('platform');
    expect(octokitCalls[0].authStrategy).toBeUndefined();
  });
  it('설치 id 가 문자열로 와도(DB numeric 타입) 숫자로 해석한다', async () => {
    withAppEnv();
    maybeSingle.mockResolvedValue({ data: { ...BOT_TOKEN_ROW, github_installation_id: '42' }, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('installation');
    expect(octokitCalls[0].installationId).toBe(42);
  });
});

describe('noteGithubError / clearGithubFailureIfAny — installation 소스는 DB 에 안 적는다', () => {
  it('설치 경로의 401/403 은 console.warn 만, DB 는 안 건드린다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mod.noteGithubError('bot-1', 'installation', { status: 403 });
    expect(warn).toHaveBeenCalledWith('[github-auth] installation call rejected', expect.objectContaining({ botId: 'bot-1', status: 403 }));
  });
  it('설치 경로의 5xx·기타 상태는 warn 도 안 한다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mod.noteGithubError('bot-1', 'installation', { status: 502 });
    expect(warn).not.toHaveBeenCalled();
  });
  it('clearGithubFailureIfAny 는 installation 소스에서 아무것도 안 한다', async () => {
    await expect(mod.clearGithubFailureIfAny('bot-1', 'installation')).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// src/app/api/bots/[id]/github-app/route.ts — 「Feedloop 앱 설치」 상태 GET/POST(설치 확인)/DELETE (안 B).

const { resolveOwnedBots } = vi.hoisted(() => ({ resolveOwnedBots: vi.fn() }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));

const { singleMock, updateMock, updateEqMock } = vi.hoisted(() => ({
  singleMock: vi.fn(),
  updateMock: vi.fn(),
  updateEqMock: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = singleMock;
      chain.update = vi.fn((p: Record<string, unknown>) => {
        updateMock(p);
        return { eq: (col: string, v: unknown) => { updateEqMock(col, v); return Promise.resolve({ error: null }); } };
      });
      return chain;
    },
  }),
}));

const {
  githubAppBotLogin,
  githubAppAuthorizeUrl,
  githubAppInstallUrl,
  githubInstallationManageUrl,
  installationLostMessage,
  readGithubAppConfig,
} = vi.hoisted(() => ({
  githubAppBotLogin: vi.fn((slug: string) => `${slug}[bot]`),
  githubAppInstallUrl: vi.fn((slug: string, state?: string | null) => `https://github.com/apps/${slug}/installations/new${state ? `?state=${state}` : ''}`),
  githubAppAuthorizeUrl: vi.fn((cfg: { clientId: string }, state?: string | null) => `https://github.com/login/oauth/authorize?client_id=${cfg.clientId}${state ? `&state=${state}` : ''}`),
  githubInstallationManageUrl: vi.fn((id: number) => `https://github.com/settings/installations/${id}`),
  installationLostMessage: vi.fn(() => '연결을 확인해 주세요'),
  readGithubAppConfig: vi.fn(),
}));
vi.mock('@/lib/github/app', () => ({
  githubAppBotLogin,
  githubAppAuthorizeUrl,
  githubAppInstallUrl,
  githubInstallationManageUrl,
  installationLostMessage,
  readGithubAppConfig,
}));

const { installStateSecret, signInstallState } = vi.hoisted(() => ({
  installStateSecret: vi.fn((): string | null => 'secret'),
  signInstallState: vi.fn(() => 'signed-state-token'),
}));
vi.mock('@/lib/github/install-state', () => ({ installStateSecret, signInstallState }));

const { recheckInstallation } = vi.hoisted(() => ({ recheckInstallation: vi.fn() }));
vi.mock('@/lib/github/installation-binding', () => ({ recheckInstallation }));

const BOT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CONFIGURED = { appId: '1', privateKey: 'k', slug: 'feedloop-app', clientId: 'c', clientSecret: 'cs', webhookSecret: 's' };
const ROW = {
  id: BOT_ID,
  github_repo_url: 'https://github.com/o/r',
  github_installation_id: 42,
  github_installation_login: 'wineny',
  github_installation_connected_at: '2026-09-13T00:00:00Z',
  github_installation_lost_at: null,
  github_installation_lost_reason: null,
  github_installation_by: 'ny',
  github_token_last4: null,
};

async function route() {
  return import('@/app/api/bots/[id]/github-app/route');
}
function req(method: string) {
  return new Request(`https://feedloop.test/api/bots/${BOT_ID}/github-app`, { method });
}
const params = { params: Promise.resolve({ id: BOT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'user-1', botIds: [BOT_ID] });
  singleMock.mockResolvedValue({ data: ROW, error: null });
  readGithubAppConfig.mockReturnValue(CONFIGURED);
  installStateSecret.mockReturnValue('secret');
  signInstallState.mockReturnValue('signed-state-token');
});

describe('GET', () => {
  it('무인증 401', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const r = await route();
    expect((await r.GET(req('GET'), params)).status).toBe(401);
  });
  it('남의 봇 403', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: 'no' });
    const r = await route();
    expect((await r.GET(req('GET'), params)).status).toBe(403);
  });
  it('설치돼 있으면 installed:true 와 계정·시각·매니지 URL을 돌려준다', async () => {
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body).toMatchObject({
      configured: true,
      botLogin: 'feedloop-app[bot]',
      installed: true,
      installationId: 42,
      installationLogin: 'wineny',
      connectedBy: 'ny',
      manageUrl: 'https://github.com/settings/installations/42',
      installUrl: expect.stringContaining('state=signed-state-token'),
      // 계정에 앱이 이미 있으면 installUrl 은 GitHub 설정 화면으로 새어 나가 콜백이 오지 않는다.
      // 그때 화면이 쓰는 «인가만 다시 받는» 주소가 함께 나가야 한다
      authorizeUrl: expect.stringContaining('login/oauth/authorize'),
      hasToken: false,
    });
  });
  it('lost_at 이 찍혀 있으면 installed:false + lostMessage 가 실린다', async () => {
    singleMock.mockResolvedValue({ data: { ...ROW, github_installation_lost_at: '2026-09-13T01:00:00Z', github_installation_lost_reason: 'suspended' }, error: null });
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body.installed).toBe(false);
    expect(body.lostMessage).toBe('연결을 확인해 주세요');
    expect(installationLostMessage).toHaveBeenCalledWith('suspended', 'en');
  });
  it('앱이 미설정이면 configured:false, installUrl/botLogin 은 null', async () => {
    readGithubAppConfig.mockReturnValue(null);
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body).toMatchObject({ configured: false, botLogin: null, installUrl: null, authorizeUrl: null });
  });
  it('설치 id 가 없으면 installed:false, manageUrl 은 null', async () => {
    singleMock.mockResolvedValue({ data: { ...ROW, github_installation_id: null }, error: null });
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body).toMatchObject({ installed: false, manageUrl: null });
  });
  it('설치 시크릿이 없으면(NEXTAUTH_SECRET 미설정) installUrl 에 state 없이 나간다', async () => {
    installStateSecret.mockReturnValue(null);
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body.installUrl).not.toContain('state=');
  });
  it('토큰(PAT)도 등록돼 있으면 hasToken:true', async () => {
    singleMock.mockResolvedValue({ data: { ...ROW, github_token_last4: 'abcd' }, error: null });
    const r = await route();
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body.hasToken).toBe(true);
  });
  it('봇을 못 찾으면 404', async () => {
    singleMock.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const r = await route();
    expect((await r.GET(req('GET'), params)).status).toBe(404);
  });
});

describe('POST (설치 확인)', () => {
  it('무인증 401, 남의 봇 403', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const r = await route();
    expect((await r.POST(req('POST'), params)).status).toBe(401);
  });
  it('앱이 미설정이면 503', async () => {
    readGithubAppConfig.mockReturnValue(null);
    const r = await route();
    expect((await r.POST(req('POST'), params)).status).toBe(503);
    expect(recheckInstallation).not.toHaveBeenCalled();
  });
  it('정상 확인이면 recheckInstallation 결과의 kind 를 recheck 필드로 돌려준다', async () => {
    recheckInstallation.mockResolvedValue({ kind: 'ok', installation: { id: 42, login: 'wineny', suspended: false, repositorySelection: 'all' } });
    const r = await route();
    const res = await r.POST(req('POST'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).recheck).toBe('ok');
  });
  it('recheckInstallation 이 throw 하면 502', async () => {
    recheckInstallation.mockRejectedValue(new Error('github down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await route();
    const res = await r.POST(req('POST'), params);
    expect(res.status).toBe(502);
    expect(err).toHaveBeenCalled();
  });
  it('분당 10회를 넘기면 429 — GitHub 을 더 안 부른다', async () => {
    recheckInstallation.mockResolvedValue({ kind: 'ok', installation: { id: 42, login: 'wineny', suspended: false, repositorySelection: 'all' } });
    resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'rate-user-1', botIds: [BOT_ID] });
    const r = await route();
    for (let i = 0; i < 10; i++) expect((await r.POST(req('POST'), params)).status).toBe(200);
    const blocked = await r.POST(req('POST'), params);
    expect(blocked.status).toBe(429);
    expect(recheckInstallation).toHaveBeenCalledTimes(10);
  });
  it('사용자별로 상한이 따로 간다', async () => {
    recheckInstallation.mockResolvedValue({ kind: 'ok', installation: { id: 42, login: 'wineny', suspended: false, repositorySelection: 'all' } });
    resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'rate-user-2', botIds: [BOT_ID] });
    const r = await route();
    for (let i = 0; i < 10; i++) await r.POST(req('POST'), params);
    resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'rate-user-3', botIds: [BOT_ID] });
    expect((await r.POST(req('POST'), params)).status).toBe(200);
  });
});

describe('DELETE', () => {
  it('무인증 401', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const r = await route();
    expect((await r.DELETE(req('DELETE'), params)).status).toBe(401);
  });
  it('설치 관련 7개 컬럼을 전부 비운다', async () => {
    const r = await route();
    const res = await r.DELETE(req('DELETE'), params);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      github_installation_id: null,
      github_installation_login: null,
      github_installation_connected_at: null,
      github_installation_repo_selection: null,
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_by: null,
    });
    expect(updateEqMock).toHaveBeenCalledWith('id', BOT_ID);
  });
  it('DELETE 뒤에 갱신된 상태를 다시 읽어 돌려준다(응답이 installed:false)', async () => {
    singleMock.mockResolvedValue({ data: { ...ROW, github_installation_id: null, github_installation_login: null }, error: null });
    const r = await route();
    const body = await (await r.DELETE(req('DELETE'), params)).json();
    expect(body.installed).toBe(false);
  });
});

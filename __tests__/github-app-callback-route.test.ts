import { describe, it, expect, vi, beforeEach } from 'vitest';

// src/app/api/github/app/callback/route.ts — 설치 콜백 (안 B).
// 세션 → **서명된 state 가 필수**(없으면 need_state, 아무것도 안 묶는다) → 그 state 가 가리키는
// 딱 한 봇만 조회(.eq('id',botId).eq('user_id',userId)) → code 교환(유저 토큰) → bindInstallation.
// «세션 유저의 봇 전부를 후보로 본다»던 예전 관대한 폴백은 보안 리뷰(M1·M2 — 동료의 설치에 조용히 묶이는
// 문제 + 쿠키 인증 GET 의 CSRF)로 제거됐다. 유저 토큰이 리다이렉트 URL·로그에 절대 안 나가야 한다.

const { getServerSession } = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));

const { readGithubAppConfig, exchangeUserCode } = vi.hoisted(() => ({
  readGithubAppConfig: vi.fn(),
  exchangeUserCode: vi.fn(),
}));
vi.mock('@/lib/github/app', () => ({ readGithubAppConfig, exchangeUserCode }));

const { installStateSecret, verifyInstallState } = vi.hoisted(() => ({
  installStateSecret: vi.fn(() => 'secret'),
  verifyInstallState: vi.fn((): { botId: string; userId: string } | null => null),
}));
vi.mock('@/lib/github/install-state', () => ({ installStateSecret, verifyInstallState }));

const { bindInstallation } = vi.hoisted(() => ({ bindInstallation: vi.fn() }));
vi.mock('@/lib/github/installation-binding', () => ({ bindInstallation }));

const { selectMock, eqMock, maybeSingleMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => ({
      select: (cols: string) => {
        selectMock(cols);
        const chain = {
          eq: (col: string, v: unknown) => {
            eqMock(col, v);
            return chain;
          },
          maybeSingle: () => maybeSingleMock(),
        };
        return chain;
      },
    }),
  }),
}));

const CONFIGURED = { appId: '1', privateKey: 'k', slug: 'feedloop-app', clientId: 'c', clientSecret: 'cs', webhookSecret: 's' };
const USER = { token: 'ghu_secret_user_token_abc123', login: 'wineny' };
const DEFAULT_BOT = { id: 'bot-1', github_repo_url: 'https://github.com/o/r' };

// 세션·서명 mock 은 매 테스트 유일한 userId 를 쓴다 — 라우트가 인메모리 Map(callbackHits)으로 분당 상한을
// 재는데, 그 Map 은 모듈이 리셋되지 않는 한 테스트 파일 전체에서 살아 있다. 유저를 공유하면 먼저 도는
// 테스트들의 호출이 뒤 테스트의 상한을 갉아먹어(분당 10회) busy 로 새는 사고가 난다 — 분당 상한 테스트만
// 일부러 하나의 userId 로 11번을 부른다.
let currentUserId = '';
let userCounter = 0;

function req(query: Record<string, string> = {}) {
  const url = new URL('https://feedloop.test/api/github/app/callback');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url.toString());
}
async function route() {
  return import('@/app/api/github/app/callback/route');
}

function redirectPath(res: Response): string {
  return new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search;
}

beforeEach(() => {
  vi.clearAllMocks();
  userCounter += 1;
  currentUserId = `user-${userCounter}`;
  getServerSession.mockResolvedValue({ user: { id: currentUserId } });
  readGithubAppConfig.mockReturnValue(CONFIGURED);
  installStateSecret.mockReturnValue('secret');
  verifyInstallState.mockReturnValue(null);
  exchangeUserCode.mockResolvedValue(USER);
  bindInstallation.mockResolvedValue({ kind: 'bound', installation: { id: 1, login: 'wineny', suspended: false, repositorySelection: 'all' } });
  maybeSingleMock.mockResolvedValue({ data: DEFAULT_BOT, error: null });
});

describe('GET /api/github/app/callback', () => {
  it('세션이 없으면 로그인 화면으로, callbackUrl 에 원래 요청을 담는다', async () => {
    getServerSession.mockResolvedValue(null);
    const r = await route();
    const res = await r.GET(req({ code: 'abc' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/api/auth/signin?callbackUrl=');
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('분당 10회를 넘긴 11번째 콜백은 busy — config·state 확인보다 먼저 걸린다', async () => {
    const uid = 'rate-limited-user';
    getServerSession.mockResolvedValue({ user: { id: uid } });
    const r = await route();
    for (let i = 0; i < 10; i++) {
      const res = await r.GET(req({}));
      expect(redirectPath(res)).not.toBe('/bots?app=busy');
    }
    const blocked = await r.GET(req({}));
    expect(redirectPath(blocked)).toBe('/bots?app=busy');
  });

  it('앱이 미설정이면 /bots?app=unconfigured', async () => {
    readGithubAppConfig.mockReturnValue(null);
    const r = await route();
    const res = await r.GET(req({}));
    expect(redirectPath(res)).toBe('/bots?app=unconfigured');
  });

  it('state 가 없으면(서명 검증 실패·미제출 포함) need_state — DB 조회·code 교환·bindInstallation 전부 안 한다', async () => {
    const r = await route();
    const res = await r.GET(req({ code: 'abc' }));
    expect(redirectPath(res)).toBe('/bots?app=need_state');
    expect(selectMock).not.toHaveBeenCalled();
    expect(exchangeUserCode).not.toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('setup_action=request 인데 state 가 없으면 그래도 need_state — request 분기보다 state 확인이 먼저다', async () => {
    const r = await route();
    const res = await r.GET(req({ setup_action: 'request' }));
    expect(redirectPath(res)).toBe('/bots?app=need_state');
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('setup_action=request 이고 state 가 유효하면 그 봇 화면으로 — DB 조회·code 교환도 안 한다(묶을 게 없다)', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-9', userId: currentUserId });
    const r = await route();
    const res = await r.GET(req({ setup_action: 'request', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-9/knowledge?tab=github&app=requested');
    expect(selectMock).not.toHaveBeenCalled();
    expect(exchangeUserCode).not.toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('state 가 다른 유저의 것이면 need_state — «세션 유저의 봇 전부를 후보로」 폴백은 없다(보안 리뷰 M1·M2)', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-9', userId: 'someone-else' });
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots?app=need_state');
    expect(selectMock).not.toHaveBeenCalled();
    expect(exchangeUserCode).not.toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('state 는 유효한데 그 봇이 더는 이 유저 것이 아니면(양도·삭제) no_bot — bindInstallation 은 절대 안 부른다', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots?app=no_bot');
    expect(eqMock).toHaveBeenCalledWith('id', 'bot-1');
    expect(eqMock).toHaveBeenCalledWith('user_id', currentUserId);
    expect(exchangeUserCode).not.toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('code 가 없으면(설치만 하고 콜백에 code 가 안 실린 경우) no_code — 그 봇 화면으로', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    const r = await route();
    const res = await r.GET(req({ state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-1/knowledge?tab=github&app=no_code');
    expect(exchangeUserCode).not.toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('code 교환이 실패하면 auth_failed', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    exchangeUserCode.mockResolvedValue(null);
    const r = await route();
    const res = await r.GET(req({ code: 'bad', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-1/knowledge?tab=github&app=auth_failed');
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('정상 흐름 — state 가 가리키는 봇 하나만 조회해서 bound', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-1/knowledge?tab=github&app=bound');
    expect(selectMock).toHaveBeenCalledWith('id, github_repo_url');
    expect(exchangeUserCode).toHaveBeenCalledWith(CONFIGURED, 'abc');
    expect(bindInstallation).toHaveBeenCalledTimes(1);
    expect(bindInstallation).toHaveBeenCalledWith(CONFIGURED, { botId: 'bot-1', repoUrl: 'https://github.com/o/r' }, USER.token, USER.login);
  });

  it('bindInstallation 이 던지면 error — 예전처럼 unknown_push 로 뭉뚱그리지 않는다', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bindInstallation.mockRejectedValue(new Error('db down'));
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-1/knowledge?tab=github&app=error');
    expect(err).toHaveBeenCalled();
  });

  it('유저 토큰이 리다이렉트 URL 이나 console 출력 어디에도 안 나간다(정상 bound 경로 전체를 거친다)', async () => {
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots/bot-1/knowledge?tab=github&app=bound');
    expect(res.headers.get('location')).not.toContain(USER.token);
    const allLogged = [...log.mock.calls, ...err.mock.calls].map((c) => JSON.stringify(c)).join('\n');
    expect(allLogged).not.toContain(USER.token);
    expect(allLogged).not.toContain('ghu_');
  });

  it('DB 조회가 실패하면 /bots?app=error(봇을 특정하지 않는다)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    verifyInstallState.mockReturnValue({ botId: 'bot-1', userId: currentUserId });
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'down' } });
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots?app=error');
    expect(errSpy).toHaveBeenCalled();
    expect(bindInstallation).not.toHaveBeenCalled();
  });

  it('DB 조회 실패는 state 힌트가 있어도 그 봇 화면이 아니라 항상 /bots?app=error 로 간다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    verifyInstallState.mockReturnValue({ botId: 'bot-9', userId: currentUserId });
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'down' } });
    const r = await route();
    const res = await r.GET(req({ code: 'abc', state: 'sig' }));
    expect(redirectPath(res)).toBe('/bots?app=error');
  });
});

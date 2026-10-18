import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  normalizePem,
  readGithubAppConfig,
  isGithubAppConfigured,
  githubAppAuthorizeUrl,
  githubAppInstallUrl,
  githubInstallationManageUrl,
  githubAppBotLogin,
  findInstallationForRepo,
  exchangeUserCode,
  userCanPush,
  verifyWebhookSignature,
  installationLostMessage,
} from '@/lib/github/app';

// src/lib/github/app.ts — GitHub App 자격·설치 판정·웹훅 서명 (B5 안 B).

const ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_WEBHOOK_SECRET'];
const FULL_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_SLUG: 'feedloop-app',
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  GITHUB_APP_CLIENT_ID: 'client-id',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITHUB_APP_WEBHOOK_SECRET: 'whsecret',
};

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizePem', () => {
  it('BEGIN 마커가 그대로 있으면 리터럴 \\n 만 개행으로 바꾼다', () => {
    const raw = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
    expect(normalizePem(raw)).toBe('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----');
  });
  it('진짜 개행이 이미 있으면 그대로 둔다(trim 만)', () => {
    const raw = '  -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----  ';
    expect(normalizePem(raw)).toBe('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----');
  });
  it('base64 로 감싼 값을 디코드해 PEM 을 꺼낸다', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    const b64 = Buffer.from(pem, 'utf8').toString('base64');
    expect(normalizePem(b64)).toBe(pem);
  });
  it('BEGIN 마커도 없고 base64 디코드도 PEM 이 아니면 원문을 그대로 돌려준다', () => {
    expect(normalizePem('not-a-pem-at-all')).toBe('not-a-pem-at-all');
  });
  it('base64 디코드가 깨지는 값도 예외 없이 원문을 돌려준다', () => {
    expect(normalizePem('!!!not-base64!!!')).toBe('!!!not-base64!!!');
  });
});

describe('readGithubAppConfig / isGithubAppConfigured', () => {
  it('5개 필수값이 다 있으면 설정을 돌려주고 webhookSecret 도 실린다', () => {
    const cfg = readGithubAppConfig(FULL_ENV as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      appId: '12345',
      slug: 'feedloop-app',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      webhookSecret: 'whsecret',
    });
    expect(cfg?.privateKey).toContain('-----BEGIN');
    expect(isGithubAppConfigured(FULL_ENV as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it('webhookSecret 이 없으면 null (설정 자체는 유효)', () => {
    const env = { ...FULL_ENV, GITHUB_APP_WEBHOOK_SECRET: undefined };
    const cfg = readGithubAppConfig(env as unknown as NodeJS.ProcessEnv);
    expect(cfg?.webhookSecret).toBeNull();
  });
  it.each(['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'])(
    '%s 가 빠지면 null — 기능이 꺼진 것이지 오류가 아니다',
    (missingKey) => {
      const env = { ...FULL_ENV, [missingKey]: undefined };
      expect(readGithubAppConfig(env as unknown as NodeJS.ProcessEnv)).toBeNull();
      expect(isGithubAppConfigured(env as unknown as NodeJS.ProcessEnv)).toBe(false);
    },
  );
  it('공백뿐인 값은 없는 것으로 본다', () => {
    const env = { ...FULL_ENV, GITHUB_APP_ID: '   ' };
    expect(readGithubAppConfig(env as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('URL·이름 헬퍼', () => {
  it('githubAppInstallUrl — state 없으면 쿼리 없이, 있으면 인코딩해서 붙인다', () => {
    expect(githubAppInstallUrl('feedloop-app')).toBe('https://github.com/apps/feedloop-app/installations/new');
    expect(githubAppInstallUrl('feedloop-app', 'abc.def')).toBe('https://github.com/apps/feedloop-app/installations/new?state=abc.def');
    expect(githubAppInstallUrl('feedloop-app', 'a+b/c')).toContain(encodeURIComponent('a+b/c'));
  });
  it('githubAppInstallUrl — slug 도 인코딩한다', () => {
    expect(githubAppInstallUrl('a b')).toBe(`https://github.com/apps/${encodeURIComponent('a b')}/installations/new`);
  });
  it('githubAppAuthorizeUrl — client_id 와 state 만 싣는다 (redirect_uri 는 앱 등록값을 쓴다)', () => {
    const cfg = { appId: '1', privateKey: 'k', slug: 'feedloop-app', clientId: 'Iv23liXYZ', clientSecret: 'sec', webhookSecret: null };
    const url = new URL(githubAppAuthorizeUrl(cfg, 'abc.def'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv23liXYZ');
    expect(url.searchParams.get('state')).toBe('abc.def');
    // redirect_uri 를 실으면 로컬·프로덕션 앱이 서로의 주소로 돌아갈 수 있다 — 앱에 등록된 콜백만 쓴다
    expect(url.searchParams.get('redirect_uri')).toBeNull();
    // 시크릿은 URL 에 절대 실리지 않는다 (사용자 브라우저로 나가는 주소다)
    expect(url.search).not.toContain('sec');
  });
  it('githubAppAuthorizeUrl — state 가 없으면 붙이지 않는다', () => {
    const cfg = { appId: '1', privateKey: 'k', slug: 's', clientId: 'cid', clientSecret: 'sec', webhookSecret: null };
    expect(githubAppAuthorizeUrl(cfg)).toBe('https://github.com/login/oauth/authorize?client_id=cid');
    expect(githubAppAuthorizeUrl(cfg, null)).toBe('https://github.com/login/oauth/authorize?client_id=cid');
  });
  it('githubInstallationManageUrl', () => {
    expect(githubInstallationManageUrl(987)).toBe('https://github.com/settings/installations/987');
  });
  it('githubAppBotLogin', () => {
    expect(githubAppBotLogin('feedloop-app')).toBe('feedloop-app[bot]');
  });
});

describe('findInstallationForRepo', () => {
  const config = readGithubAppConfig(FULL_ENV as unknown as NodeJS.ProcessEnv)!;
  function fakeOctokit(impl: () => Promise<unknown>) {
    return { apps: { getRepoInstallation: vi.fn(impl) } } as never;
  }
  it('설치가 있으면 id·login·suspended·repositorySelection 을 돌려준다', async () => {
    const octokit = fakeOctokit(async () => ({
      data: { id: 42, account: { login: 'wineny' }, suspended_at: null, repository_selection: 'selected' },
    }));
    const result = await findInstallationForRepo(config, 'wineny', 'nullnul-tour', octokit);
    expect(result).toEqual({ id: 42, login: 'wineny', suspended: false, repositorySelection: 'selected' });
  });
  it('suspended_at 이 있으면 suspended:true', async () => {
    const octokit = fakeOctokit(async () => ({
      data: { id: 42, account: { login: 'wineny' }, suspended_at: '2026-09-13T00:00:00Z', repository_selection: 'all' },
    }));
    const result = await findInstallationForRepo(config, 'wineny', 'r', octokit);
    expect(result?.suspended).toBe(true);
  });
  it('account 가 없으면 login 은 빈 문자열', async () => {
    const octokit = fakeOctokit(async () => ({ data: { id: 1, account: null, suspended_at: null, repository_selection: null } }));
    const result = await findInstallationForRepo(config, 'o', 'r', octokit);
    expect(result?.login).toBe('');
    expect(result?.repositorySelection).toBeNull();
  });
  it('알 수 없는 repository_selection 값은 null 로 접힌다', async () => {
    const octokit = fakeOctokit(async () => ({ data: { id: 1, account: { login: 'x' }, suspended_at: null, repository_selection: 'weird' } }));
    const result = await findInstallationForRepo(config, 'o', 'r', octokit);
    expect(result?.repositorySelection).toBeNull();
  });
  it('404 는 null — 설치 안 됨', async () => {
    const octokit = fakeOctokit(() => Promise.reject(Object.assign(new Error('not found'), { status: 404 })));
    expect(await findInstallationForRepo(config, 'o', 'r', octokit)).toBeNull();
  });
  it('그 외 실패는 throw — 「설치 안 됨」과 「못 물어봄」을 섞지 않는다', async () => {
    const octokit = fakeOctokit(() => Promise.reject(Object.assign(new Error('rate limited'), { status: 403 })));
    await expect(findInstallationForRepo(config, 'o', 'r', octokit)).rejects.toThrow('rate limited');
  });
});

describe('exchangeUserCode', () => {
  const config = readGithubAppConfig(FULL_ENV as unknown as NodeJS.ProcessEnv)!;
  it('교환 성공 + 로그인 조회 성공 — token·login 을 돌려준다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_abc' }), { status: 200 });
      if (url.includes('api.github.com/user')) return new Response(JSON.stringify({ login: 'wineny' }), { status: 200 });
      throw new Error('unexpected url ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await exchangeUserCode(config, 'code123');
    expect(result).toEqual({ token: 'ghu_abc', login: 'wineny' });
    // 시크릿·code 가 바깥 어디로도 안 나가고 GitHub 요청 본문에만 실린다
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'client-id', client_secret: 'client-secret', code: 'code123' });
  });
  it('GitHub 이 거부하면(200 아님 또는 access_token 없음) null, 원문 에러는 로그에만', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 400 })));
    expect(await exchangeUserCode(config, 'bad-code')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
  it('access_token 이 없는 200 응답도 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    expect(await exchangeUserCode(config, 'code')).toBeNull();
  });
  it('네트워크 실패면 null (throw 하지 않는다)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await exchangeUserCode(config, 'code')).toBeNull();
    expect(err).toHaveBeenCalled();
  });
  it('토큰 교환은 성공했지만 유저 조회가 실패하면 login:null 로 성공 처리(토큰은 있으니 버리지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_abc' }), { status: 200 });
      return new Response('', { status: 500 });
    }));
    expect(await exchangeUserCode(config, 'code')).toEqual({ token: 'ghu_abc', login: null });
  });
});

describe('userCanPush', () => {
  it('permissions.push === true 면 true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })));
    expect(await userCanPush('ghu_abc', 'o', 'r')).toBe(true);
  });
  it('permissions.push 가 false·없음이면 false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 })));
    expect(await userCanPush('ghu_abc', 'o', 'r')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    expect(await userCanPush('ghu_abc', 'o', 'r')).toBe(false);
  });
  it('404·401·403 은 false(존재를 숨긴다) — «모름» 이 아니다', async () => {
    for (const status of [404, 401, 403]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
      expect(await userCanPush('ghu_abc', 'o', 'r')).toBe(false);
    }
  });
  it('5xx·네트워크 실패는 null — 「모름」으로 호출부가 다시 시도하게', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await userCanPush('ghu_abc', 'o', 'r')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await userCanPush('ghu_abc', 'o', 'r')).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsecret';
  const body = JSON.stringify({ action: 'deleted', installation: { id: 1 } });
  function sigFor(s: string, b: string) {
    return 'sha256=' + createHmac('sha256', s).update(b, 'utf8').digest('hex');
  }
  it('올바른 서명은 true', () => {
    expect(verifyWebhookSignature(secret, body, sigFor(secret, body))).toBe(true);
  });
  it('시크릿이 없으면 항상 false — 서명이 맞아도', () => {
    expect(verifyWebhookSignature(null, body, sigFor(secret, body))).toBe(false);
    expect(verifyWebhookSignature(undefined, body, sigFor(secret, body))).toBe(false);
    expect(verifyWebhookSignature('', body, sigFor(secret, body))).toBe(false);
  });
  it('헤더가 없으면 false', () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
  });
  it('바디가 조금이라도 다르면 false', () => {
    expect(verifyWebhookSignature(secret, body + 'x', sigFor(secret, body))).toBe(false);
  });
  it('다른 시크릿으로 만든 서명은 false', () => {
    expect(verifyWebhookSignature(secret, body, sigFor('wrong-secret', body))).toBe(false);
  });
  it('길이가 다른 헤더(변조 흔적)도 예외 없이 false', () => {
    expect(verifyWebhookSignature(secret, body, 'sha256=deadbeef')).toBe(false);
  });
});

describe('installationLostMessage', () => {
  it('고정 사유 4종에 맞는 안내 문구를 돌려준다', () => {
    expect(installationLostMessage('uninstalled')).toContain('제거');
    expect(installationLostMessage('suspended')).toContain('정지');
    expect(installationLostMessage('repo_removed')).toContain('접근 목록');
    expect(installationLostMessage('missing')).toContain('찾지 못했');
  });
  it('모르는 값·null·undefined 는 일반 안내로 폴백', () => {
    expect(installationLostMessage('weird-reason')).toBe('GitHub 앱 연결을 확인해 주세요');
    expect(installationLostMessage(null)).toBe('GitHub 앱 연결을 확인해 주세요');
    expect(installationLostMessage(undefined)).toBe('GitHub 앱 연결을 확인해 주세요');
  });
});

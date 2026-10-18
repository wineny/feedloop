import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkGithubTokenFormat,
  githubTokenLast4,
  classifyGithubFailure,
  githubFailureMessage,
  verifyGithubToken,
} from '@/lib/github/token';
import { githubTokenPayload, newBotFormSchema, DEFAULT_KEY_PROVIDER } from '@/lib/bot/new-bot-form';

// ⚠️ 진짜 토큰은 하나도 없다. 형태만 흉내낸 가짜 문자열이다.
const FINE = 'github_pat_NOTAREALTOKEN0000000000_0000000000000000000000000000000000000000000000000000000000';
const CLASSIC = 'ghp_NOTAREALTOKEN00000000000000000000';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('checkGithubTokenFormat — 오탈자 1차 필터', () => {
  it('fine-grained 와 classic 을 통과시킨다', () => {
    expect(checkGithubTokenFormat(FINE)).toEqual({ ok: true });
    expect(checkGithubTokenFormat(CLASSIC)).toEqual({ ok: true });
  });
  it('OAuth 유저 토큰(gho_, gh auth token)·앱 유저 토큰(ghu_)도 사람 토큰이라 통과', () => {
    expect(checkGithubTokenFormat('gho_NOTAREALTOKEN00000000000000000000')).toEqual({ ok: true });
    expect(checkGithubTokenFormat('ghu_NOTAREALTOKEN00000000000000000000')).toEqual({ ok: true });
  });
  it('빈 값·공백·개행·설치 토큰(ghs_)·리프레시 토큰(ghr_)·딴 서비스 키를 거른다', () => {
    expect(checkGithubTokenFormat('').ok).toBe(false);
    expect(checkGithubTokenFormat(undefined).ok).toBe(false);
    expect(checkGithubTokenFormat(` ${FINE}`).ok).toBe(false);
    expect(checkGithubTokenFormat(`${FINE}\n`).ok).toBe(false);
    expect(checkGithubTokenFormat('ghs_NOTAREALTOKEN00000000000000000000').ok).toBe(false);
    expect(checkGithubTokenFormat('ghr_NOTAREALTOKEN00000000000000000000').ok).toBe(false);
    expect(checkGithubTokenFormat('sk-ant-notgithub').ok).toBe(false);
  });
  it('마지막 4자만 남긴다', () => {
    expect(githubTokenLast4(CLASSIC)).toBe('0000');
    expect(githubTokenLast4('abcdEFGH')).toBe('EFGH');
  });
});

describe('classifyGithubFailure — 3분류', () => {
  it('401·403·404 는 토큰 거부(404 = 권한 없는 비공개 레포), 나머지는 연결', () => {
    expect(classifyGithubFailure(401)).toBe('token_rejected');
    expect(classifyGithubFailure(403)).toBe('token_rejected');
    expect(classifyGithubFailure(404)).toBe('token_rejected');
    expect(classifyGithubFailure(500)).toBe('connection');
    expect(classifyGithubFailure(null)).toBe('connection');
  });
  it('문구에 토큰 조각이나 원문 에러가 들어갈 자리가 없다', () => {
    for (const k of ['token_rejected', 'no_push', 'connection'] as const) {
      expect(githubFailureMessage(k)).not.toMatch(/github_pat_|ghp_/);
    }
  });
});

describe('verifyGithubToken — 저장 전 실호출', () => {
  function stub(handler: (url: string) => { status: number; body?: unknown }) {
    const calls: { url: string; headers: Record<string, string>; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, init });
        const r = handler(url);
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      }),
    );
    return calls;
  }

  it('레포에 push 가능하면 ok + 로그인. 토큰은 헤더로만 가고 리다이렉트를 따라가지 않는다', async () => {
    const calls = stub((url) =>
      url.endsWith('/repos/o/r') ? { status: 200, body: { permissions: { push: true } } } : { status: 200, body: { login: 'ny' } },
    );
    const out = await verifyGithubToken(FINE, 'https://github.com/o/r');
    expect(out).toEqual({ ok: true, login: 'ny', repoAccess: 'push', broadScopes: null });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FINE}`);
    expect(calls[0].url).not.toContain(FINE);
    expect(calls[0].init.redirect).toBe('error');
  });

  it('push:false 는 no_push. push 가 true·없음이면 막지 않는다 — fine-grained 는 «역할»을 말해 증명이 못 된다', async () => {
    stub(() => ({ status: 200, body: { permissions: { push: false, pull: true } } }));
    expect(await verifyGithubToken(FINE, 'https://github.com/o/r')).toMatchObject({ ok: false, kind: 'no_push' });
    stub((url) => (url.endsWith('/user') ? { status: 200, body: { login: 'ny' } } : { status: 200, body: {} }));
    expect(await verifyGithubToken(FINE, 'https://github.com/o/r')).toMatchObject({ ok: true, repoAccess: 'push' });
  });
  it('classic·OAuth 토큰은 x-oauth-scopes 를 broadScopes 로 돌려준다 — 화면이 경고한다 (보안 리뷰 M2)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith('/user') ? { login: 'ny' } : { permissions: { push: true } }), {
        status: 200, headers: { 'x-oauth-scopes': 'repo, read:org' },
      })));
    expect(await verifyGithubToken(CLASSIC, 'https://github.com/o/r')).toMatchObject({ ok: true, broadScopes: 'repo, read:org' });
  });

  it('404(권한 없는 비공개 레포)·401 은 token_rejected', async () => {
    stub(() => ({ status: 404 }));
    expect(await verifyGithubToken(FINE, 'https://github.com/o/r')).toMatchObject({ ok: false, kind: 'token_rejected' });
    stub(() => ({ status: 401 }));
    expect(await verifyGithubToken(FINE, 'https://github.com/o/r')).toMatchObject({ ok: false, kind: 'token_rejected' });
  });

  it('레포 URL 이 없는 봇은 /user 만 본다 (repoAccess: skipped). 403 은 통과, 401 은 거부', async () => {
    const calls = stub(() => ({ status: 200, body: { login: 'ny' } }));
    expect(await verifyGithubToken(FINE, null)).toEqual({ ok: true, login: 'ny', repoAccess: 'skipped', broadScopes: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/user');
    stub(() => ({ status: 403 }));
    expect(await verifyGithubToken(FINE, null)).toMatchObject({ ok: true, login: null });
    stub(() => ({ status: 401 }));
    expect(await verifyGithubToken(FINE, null)).toMatchObject({ ok: false, kind: 'token_rejected' });
  });

  it('앵커에 안 맞는 레포 URL 은 GitHub 을 부르지 않고 token_rejected', async () => {
    const calls = stub(() => ({ status: 200 }));
    expect(await verifyGithubToken(FINE, 'https://evil.example/?x=github.com/o/r')).toMatchObject({ ok: false, kind: 'token_rejected' });
    expect(calls).toHaveLength(0);
  });

  it('닿지 못하면 connection — 에러 객체를 로그에 싣지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`boom ${FINE}`); }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verifyGithubToken(FINE, 'https://github.com/o/r')).toMatchObject({ ok: false, kind: 'connection' });
    expect(JSON.stringify(err.mock.calls)).not.toContain(FINE);
  });
});

describe('등록 폼의 GitHub 토큰 칸', () => {
  function base(over: Record<string, unknown> = {}) {
    return {
      service_name: '널널투어', service_description: '', service_url: '', github_repo_url: '', github_token: '',
      pr_mode: 'approve', ai_mode: 'free', llm_provider: DEFAULT_KEY_PROVIDER,
      llm_model_choice: '', llm_model_custom: '', llm_api_key: '', ...over,
    };
  }
  it('비워도 통과하고 payload 는 null (공용 계정 폴백)', () => {
    const parsed = newBotFormSchema.safeParse(base());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(githubTokenPayload(parsed.data)).toBeNull();
  });
  it('채우면 형식만 본다 — 통과하면 {token} 만 나간다', () => {
    expect(newBotFormSchema.safeParse(base({ github_token: 'not-a-token' })).success).toBe(false);
    const parsed = newBotFormSchema.safeParse(base({ github_token: FINE }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(githubTokenPayload(parsed.data)).toEqual({ token: FINE });
  });
});

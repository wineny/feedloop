import { describe, it, expect, vi, beforeEach } from 'vitest';

// 봇 토큰 우선 · 공용 폴백 · 실패 기록 (B5).

const { maybeSingle, updated } = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  updated: [] as { patch: Record<string, unknown>; filters: string[] }[],
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      const filters: string[] = [];
      let patch: Record<string, unknown> | null = null;
      chain.select = vi.fn(() => chain);
      chain.update = vi.fn((p: Record<string, unknown>) => { patch = p; return chain; });
      chain.eq = vi.fn((c: string) => { filters.push(`eq:${c}`); return chain; });
      chain.not = vi.fn((c: string) => { filters.push(`not:${c}`); return chain; });
      chain.maybeSingle = maybeSingle;
      chain.then = (resolve: (v: unknown) => void) => {
        if (patch) updated.push({ patch, filters });
        resolve({ data: null, error: null });
      };
      return chain;
    },
  }),
}));

const octokitAuth: unknown[] = [];
vi.mock('@octokit/rest', () => ({
  Octokit: function (opts: { auth: string }) { octokitAuth.push(opts.auth); return { opts }; },
}));

const AES = 'b'.repeat(64);
const BOT_TOKEN = 'github_pat_BOTTOKEN0000000000_00000000000000000000000000000000000000000000000000000000000000';

let mod: typeof import('@/lib/auto-dev/github-auth');
let encrypt: typeof import('@/lib/utils/crypto').encrypt;

beforeEach(async () => {
  vi.clearAllMocks();
  updated.length = 0;
  octokitAuth.length = 0;
  process.env.BOT_TOKEN_ENCRYPTION_KEY = AES;
  process.env.GITHUB_TOKEN = 'ghp_platform000000000000000000000000';
  vi.resetModules();
  ({ encrypt } = await import('@/lib/utils/crypto'));
  mod = await import('@/lib/auto-dev/github-auth');
});

describe('resolveGithubToken', () => {
  it('전체 마감 신호는 실제 HTTP 전송을 취소한다', async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Response('{}');
    });
    const { octokit } = await mod.octokitForBot(null, { signal: controller.signal, timeoutMs: 5000, fetch: transport });
    const wrapped = (octokit as unknown as { opts: { request: { fetch: typeof transport } } }).opts.request.fetch;
    await wrapped('https://api.github.com/test');
    expect(received?.aborted).toBe(false);
    controller.abort();
    expect(received?.aborted).toBe(true);
    expect(() => wrapped('https://api.github.com/test')).toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('개별 요청 제한도 실제 AbortSignal 에 연결한다', async () => {
    let received: AbortSignal | null | undefined;
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal;
      return new Response('{}');
    });
    const { octokit } = await mod.octokitForBot(null, { timeoutMs: 10, fetch: transport });
    const wrapped = (octokit as unknown as { opts: { request: { fetch: typeof transport } } }).opts.request.fetch;
    await wrapped('https://api.github.com/test');
    expect(received).toBeInstanceOf(AbortSignal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received?.aborted).toBe(true);
  });

  it('봇에 토큰이 있으면 그걸 복호화해 쓴다 (source: bot)', async () => {
    maybeSingle.mockResolvedValue({ data: { github_token_encrypted: encrypt(BOT_TOKEN) }, error: null });
    expect(await mod.resolveGithubToken('bot-1')).toEqual({ token: BOT_TOKEN, source: 'bot' });
  });
  it('없으면 공용 GITHUB_TOKEN (source: platform) — 기존 봇 동작 불변', async () => {
    maybeSingle.mockResolvedValue({ data: { github_token_encrypted: null }, error: null });
    expect(await mod.resolveGithubToken('bot-1')).toEqual({ token: process.env.GITHUB_TOKEN, source: 'platform' });
  });
  it('botId 를 안 주면 DB 를 보지 않고 공용만', async () => {
    expect(await mod.resolveGithubToken(undefined)).toMatchObject({ source: 'platform' });
    expect(maybeSingle).not.toHaveBeenCalled();
  });
  it('둘 다 없으면 예전과 같은 문구로 throw', async () => {
    delete process.env.GITHUB_TOKEN;
    maybeSingle.mockResolvedValue({ data: { github_token_encrypted: null }, error: null });
    await expect(mod.resolveGithubToken('bot-1')).rejects.toThrow('GITHUB_TOKEN');
  });
  it('암호문이 손상됐으면 공용으로 흘리지 않고 «우리가 못 읽은» 사유로 적고 throw', async () => {
    maybeSingle.mockResolvedValue({ data: { github_token_encrypted: 'deadbeef:deadbeef:deadbeef' }, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mod.resolveGithubToken('bot-1')).rejects.toThrow('다시 등록');
    expect(updated[0].patch).toMatchObject({ github_token_failed_reason: expect.stringContaining('읽지 못했어요') });
  });
  it('봇 행 조회가 «실패»하면 공용으로 흘리지 않고 throw — 배지도 안 켠다 (보안 리뷰 M1, fail-closed)', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'column github_token_encrypted does not exist' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mod.resolveGithubToken('bot-1')).rejects.toThrow('읽지 못했어요');
    expect(updated).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });
  it('octokitForBot 은 고른 토큰으로 Octokit 을 만든다', async () => {
    maybeSingle.mockResolvedValue({ data: { github_token_encrypted: encrypt(BOT_TOKEN) }, error: null });
    const { source } = await mod.octokitForBot('bot-1');
    expect(source).toBe('bot');
    expect(octokitAuth).toEqual([BOT_TOKEN]);
  });
});

describe('noteGithubError / clearGithubFailureIfAny', () => {
  it('봇 토큰 경로의 401·403 만 적는다. 공용 경로·5xx·null 봇은 안 적는다', async () => {
    await mod.noteGithubError('bot-1', 'bot', { status: 403 });
    expect(updated).toHaveLength(1);
    expect(updated[0].patch.github_token_failed_at).toBeTruthy();
    expect(updated[0].patch.github_token_failed_reason).toContain('거부');
    await mod.noteGithubError('bot-1', 'platform', { status: 403 });
    await mod.noteGithubError('bot-1', 'bot', { status: 502 });
    await mod.noteGithubError(null, 'bot', { status: 401 });
    expect(updated).toHaveLength(1);
  });
  it('404 는 적지 않는다 — 옛 레포의 PR 을 열 때 멀쩡한 토큰에 배지가 켜지면 안 된다 (코드 리뷰 HIGH)', async () => {
    await mod.noteGithubError('bot-1', 'bot', { status: 404 });
    expect(updated).toHaveLength(0);
  });
  it('쓰기 시도의 403 은 no_push — 운영자가 고칠 건 Read/Write 토글이다 (코드 리뷰 HIGH)', async () => {
    await mod.noteGithubError('bot-1', 'bot', { status: 403 }, { write: true });
    expect(updated[0].patch.github_token_failed_reason).toContain('push');
    await mod.noteGithubError('bot-1', 'bot', { status: 401 }, { write: true });
    expect(updated[1].patch.github_token_failed_reason).toContain('거부');
  });
  it('성공 시 해제는 failed_at 이 있는 행만 UPDATE 한다 (성공마다 왕복하지 않게)', async () => {
    await mod.clearGithubFailureIfAny('bot-1', 'bot');
    expect(updated).toHaveLength(1);
    expect(updated[0].patch).toEqual({ github_token_failed_at: null, github_token_failed_reason: null });
    expect(updated[0].filters).toContain('not:github_token_failed_at');
    await mod.clearGithubFailureIfAny('bot-1', 'platform');
    expect(updated).toHaveLength(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// PATCH 한 번이 GitHub 으로 바깥 요청을 낸다. 토큰 원문은 어떤 응답에도 나가지 않고,
// 검증에 실패하면 DB 에 아무것도 남기지 않는다 (B5).

const { resolveOwnedBots, encrypt, singleMock, updateMock } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  encrypt: vi.fn(() => 'enc:ciphertext'),
  singleMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/utils/crypto', () => ({ encrypt }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain);
      chain.update = vi.fn((p: unknown) => { updateMock(p); return chain; });
      chain.single = singleMock;
      return chain;
    },
  }),
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'github_pat_NOTAREALTOKEN0000000000_0000000000000000000000000000000000000000000000000000000000';
const ROW = {
  id: BOT_ID, github_repo_url: 'https://github.com/o/r', github_token_encrypted: null, github_token_last4: null,
  github_token_verified_at: null, github_token_failed_at: null, github_token_failed_reason: null, github_token_broad: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_TOKEN = 'ghp_platform000000000000000000000000';
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'u1', botIds: [BOT_ID] });
  singleMock.mockResolvedValue({ data: ROW, error: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.endsWith('/user') ? { login: 'ny' } : { permissions: { push: true } }), { status: 200 })));
});

async function route() {
  return import('@/app/api/bots/[id]/github-token/route');
}
function req(method: string, body?: unknown) {
  return new Request(`https://feedloop.test/api/bots/${BOT_ID}/github-token`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: BOT_ID }) };

describe('/api/bots/[id]/github-token', () => {
  it('무인증 401 · 남의 봇 403', async () => {
    const r = await route();
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await r.GET(req('GET'), params)).status).toBe(401);
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: 'no' });
    expect((await r.PATCH(req('PATCH', { token: TOKEN }), params)).status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('GET 은 암호문을 내보내지 않는다 — hasToken·last4 만', async () => {
    const r = await route();
    singleMock.mockResolvedValue({ data: { ...ROW, github_token_encrypted: 'enc:x', github_token_last4: 'abcd' }, error: null });
    const body = await (await r.GET(req('GET'), params)).json();
    expect(body).toMatchObject({ hasToken: true, tokenLast4: 'abcd', repoUrl: 'https://github.com/o/r', platformFallback: true });
    expect(JSON.stringify(body)).not.toContain('enc:');
  });

  it('형식이 틀리면 400, GitHub 을 부르지 않는다', async () => {
    const r = await route();
    const res = await r.PATCH(req('PATCH', { token: 'nope' }), params);
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('검증 실패(읽기 전용)면 400 + kind, DB 에 아무것도 안 남긴다', async () => {
    const r = await route();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 })));
    const res = await r.PATCH(req('PATCH', { token: TOKEN }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'no_push' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('통과하면 암호문·last4·verified_at 저장 + 지난 실패 해제, 응답에 원문·암호문 없음', async () => {
    const r = await route();
    singleMock
      .mockResolvedValueOnce({ data: { ...ROW, github_token_failed_at: '2026-09-13T00:00:00Z', github_token_failed_reason: 'x' }, error: null })
      .mockResolvedValueOnce({ data: { ...ROW, github_token_encrypted: 'enc:ciphertext', github_token_last4: TOKEN.slice(-4), github_token_verified_at: 'now' }, error: null });
    const res = await r.PATCH(req('PATCH', { token: TOKEN }), params);
    expect(res.status).toBe(200);
    expect(encrypt).toHaveBeenCalledWith(TOKEN);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      github_token_encrypted: 'enc:ciphertext', github_token_last4: TOKEN.slice(-4),
      github_token_failed_at: null, github_token_failed_reason: null, github_token_broad: false,
    }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('enc:');
    expect(text).toContain('"login":"ny"');
  });

  it('classic·OAuth 토큰이면 github_token_broad=true 로 저장하고 GET 이 broadToken 으로 돌려준다 (보안 재검토 R2)', async () => {
    const r = await route();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith('/user') ? { login: 'ny' } : { permissions: { push: true } }), {
        status: 200, headers: { 'x-oauth-scopes': 'repo' },
      })));
    singleMock
      .mockResolvedValueOnce({ data: ROW, error: null })
      .mockResolvedValueOnce({ data: { ...ROW, github_token_encrypted: 'enc:x', github_token_last4: 'abcd', github_token_broad: true }, error: null });
    const res = await r.PATCH(req('PATCH', { token: 'ghp_NOTAREALTOKEN00000000000000000000' }), params);
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ github_token_broad: true }));
    expect(await res.json()).toMatchObject({ broadToken: true, broadScopes: 'repo' });
  });

  it('분당 5회를 넘기면 429 — 형식이 맞은 요청만 센다', async () => {
    const r = await route();
    resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'rate-user', botIds: [BOT_ID] });
    for (let i = 0; i < 5; i++) expect((await r.PATCH(req('PATCH', { token: TOKEN }), params)).status).toBe(200);
    expect((await r.PATCH(req('PATCH', { token: TOKEN }), params)).status).toBe(429);
  });

  it('DELETE 는 토큰·last4·실패 표시를 전부 비운다', async () => {
    const r = await route();
    expect((await r.DELETE(req('DELETE'), params)).status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      github_token_encrypted: null, github_token_last4: null, github_token_verified_at: null,
      github_token_failed_at: null, github_token_failed_reason: null, github_token_broad: false,
    });
  });
});

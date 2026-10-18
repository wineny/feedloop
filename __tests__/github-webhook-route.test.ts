import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// src/app/api/github/webhook/route.ts — GitHub App 웹훅 수신 (안 B).
// 서명 검증 → ping → installation/installation_repositories 처리기 위임 → 알수없는 이벤트 무시.
//
// **웹훅은 `readWebhookSecret()` 만 본다** — `readGithubAppConfig()`(OAuth 클라이언트 자격까지 요구)와는
// 독립이다. 그래서 이 테스트는 `readGithubAppConfig` 가 아니라 `readWebhookSecret` 을 모킹한다
// (보안 리뷰 LOW — 시크릿은 있는데 OAuth 자격이 없는 배포에서도 웹훅은 동작해야 한다).

const { readWebhookSecret, verifyWebhookSignature } = vi.hoisted(() => ({
  readWebhookSecret: vi.fn(),
  verifyWebhookSignature: vi.fn(),
}));
vi.mock('@/lib/github/app', () => ({ readWebhookSecret, verifyWebhookSignature }));

const { handleInstallationEvent, handleInstallationRepositoriesEvent } = vi.hoisted(() => ({
  handleInstallationEvent: vi.fn(),
  handleInstallationRepositoriesEvent: vi.fn(),
}));
vi.mock('@/lib/github/installation-events', () => ({ handleInstallationEvent, handleInstallationRepositoriesEvent }));

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: () => ({}) }) }));

const SECRET = 'whsecret';

function sigFor(body: string) {
  return 'sha256=' + createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
}

async function route() {
  return import('@/app/api/github/webhook/route');
}

function req(body: string, opts: { signature?: string | null; event?: string; contentLength?: number } = {}) {
  const headers: Record<string, string> = {};
  if (opts.signature !== null) headers['x-hub-signature-256'] = opts.signature ?? sigFor(body);
  if (opts.event) headers['x-github-event'] = opts.event;
  if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
  return new Request('https://feedloop.test/api/github/webhook', { method: 'POST', headers, body });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  readWebhookSecret.mockReturnValue(SECRET);
  verifyWebhookSignature.mockImplementation((secret: string, raw: string, header: string | null) => header === sigFor(raw) && secret === SECRET);
});

describe('POST /api/github/webhook', () => {
  it('webhookSecret 이 없으면(미설정) 503', async () => {
    readWebhookSecret.mockReturnValue(null);
    const r = await route();
    const res = await r.POST(req(JSON.stringify({}), { event: 'ping' }));
    expect(res.status).toBe(503);
  });
  it('시크릿은 있는데 OAuth 클라이언트 자격(readGithubAppConfig 몫)이 없어도 웹훅은 동작한다', async () => {
    // readGithubAppConfig() 는 아예 모킹하지 않았다(이 라우트는 그 함수를 import 조차 안 한다) —
    // 그래도 readWebhookSecret() 만으로 서명 검증·처리기 위임이 끝까지 된다는 것이 이 테스트의 요점.
    const r = await route();
    const res = await r.POST(req(JSON.stringify({ zen: 'hi' }), { event: 'ping' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, event: 'ping' });
  });
  it('본문이 content-length 로 2MB 초과면 413 — 서명 검증도 안 한다', async () => {
    const r = await route();
    const res = await r.POST(req('{}', { event: 'ping', contentLength: 2 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(413);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });
  it('서명이 없으면 401', async () => {
    const r = await route();
    const res = await r.POST(req(JSON.stringify({ action: 'deleted' }), { signature: null, event: 'installation' }));
    expect(res.status).toBe(401);
  });
  it('서명이 틀리면 401', async () => {
    const r = await route();
    const res = await r.POST(req(JSON.stringify({ action: 'deleted' }), { signature: 'sha256=deadbeef', event: 'installation' }));
    expect(res.status).toBe(401);
  });
  it('ping 은 서명만 맞으면 200 { ok, event }', async () => {
    const r = await route();
    const body = JSON.stringify({ zen: 'hi' });
    const res = await r.POST(req(body, { event: 'ping' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, event: 'ping' });
  });
  it('installation 이벤트는 handleInstallationEvent 로 위임하고 결과를 그대로 응답한다', async () => {
    handleInstallationEvent.mockResolvedValue({ event: 'installation', action: 'deleted', installationId: 1, affected: 2 });
    const r = await route();
    const body = JSON.stringify({ action: 'deleted', installation: { id: 1 } });
    const res = await r.POST(req(body, { event: 'installation' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: 'installation', action: 'deleted', installationId: 1, affected: 2 });
    expect(handleInstallationEvent).toHaveBeenCalledTimes(1);
  });
  it('installation_repositories 이벤트는 그 처리기로 위임한다', async () => {
    handleInstallationRepositoriesEvent.mockResolvedValue({ event: 'installation_repositories', action: 'removed', installationId: 1, affected: 1 });
    const r = await route();
    const body = JSON.stringify({ action: 'removed', installation: { id: 1 }, repositories_removed: [{ full_name: 'o/r' }] });
    const res = await r.POST(req(body, { event: 'installation_repositories' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ affected: 1 });
    expect(handleInstallationRepositoriesEvent).toHaveBeenCalledTimes(1);
  });
  it('처리기가 throw 하면 500 — GitHub 이 재전송하게', async () => {
    handleInstallationEvent.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await route();
    const body = JSON.stringify({ action: 'deleted', installation: { id: 1 } });
    const res = await r.POST(req(body, { event: 'installation' }));
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalled();
  });
  it('알 수 없는 이벤트는 200 + ignored:true — 재전송을 유발하지 않는다', async () => {
    const r = await route();
    const body = JSON.stringify({ zen: 'irrelevant' });
    const res = await r.POST(req(body, { event: 'star' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, event: 'star', ignored: true });
    expect(handleInstallationEvent).not.toHaveBeenCalled();
    expect(handleInstallationRepositoriesEvent).not.toHaveBeenCalled();
  });
  it('서명은 맞는데 JSON 이 깨졌으면 400', async () => {
    const r = await route();
    const body = 'not-json{{{';
    const res = await r.POST(req(body, { event: 'installation' }));
    expect(res.status).toBe(400);
  });
});

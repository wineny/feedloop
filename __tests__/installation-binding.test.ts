import { describe, it, expect, vi, beforeEach } from 'vitest';

// src/lib/github/installation-binding.ts — 봇 ↔ 설치를 묶는 판정 (B5 안 B).
// 순서: no_repo → not_installed → suspended → unknown_push → no_push → bound.
// recheckInstallation 은 유저 토큰이 없어 «새로 묶지 않는다» — 이미 묶인 설치를 다시 보기만.

const { updateMock, updateEqMock, getServiceRoleClient } = vi.hoisted(() => {
  const updateMock = vi.fn();
  const updateEqMock = vi.fn();
  const defaultClient = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updateMock(patch);
        return {
          eq: (col: string, v: unknown) => {
            updateEqMock(col, v);
            return Promise.resolve({ error: null });
          },
        };
      },
    }),
  };
  return { updateMock, updateEqMock, getServiceRoleClient: vi.fn(() => defaultClient) };
});

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient }));

const { findInstallationForRepo, userCanPush } = vi.hoisted(() => ({
  findInstallationForRepo: vi.fn(),
  userCanPush: vi.fn(),
}));

vi.mock('@/lib/github/app', async (orig) => {
  const actual = await orig<typeof import('@/lib/github/app')>();
  return {
    ...actual,
    findInstallationForRepo,
    userCanPush,
    appOctokit: () => ({} as never),
  };
});

let mod: typeof import('@/lib/github/installation-binding');

const CONFIG = { appId: '1', privateKey: 'k', slug: 'feedloop-app', clientId: 'c', clientSecret: 's', webhookSecret: null };
const INSTALLATION = { id: 42, login: 'wineny', suspended: false, repositorySelection: 'all' as const };
const NOW = '2026-09-13T12:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

async function load() {
  vi.resetModules();
  mod = await import('@/lib/github/installation-binding');
}

describe('bindInstallation', () => {
  it('레포 URL 이 없으면 no_repo — GitHub 을 부르지 않는다', async () => {
    await load();
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: null }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'no_repo' });
    expect(findInstallationForRepo).not.toHaveBeenCalled();
  });
  it('레포 URL 형식이 틀려도 no_repo', async () => {
    await load();
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'not-a-url' }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'no_repo' });
  });
  it('설치가 없으면 not_installed — push 는 안 물어본다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(null);
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'not_installed' });
    expect(userCanPush).not.toHaveBeenCalled();
  });
  it('설치가 정지 상태면 suspended — push 는 안 물어본다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue({ ...INSTALLATION, suspended: true });
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'suspended', installation: { ...INSTALLATION, suspended: true } });
    expect(userCanPush).not.toHaveBeenCalled();
  });
  it('push 여부를 모르면(null) unknown_push — DB 를 안 건드린다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    userCanPush.mockResolvedValue(null);
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'unknown_push', installation: INSTALLATION });
    expect(updateMock).not.toHaveBeenCalled();
  });
  it('push 가 false 면 no_push — 묶지 않는다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    userCanPush.mockResolvedValue(false);
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', 'ny');
    expect(out).toEqual({ kind: 'no_push', installation: INSTALLATION });
    expect(updateMock).not.toHaveBeenCalled();
  });
  it('push 가 true 면 bound — 설치 id·계정·시각·by 를 쓰고 lost_* 를 지운다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    userCanPush.mockResolvedValue(true);
    const out = await mod.bindInstallation(
      CONFIG,
      { botId: 'b1', repoUrl: 'https://github.com/o/r' },
      'ghu_token',
      'ny',
      { now: () => NOW },
    );
    expect(out).toEqual({ kind: 'bound', installation: INSTALLATION });
    expect(updateMock).toHaveBeenCalledWith({
      github_installation_id: 42,
      github_installation_login: 'wineny',
      github_installation_connected_at: NOW,
      github_installation_repo_selection: 'all',
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_by: 'ny',
    });
    expect(updateEqMock).toHaveBeenCalledWith('id', 'b1');
  });
  it('userLogin 이 null 이어도 bound 되고 github_installation_by 는 null', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    userCanPush.mockResolvedValue(true);
    const out = await mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', null);
    expect(out.kind).toBe('bound');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ github_installation_by: null }));
  });
  it('DB update 가 실패하면 throw', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    userCanPush.mockResolvedValue(true);
    getServiceRoleClient.mockReturnValueOnce({
      from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'db down' } }) }) }),
    } as never);
    await expect(
      mod.bindInstallation(CONFIG, { botId: 'b1', repoUrl: 'https://github.com/o/r' }, 'ghu_token', 'ny'),
    ).rejects.toThrow('bind failed');
  });
});

describe('recheckInstallation', () => {
  it('installationId 가 없으면 not_bound — GitHub 을 안 부른다', async () => {
    await load();
    const out = await mod.recheckInstallation(CONFIG, { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: null });
    expect(out).toEqual({ kind: 'not_bound' });
    expect(findInstallationForRepo).not.toHaveBeenCalled();
  });
  it('레포 URL 이 없으면 no_repo', async () => {
    await load();
    const out = await mod.recheckInstallation(CONFIG, { id: 'b1', repoUrl: null, installationId: 42 });
    expect(out).toEqual({ kind: 'no_repo' });
  });
  it('레포 URL 형식이 틀려도 no_repo', async () => {
    await load();
    const out = await mod.recheckInstallation(CONFIG, { id: 'b1', repoUrl: 'nope', installationId: 42 });
    expect(out).toEqual({ kind: 'no_repo' });
  });
  it('설치를 못 찾으면 missing — DB 에 lost_at·lost_reason:missing 을 쓴다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(null);
    const out = await mod.recheckInstallation(
      CONFIG,
      { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: 42 },
      { now: () => NOW },
    );
    expect(out).toEqual({ kind: 'missing' });
    expect(updateMock).toHaveBeenCalledWith({ github_installation_lost_at: NOW, github_installation_lost_reason: 'missing' });
    expect(updateEqMock).toHaveBeenCalledWith('id', 'b1');
  });
  it('설치 id 가 바뀌었으면 changed — missing 으로 적고 새로 묶지 않는다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue({ ...INSTALLATION, id: 999 });
    const out = await mod.recheckInstallation(
      CONFIG,
      { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: 42 },
      { now: () => NOW },
    );
    expect(out).toEqual({ kind: 'changed', installation: { ...INSTALLATION, id: 999 } });
    expect(updateMock).toHaveBeenCalledWith({ github_installation_lost_at: NOW, github_installation_lost_reason: 'missing' });
  });
  it('설치가 그대로인데 정지 상태면 suspended', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue({ ...INSTALLATION, suspended: true });
    const out = await mod.recheckInstallation(
      CONFIG,
      { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: 42 },
      { now: () => NOW },
    );
    expect(out).toEqual({ kind: 'suspended', installation: { ...INSTALLATION, suspended: true } });
    expect(updateMock).toHaveBeenCalledWith({ github_installation_lost_at: NOW, github_installation_lost_reason: 'suspended' });
  });
  it('설치가 그대로고 정상이면 ok — lost_* 를 지우고 login 을 갱신한다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue({ ...INSTALLATION, login: 'renamed-org' });
    const out = await mod.recheckInstallation(CONFIG, { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: 42 });
    expect(out).toEqual({ kind: 'ok', installation: { ...INSTALLATION, login: 'renamed-org' } });
    expect(updateMock).toHaveBeenCalledWith({
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_login: 'renamed-org',
      github_installation_repo_selection: 'all',
    });
  });
  it('userCanPush 를 부르지 않는다 — 유저 토큰이 없다', async () => {
    await load();
    findInstallationForRepo.mockResolvedValue(INSTALLATION);
    await mod.recheckInstallation(CONFIG, { id: 'b1', repoUrl: 'https://github.com/o/r', installationId: 42 });
    expect(userCanPush).not.toHaveBeenCalled();
  });
});

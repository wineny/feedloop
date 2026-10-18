import { describe, it, expect, vi } from 'vitest';
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  repoFullNameOf,
  type BotsTable,
  type InstallationPayload,
} from '@/lib/github/installation-events';

// src/lib/github/installation-events.ts — 웹훅이 lost_* 를 찍고 지우는 순수 처리기 (안 B).
// 여기서는 「묶지」 않는다 — created 는 무시. markLost/clearLost 가 정확한 filter·patch 를 보내는지가 핵심.

const NOW = '2026-09-13T12:00:00.000Z';

interface FakeRow {
  id: string;
  github_repo_url: string | null;
  github_installation_lost_reason: string | null;
}

/** BotsTable 가짜 — select 는 고정 rows, update 는 eq/in/is 호출을 기록한다 */
function fakeDb(rows: FakeRow[]) {
  const updateCalls: { patch: Record<string, unknown>; eq?: [string, unknown]; in?: [string, unknown[]] }[] = [];
  const selectEq = vi.fn(async (_col: string, _v: unknown) => ({ data: rows, error: null }));
  const db: BotsTable = {
    from: () => ({
      select: () => ({ eq: selectEq }),
      update: (patch: Record<string, unknown>) => {
        const call: { patch: Record<string, unknown>; eq?: [string, unknown]; in?: [string, unknown[]] } = { patch };
        updateCalls.push(call);
        return {
          eq: (col: string, v: unknown) => {
            call.eq = [col, v];
            return {
              in: async (col2: string, v2: unknown[]) => {
                call.in = [col2, v2];
                return { error: null };
              },
              is: async () => ({ error: null }),
            };
          },
        };
      },
    }),
  };
  return { db, updateCalls, selectEq };
}

function fakeDbSelectError(message: string) {
  const db: BotsTable = {
    from: () => ({
      select: () => ({ eq: async () => ({ data: null, error: { message } }) }),
      update: () => ({ eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }) }),
    }),
  };
  return db;
}

describe('repoFullNameOf', () => {
  it('소문자로 접는다', () => {
    expect(repoFullNameOf('https://github.com/WineNy/NullNul-Tour')).toBe('wineny/nullnul-tour');
  });
  it('.git·trailing slash 를 허용한다', () => {
    expect(repoFullNameOf('https://github.com/o/r.git')).toBe('o/r');
    expect(repoFullNameOf('https://github.com/o/r/')).toBe('o/r');
  });
  it('못 읽으면(빈 값·이상한 형식) null', () => {
    expect(repoFullNameOf(null)).toBeNull();
    expect(repoFullNameOf(undefined)).toBeNull();
    expect(repoFullNameOf('not-a-url')).toBeNull();
    expect(repoFullNameOf('https://gitlab.com/o/r')).toBeNull();
  });
  it('www. 접두사도 같은 레포로 맞춘다 — parseRepoInfo 로 위임한 뒤(코드 리뷰 항목) 생긴 동작', () => {
    // 예전엔 여기 사본 정규식이 www. 를 안 받아 등록 검증(lib/bot/registration.ts)이 받아들이는 URL 이
    // 웹훅에서는 «조용히» 안 맞아 잃어버림·복구를 영영 못 받았다. parseRepoInfo(lib/github/repo-url.ts)
    // 하나로 합친 뒤엔 그런 URL 도 맞는다.
    expect(repoFullNameOf('https://www.github.com/o/r')).toBe('o/r');
    expect(repoFullNameOf('https://www.github.com/O/R.git')).toBe('o/r');
  });
  it('parseRepoInfo 가 거부하는 값은(호스트가 다르거나 형식이 틀리면) www. 여부와 상관없이 null', () => {
    expect(repoFullNameOf('https://www.gitlab.com/o/r')).toBeNull();
    expect(repoFullNameOf('http://evil.example/?x=github.com/a/b')).toBeNull();
  });
});

describe('handleInstallationEvent', () => {
  it('installation id 가 없으면 무시하고 affected:0', async () => {
    const { db } = fakeDb([]);
    const out = await handleInstallationEvent(db, { action: 'deleted' }, NOW);
    expect(out).toMatchObject({ installationId: null, affected: 0, ignored: 'no installation id' });
  });
  it('deleted — 그 설치의 봇 전부를 uninstalled 로 마크한다', async () => {
    const rows: FakeRow[] = [
      { id: 'bot-1', github_repo_url: 'https://github.com/o/r1', github_installation_lost_reason: null },
      { id: 'bot-2', github_repo_url: 'https://github.com/o/r2', github_installation_lost_reason: null },
    ];
    const { db, updateCalls } = fakeDb(rows);
    const payload: InstallationPayload = { action: 'deleted', installation: { id: 555 } };
    const out = await handleInstallationEvent(db, payload, NOW);
    expect(out).toMatchObject({ event: 'installation', action: 'deleted', installationId: 555, affected: 2 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].patch).toEqual({ github_installation_lost_at: NOW, github_installation_lost_reason: 'uninstalled' });
    expect(updateCalls[0].eq).toEqual(['github_installation_id', 555]);
    expect(updateCalls[0].in).toEqual(['id', ['bot-1', 'bot-2']]);
  });
  it('suspend — suspended 로 마크한다', async () => {
    const rows: FakeRow[] = [{ id: 'bot-1', github_repo_url: null, github_installation_lost_reason: null }];
    const { db, updateCalls } = fakeDb(rows);
    const out = await handleInstallationEvent(db, { action: 'suspend', installation: { id: 1 } }, NOW);
    expect(out.affected).toBe(1);
    expect(updateCalls[0].patch.github_installation_lost_reason).toBe('suspended');
  });
  it('unsuspend — lost_reason 이 suspended 인 봇만 복구, 다른 사유(repo_removed 등)는 그대로', async () => {
    const rows: FakeRow[] = [
      { id: 'bot-suspended', github_repo_url: null, github_installation_lost_reason: 'suspended' },
      { id: 'bot-other', github_repo_url: null, github_installation_lost_reason: 'repo_removed' },
      { id: 'bot-clean', github_repo_url: null, github_installation_lost_reason: null },
    ];
    const { db, updateCalls } = fakeDb(rows);
    const out = await handleInstallationEvent(db, { action: 'unsuspend', installation: { id: 1 } }, NOW);
    expect(out.affected).toBe(1);
    expect(updateCalls[0].in).toEqual(['id', ['bot-suspended']]);
    expect(updateCalls[0].patch).toEqual({
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_connected_at: NOW,
    });
  });
  it('unsuspend 인데 해당하는 봇이 없으면 update 자체를 안 한다(빈 in 은 안 보낸다)', async () => {
    const rows: FakeRow[] = [{ id: 'bot-1', github_repo_url: null, github_installation_lost_reason: null }];
    const { db, updateCalls } = fakeDb(rows);
    const out = await handleInstallationEvent(db, { action: 'unsuspend', installation: { id: 1 } }, NOW);
    expect(out.affected).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
  it('created 는 무시 — 묶기는 콜백 몫', async () => {
    const { db, updateCalls } = fakeDb([]);
    const out = await handleInstallationEvent(db, { action: 'created', installation: { id: 1 } }, NOW);
    expect(out.ignored).toContain('created');
    expect(updateCalls).toHaveLength(0);
  });
  it('모르는 action 도 무시', async () => {
    const { db, updateCalls } = fakeDb([]);
    const out = await handleInstallationEvent(db, { action: 'new_permissions_accepted', installation: { id: 1 } }, NOW);
    expect(out.ignored).toContain('new_permissions_accepted');
    expect(updateCalls).toHaveLength(0);
  });
  it('action 자체가 없으면 무시 문구에 (none)', async () => {
    const { db } = fakeDb([]);
    const out = await handleInstallationEvent(db, { installation: { id: 1 } }, NOW);
    expect(out.ignored).toBe('action (none) not handled');
  });
  it('installation.id 가 0·음수·NaN·문자열이면 없는 것으로 본다', async () => {
    const { db } = fakeDb([]);
    for (const id of [0, -1, Number.NaN]) {
      const out = await handleInstallationEvent(db, { action: 'deleted', installation: { id } }, NOW);
      expect(out.ignored).toBe('no installation id');
    }
  });
  it('select 조회가 실패하면 throw', async () => {
    const db = fakeDbSelectError('bots select failed');
    await expect(handleInstallationEvent(db, { action: 'deleted', installation: { id: 1 } }, NOW)).rejects.toThrow('bots lookup failed');
  });
});

describe('handleInstallationRepositoriesEvent', () => {
  it('installation id 가 없으면 무시', async () => {
    const { db } = fakeDb([]);
    const out = await handleInstallationRepositoriesEvent(db, { action: 'removed' }, NOW);
    expect(out.ignored).toBe('no installation id');
  });
  it('removed — 제거된 레포와 일치하는 봇만 repo_removed 로 마크. 대소문자·.git 무시', async () => {
    const rows: FakeRow[] = [
      { id: 'bot-match', github_repo_url: 'https://github.com/O/R.git', github_installation_lost_reason: null },
      { id: 'bot-other-repo', github_repo_url: 'https://github.com/o/other', github_installation_lost_reason: null },
      { id: 'bot-no-repo', github_repo_url: null, github_installation_lost_reason: null },
    ];
    const { db, updateCalls } = fakeDb(rows);
    const payload: InstallationPayload = { action: 'removed', installation: { id: 1 }, repositories_removed: [{ full_name: 'o/r' }] };
    const out = await handleInstallationRepositoriesEvent(db, payload, NOW);
    expect(out.affected).toBe(1);
    expect(updateCalls[0].in).toEqual(['id', ['bot-match']]);
    expect(updateCalls[0].patch.github_installation_lost_reason).toBe('repo_removed');
  });
  it('added — repo_removed 상태였던 봇만 복구한다. 다른 사유(uninstalled 등)는 안 건드린다', async () => {
    const rows: FakeRow[] = [
      { id: 'bot-was-removed', github_repo_url: 'https://github.com/o/r', github_installation_lost_reason: 'repo_removed' },
      { id: 'bot-was-uninstalled', github_repo_url: 'https://github.com/o/r2', github_installation_lost_reason: 'uninstalled' },
    ];
    const { db, updateCalls } = fakeDb(rows);
    const payload: InstallationPayload = {
      action: 'added',
      installation: { id: 1 },
      repositories_added: [{ full_name: 'o/r' }, { full_name: 'o/r2' }],
    };
    const out = await handleInstallationRepositoriesEvent(db, payload, NOW);
    expect(out.affected).toBe(1);
    expect(updateCalls[0].in).toEqual(['id', ['bot-was-removed']]);
    expect(updateCalls[0].patch).toEqual({
      github_installation_lost_at: null,
      github_installation_lost_reason: null,
      github_installation_connected_at: NOW,
    });
  });
  it('added 인데 그 레포 이름이 목록에 없으면 복구되지 않는다', async () => {
    const rows: FakeRow[] = [{ id: 'bot-1', github_repo_url: 'https://github.com/o/r', github_installation_lost_reason: 'repo_removed' }];
    const { db, updateCalls } = fakeDb(rows);
    const payload: InstallationPayload = { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'o/other' }] };
    const out = await handleInstallationRepositoriesEvent(db, payload, NOW);
    expect(out.affected).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
  it('레포 목록이 비어 있으면 아무도 영향받지 않는다', async () => {
    const rows: FakeRow[] = [{ id: 'bot-1', github_repo_url: 'https://github.com/o/r', github_installation_lost_reason: null }];
    const { db, updateCalls } = fakeDb(rows);
    const out = await handleInstallationRepositoriesEvent(db, { action: 'removed', installation: { id: 1 } }, NOW);
    expect(out.affected).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
  it('모르는 action 은 무시', async () => {
    const { db, updateCalls } = fakeDb([{ id: 'bot-1', github_repo_url: null, github_installation_lost_reason: null }]);
    const out = await handleInstallationRepositoriesEvent(db, { action: 'weird', installation: { id: 1 } }, NOW);
    expect(out.ignored).toContain('weird');
    expect(updateCalls).toHaveLength(0);
  });
});

describe('웹훅 재전송 안전 — 설치 A 의 이벤트는 설치 B 에 묶인 봇을 건드리지 않는다', () => {
  // botsOnInstallation() 은 `.eq('github_installation_id', installationId)` 로만 봇을 가져온다 —
  // 재검토(코드 리뷰)가 「이건 쿼리 필터로 구조적으로 안전하다」고 짚은 지점을 실제로 잠근다.
  // 위 describe 들의 fakeDb 는 install id 와 무관하게 고정된 rows 를 돌려줘 이 성질을 못 본다 —
  // 여기서는 Supabase 처럼 install id 별로 다른 행 집합을 두고, select 가 어떤 id 로 불렸는지도 함께 본다.
  function fakeMultiInstallationDb(botsByInstallation: Record<number, FakeRow[]>) {
    const updateCalls: { patch: Record<string, unknown>; eq?: [string, unknown]; in?: [string, unknown[]] }[] = [];
    const selectEqCalls: [string, unknown][] = [];
    const selectEq = vi.fn(async (col: string, v: unknown) => {
      selectEqCalls.push([col, v]);
      return { data: botsByInstallation[v as number] ?? [], error: null };
    });
    const db: BotsTable = {
      from: () => ({
        select: () => ({ eq: selectEq }),
        update: (patch: Record<string, unknown>) => {
          const call: { patch: Record<string, unknown>; eq?: [string, unknown]; in?: [string, unknown[]] } = { patch };
          updateCalls.push(call);
          return {
            eq: (col: string, v: unknown) => {
              call.eq = [col, v];
              return {
                in: async (col2: string, v2: unknown[]) => {
                  call.in = [col2, v2];
                  return { error: null };
                },
                is: async () => ({ error: null }),
              };
            },
          };
        },
      }),
    };
    return { db, updateCalls, selectEqCalls };
  }

  it('installation(deleted) — A 의 이벤트가 select 도 update 도 A 로만 스코핑되고, B 의 봇은 언급조차 안 된다', async () => {
    const BOTS_ON_A: FakeRow[] = [{ id: 'bot-on-a', github_repo_url: 'https://github.com/o/a', github_installation_lost_reason: null }];
    const BOTS_ON_B: FakeRow[] = [{ id: 'bot-on-b', github_repo_url: 'https://github.com/o/b', github_installation_lost_reason: null }];
    const { db, updateCalls, selectEqCalls } = fakeMultiInstallationDb({ 111: BOTS_ON_A, 222: BOTS_ON_B });

    const out = await handleInstallationEvent(db, { action: 'deleted', installation: { id: 111 } }, NOW);

    expect(out).toMatchObject({ installationId: 111, affected: 1 });
    // select 가 물어본 것은 설치 111 뿐이다 — 222 는 아예 쿼리되지 않았다
    expect(selectEqCalls).toEqual([['github_installation_id', 111]]);
    // update 도 111 로만 스코핑되고, B 의 봇 id 는 in 목록에 나타나지 않는다
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].eq).toEqual(['github_installation_id', 111]);
    expect(updateCalls[0].in).toEqual(['id', ['bot-on-a']]);
    expect(updateCalls[0].in![1]).not.toContain('bot-on-b');
  });

  it('installation_repositories(removed) 도 마찬가지로 A 의 이벤트가 B 의 봇을 건드리지 않는다', async () => {
    const BOTS_ON_A: FakeRow[] = [{ id: 'bot-on-a', github_repo_url: 'https://github.com/o/shared-name', github_installation_lost_reason: null }];
    // B 에 «같은 레포 이름»을 쓰는 봇이 있어도(다른 설치이므로 실제로는 있을 수 없는 일이지만,
    // select 필터가 무너지면 이런 이름 충돌로 잘못 마크될 수 있다는 것을 확인한다)
    const BOTS_ON_B: FakeRow[] = [{ id: 'bot-on-b', github_repo_url: 'https://github.com/o/shared-name', github_installation_lost_reason: null }];
    const { db, updateCalls, selectEqCalls } = fakeMultiInstallationDb({ 111: BOTS_ON_A, 222: BOTS_ON_B });

    const payload: InstallationPayload = {
      action: 'removed',
      installation: { id: 111 },
      repositories_removed: [{ full_name: 'o/shared-name' }],
    };
    const out = await handleInstallationRepositoriesEvent(db, payload, NOW);

    expect(out).toMatchObject({ installationId: 111, affected: 1 });
    expect(selectEqCalls).toEqual([['github_installation_id', 111]]);
    expect(updateCalls[0].in).toEqual(['id', ['bot-on-a']]);
    expect(updateCalls[0].in![1]).not.toContain('bot-on-b');
  });
});

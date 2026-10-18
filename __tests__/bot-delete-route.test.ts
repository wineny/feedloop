import { beforeEach, describe, expect, it, vi } from 'vitest';

// DELETE /api/bots/[id] — 하드 삭제(I-25). 되돌릴 수 없는 한 줄이라 «어떤 조건에서 안 지우나»를 고정한다.
// 지워지는 범위(연쇄)는 DB 의 ON DELETE CASCADE 몫이라 여기서는 보지 않는다.

const { resolveOwnedBots, invalidateBotCache, removeBotShots, calls, results } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  removeBotShots: vi.fn(),
  invalidateBotCache: vi.fn(),
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
  results: [] as unknown[],
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/bot/core', () => ({ invalidateBotCache }));
vi.mock('@/lib/widget/shots', () => ({ removeBotShots, sweepBotShotPrefix: async () => {} }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const call = { table, methods: [] as [string, ...unknown[]][] };
      calls.push(call);
      const result = results.shift() ?? { data: null, count: 0, error: null };
      const query = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      } as Record<string, unknown>;
      for (const m of ['select', 'delete', 'eq', 'in']) {
        query[m] = (...args: unknown[]) => {
          call.methods.push([m, ...args]);
          return query;
        };
      }
      return query;
    },
  }),
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';

async function del() {
  const { DELETE } = await import('@/app/api/bots/[id]/route');
  const res = await DELETE(new Request(`https://feedloop.test/api/bots/${BOT_ID}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: BOT_ID }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; deleted?: boolean } };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  results.length = 0;
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: USER_ID, botIds: [BOT_ID] });
  removeBotShots.mockResolvedValue(true);
});

describe('DELETE /api/bots/[id]', () => {
  it('소유 검사 실패는 그 상태 그대로 돌려주고 DB 를 건드리지 않는다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: '해당 봇에 대한 권한이 없습니다' });
    const { status } = await del();
    expect(status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('수정 PR 이 진행 중이면 409 — 리스를 쥔 실행의 봇 행이 사라지면 GitHub 에 고아 PR 이 남는다', async () => {
    results.push({ count: 1, error: null });
    const { status, body } = await del();
    expect(status).toBe(409);
    expect(body.error).toContain('만드는 중');
    expect(calls[0].table).toBe('auto_dev_runs');
    expect(calls[0].methods).toContainEqual(['in', 'status', ['running', 'in_progress']]);
    // 삭제 쿼리는 나가지 않았다
    expect(calls.some((c) => c.table === 'bots')).toBe(false);
    expect(invalidateBotCache).not.toHaveBeenCalled();
  });

  it('진행 중 확인 자체가 실패하면 지우지 않는다(500)', async () => {
    results.push({ count: null, error: { message: 'db down' } });
    const { status } = await del();
    expect(status).toBe(500);
    expect(calls.some((c) => c.table === 'bots')).toBe(false);
  });

  it('지운다 — id 와 user_id 를 둘 다 걸고, 캐시를 비운다', async () => {
    results.push({ count: 0, error: null });
    results.push({ data: [{ id: BOT_ID }], error: null });
    const { status, body } = await del();
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: true });
    const botsCall = calls.find((c) => c.table === 'bots');
    expect(botsCall?.methods).toContainEqual(['delete']);
    expect(botsCall?.methods).toContainEqual(['eq', 'id', BOT_ID]);
    expect(botsCall?.methods).toContainEqual(['eq', 'user_id', USER_ID]);
    expect(invalidateBotCache).toHaveBeenCalledWith(BOT_ID);
  });

  it('0행이면 404 — 소유 검사 뒤 사라진 봇을 성공으로 보고하지 않는다', async () => {
    results.push({ count: 0, error: null });
    results.push({ data: [], error: null });
    const { status } = await del();
    expect(status).toBe(404);
    expect(invalidateBotCache).not.toHaveBeenCalled();
  });

  it('스크린샷 객체를 못 비우면 봇을 지우지 않는다(I-55) — CASCADE 뒤엔 경로를 잃는다', async () => {
    results.push({ count: 0, error: null });
    removeBotShots.mockResolvedValue(false);
    const { status } = await del();
    expect(status).toBe(500);
    expect(removeBotShots).toHaveBeenCalledWith(BOT_ID);
    expect(calls.some((c) => c.table === 'bots')).toBe(false);
  });

  it('스크린샷은 봇 행보다 «먼저» 지운다', async () => {
    let botsTouchedBeforeShots: boolean | null = null;
    removeBotShots.mockImplementation(async () => {
      botsTouchedBeforeShots = calls.some((c) => c.table === 'bots');
      return true;
    });
    results.push({ count: 0, error: null }, { data: [{ id: BOT_ID }], error: null });
    const { status } = await del();
    expect(status).toBe(200);
    expect(botsTouchedBeforeShots).toBe(false);
    expect(calls.some((c) => c.table === 'bots')).toBe(true);
  });
});

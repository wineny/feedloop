import { beforeEach, describe, expect, it, vi } from 'vitest';

// DELETE /api/bots/[id]/widget — 위젯 「연결 해제」(I-25) = widget_connected_at 만 비운다.
// 다른 컬럼·다른 테이블을 건드리지 않는 것이 이 라우트의 정의다.

const { resolveOwnedBots, calls, results } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
  results: [] as unknown[],
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const call = { table, methods: [] as [string, ...unknown[]][] };
      calls.push(call);
      const result = results.shift() ?? { data: null, error: null };
      const query = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      } as Record<string, unknown>;
      for (const m of ['select', 'update', 'eq', 'maybeSingle']) {
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

async function del() {
  const { DELETE } = await import('@/app/api/bots/[id]/widget/route');
  const res = await DELETE(new Request(`https://feedloop.test/api/bots/${BOT_ID}/widget`, { method: 'DELETE' }), {
    params: Promise.resolve({ id: BOT_ID }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  results.length = 0;
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'user-1', botIds: [BOT_ID] });
});

describe('DELETE /api/bots/[id]/widget', () => {
  it('남의 봇이면 403 그대로, DB 무접촉', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: 'no' });
    expect((await del()).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('widget_connected_at 만 null 로 — 대화·피드백·다른 연결은 그대로', async () => {
    results.push({ data: { id: BOT_ID }, error: null });
    const { status, body } = await del();
    expect(status).toBe(200);
    expect(body).toEqual({ widget_connected: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('bots');
    expect(calls[0].methods).toContainEqual(['update', { widget_connected_at: null }]);
    expect(calls[0].methods).toContainEqual(['eq', 'id', BOT_ID]);
  });

  it('행이 없으면 404', async () => {
    results.push({ data: null, error: null });
    expect((await del()).status).toBe(404);
  });
});

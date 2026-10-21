import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/bots feeds the header scope selector. Since 20261019_01 it lists approver bots too,
// and it must not hit the bots table at all when the user has nothing (an empty `.in()` would be
// a wasted query and, on some PostgREST versions, a 400).

const { getServerSession, listAccessibleBotIds, calls, results } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  listAccessibleBotIds: vi.fn(),
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
  results: [] as unknown[],
}));

vi.mock('next-auth', () => ({ getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/auth/ownership', () => ({ listAccessibleBotIds }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const call = { table, methods: [] as [string, ...unknown[]][] };
      calls.push(call);
      const result = results.shift() ?? { data: [], error: null };
      const query = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      } as Record<string, unknown>;
      for (const m of ['select', 'in', 'eq', 'order']) {
        query[m] = (...args: unknown[]) => {
          call.methods.push([m, ...args]);
          return query;
        };
      }
      return query;
    },
  }),
}));

async function get() {
  const { GET } = await import('@/app/api/bots/route');
  const res = await GET();
  return { status: res.status, body: (await res.json()) as { bots?: unknown[]; error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  results.length = 0;
  getServerSession.mockResolvedValue({ user: { id: 'judge-1' } });
});

describe('GET /api/bots', () => {
  it('401 when signed out, no lookups', async () => {
    getServerSession.mockResolvedValue(null);
    const { status } = await get();
    expect(status).toBe(401);
    expect(listAccessibleBotIds).not.toHaveBeenCalled();
  });

  it('returns an empty list without querying when the user has no bots', async () => {
    listAccessibleBotIds.mockResolvedValue([]);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ bots: [] });
    expect(calls).toHaveLength(0);
  });

  it('lists owned and approver bots by id, each saying is_owner, without the owner id', async () => {
    listAccessibleBotIds.mockResolvedValue(['bot-owned', 'bot-demo']);
    results.push({
      data: [
        { id: 'bot-owned', user_id: 'judge-1', service_name: 'Mine' },
        { id: 'bot-demo', user_id: 'someone-else', service_name: 'Feedloop' },
      ],
      error: null,
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.bots).toEqual([
      { id: 'bot-owned', service_name: 'Mine', is_owner: true },
      { id: 'bot-demo', service_name: 'Feedloop', is_owner: false },
    ]);
    expect(calls[0].table).toBe('bots');
    expect(calls[0].methods).toContainEqual(['in', 'id', ['bot-owned', 'bot-demo']]);
  });

  it('500 when the bots query fails', async () => {
    listAccessibleBotIds.mockResolvedValue(['bot-owned']);
    results.push({ data: null, error: { message: 'down' } });
    const { status } = await get();
    expect(status).toBe(500);
  });
});

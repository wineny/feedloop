import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/demo/join — the hackathon judge's first click. Pins down: login required, owner is a
// no-op, a member row is written exactly once per (bot, user), and a deployment without a seeded
// demo bot says so instead of 500-ing.

const { getServerSession, calls, results } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  calls: [] as { table: string; methods: [string, ...unknown[]][] }[],
  results: [] as unknown[],
}));

vi.mock('next-auth', () => ({ getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const call = { table, methods: [] as [string, ...unknown[]][] };
      calls.push(call);
      const result = results.shift() ?? { data: null, error: null };
      const query = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      } as Record<string, unknown>;
      for (const m of ['select', 'eq', 'maybeSingle', 'upsert']) {
        query[m] = (...args: unknown[]) => {
          call.methods.push([m, ...args]);
          return query;
        };
      }
      return query;
    },
  }),
}));

const DEMO_ID = '8cb62530-1c10-498f-b03d-8c51ad31d4c6';

async function post() {
  const { POST } = await import('@/app/api/demo/join/route');
  const res = await POST();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  results.length = 0;
  getServerSession.mockResolvedValue({ user: { id: 'judge-1' } });
});

describe('POST /api/demo/join', () => {
  it('rejects anonymous callers before touching the database', async () => {
    getServerSession.mockResolvedValue(null);
    const { status } = await post();
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('adds the signed-in user as an approver of the demo bot', async () => {
    results.push({ data: { id: DEMO_ID, user_id: 'owner-1', service_name: 'Feedloop' }, error: null });
    results.push({ error: null });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ botId: DEMO_ID, role: 'approver' });
    expect(calls[0].table).toBe('bots');
    expect(calls[0].methods).toContainEqual(['eq', 'is_demo', true]);
    expect(calls[1].table).toBe('bot_members');
    const upsert = calls[1].methods.find(([m]) => m === 'upsert');
    expect(upsert?.[1]).toEqual({ bot_id: DEMO_ID, user_id: 'judge-1', role: 'approver' });
    // second press must not fail on the primary key
    expect(upsert?.[2]).toMatchObject({ onConflict: 'bot_id,user_id', ignoreDuplicates: true });
  });

  it('is a no-op for the owner — no membership row for the account that already owns it', async () => {
    getServerSession.mockResolvedValue({ user: { id: 'owner-1' } });
    results.push({ data: { id: DEMO_ID, user_id: 'owner-1', service_name: 'Feedloop' }, error: null });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toMatchObject({ botId: DEMO_ID, role: 'owner' });
    expect(calls.map((c) => c.table)).toEqual(['bots']);
  });

  it('says 404 when this deployment has no demo bot yet', async () => {
    results.push({ data: null, error: null });
    const { status, body } = await post();
    expect(status).toBe(404);
    expect(String(body.error)).toMatch(/demo bot/i);
  });
});

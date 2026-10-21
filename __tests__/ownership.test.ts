import { beforeEach, describe, expect, it, vi } from 'vitest';

// Runs lib/auth/ownership.ts for real (only next-auth and supabase are faked). Route tests alias the
// helpers to one stub, so this is the only place that proves: anonymous → 401, non-member → 403,
// approver allowed by resolveAccessibleBots but refused by resolveOwnedBots, and no duplicate ids.

const { getServerSession, tables } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));

vi.mock('next-auth', () => ({ getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const query = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      } as Record<string, unknown>;
      for (const m of ['select', 'eq']) query[m] = () => query;
      return query;
    },
  }),
}));

const OWNED = 'bot-owned';
const MEMBER = 'bot-member';

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: { id: 'u1' } });
  tables.bots = { data: [{ id: OWNED }], error: null };
  tables.bot_members = { data: [{ bot_id: MEMBER }], error: null };
});

describe('resolveAccessibleBots', () => {
  it('401 when signed out', async () => {
    getServerSession.mockResolvedValue(null);
    const { resolveAccessibleBots } = await import('@/lib/auth/ownership');
    expect(await resolveAccessibleBots()).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });

  it('lists owned bots first, then approver bots, without duplicates', async () => {
    tables.bot_members = { data: [{ bot_id: MEMBER }, { bot_id: OWNED }], error: null };
    const { resolveAccessibleBots } = await import('@/lib/auth/ownership');
    expect(await resolveAccessibleBots()).toEqual({ ok: true, userId: 'u1', botIds: [OWNED, MEMBER] });
  });

  it('lets an approver into a bot they do not own, and says so (role)', async () => {
    const { resolveAccessibleBots } = await import('@/lib/auth/ownership');
    expect(await resolveAccessibleBots(MEMBER)).toEqual({ ok: true, userId: 'u1', botIds: [MEMBER], role: 'approver' });
    expect(await resolveAccessibleBots(OWNED)).toEqual({ ok: true, userId: 'u1', botIds: [OWNED], role: 'owner' });
  });

  it('a membership row for a bot the user also owns does not demote them', async () => {
    tables.bot_members = { data: [{ bot_id: OWNED }], error: null };
    const { resolveAccessibleBots, listAccessibleBots } = await import('@/lib/auth/ownership');
    expect(await resolveAccessibleBots(OWNED)).toMatchObject({ ok: true, role: 'owner' });
    expect(await listAccessibleBots('u1')).toEqual({ owned: [OWNED], approver: [] });
  });

  it('listAccessibleBots splits owned from approver-only ids', async () => {
    const { listAccessibleBots } = await import('@/lib/auth/ownership');
    expect(await listAccessibleBots('u1')).toEqual({ owned: [OWNED], approver: [MEMBER] });
  });

  it('403 for a bot the user neither owns nor approves', async () => {
    const { resolveAccessibleBots } = await import('@/lib/auth/ownership');
    const r = await resolveAccessibleBots('bot-stranger');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('throws instead of returning an empty list when a lookup fails', async () => {
    tables.bot_members = { data: null, error: { message: 'boom' } };
    const { listAccessibleBotIds } = await import('@/lib/auth/ownership');
    await expect(listAccessibleBotIds('u1')).rejects.toThrow(/bot_members lookup failed/);
  });
});

describe('resolveOwnedBots stays owner-only', () => {
  it('refuses an approver on a settings route', async () => {
    const { resolveOwnedBots } = await import('@/lib/auth/ownership');
    const r = await resolveOwnedBots(MEMBER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('still admits the owner', async () => {
    const { resolveOwnedBots } = await import('@/lib/auth/ownership');
    expect(await resolveOwnedBots(OWNED)).toEqual({ ok: true, userId: 'u1', botIds: [OWNED] });
  });
});

// No PR for a group made only of seeded sample history (scripts/seed-sample-history.ts):
// the auto-PR cron never picks one, and the manual [Make PR] route refuses with a 4xx.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const BOT_ID = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  /** Rows a list query (`await db.from(t)…`) returns, per table. */
  lists: {} as Record<string, unknown[]>,
  /** Row a single-row query returns, per table. */
  rows: {} as Record<string, unknown>,
  /** Tables whose list query fails. */
  failing: new Set<string>(),
  rpc: vi.fn(async () => ({ data: 'run-1', error: null })),
}));

vi.mock('next-auth', () => ({ getServerSession: async () => ({ user: { id: 'owner' } }) }));
vi.mock('@/app/api/auth/[...nextauth]/route', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc: h.rpc,
    from(table: string) {
      const row = h.rows[table] ?? null;
      const chain: Record<string, unknown> = {
        single: async () => ({ data: row, error: row ? null : { message: 'not found' } }),
        maybeSingle: async () => ({ data: row, error: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: any, reject: any) =>
          Promise.resolve(
            h.failing.has(table) ? { data: null, error: { message: `${table} down` } } : { data: h.lists[table] ?? [], error: null },
          ).then(resolve, reject),
      };
      const proxy: Record<string, unknown> = new Proxy(chain, { get: (t, k: string) => (k in t ? t[k] : () => proxy) });
      return proxy;
    },
  }),
}));

/** A group of two insights from two conversations; `kinds` sets each conversation's source/visitor id. */
function groupOf(kinds: { source: string; external_user_id: string }[]) {
  h.lists.insights = kinds.map((_, i) => ({ group_id: GROUP_ID, message_id: `m${i}` }));
  h.lists.messages = kinds.map((_, i) => ({ id: `m${i}`, conversation_id: `c${i}` }));
  h.lists.conversations = kinds.map((k, i) => ({ id: `c${i}`, contact_email: null, contact_phone: null, channel_person_id: null, ...k }));
}
const SAMPLE = { source: 'web', external_user_id: 'sample-visitor-01' };
const SAMPLE2 = { source: 'web', external_user_id: 'sample-visitor-02' };
const REAL = { source: 'web', external_user_id: '9b2f1c7e-real-visitor' };

beforeEach(() => {
  h.lists = {};
  h.rows = {};
  h.failing.clear();
  h.rpc.mockClear();
});

describe('auto-PR cron — sample-only groups are never picked', () => {
  async function candidates() {
    const { loadAutoPrCandidates } = await import('@/lib/auto-dev/auto-pr');
    h.lists.insight_groups = [{ id: GROUP_ID, status: 'open', category: 'bug', follow_up_pending: false, impact_core: null }];
    return loadAutoPrCandidates(BOT_ID);
  }

  it('all sample visitors on web → sampleOnly, and pickGroupForAutoPr skips it', async () => {
    groupOf([SAMPLE, SAMPLE2]);
    const list = await candidates();
    expect(list[0]).toMatchObject({ id: GROUP_ID, sampleOnly: true, distinctConversations: 2 });
    const { pickGroupForAutoPr, autoPrSkipReason } = await import('@/lib/auto-dev/auto-pr');
    expect(pickGroupForAutoPr(list)).toBeNull();
    expect(autoPrSkipReason(list)).toBe('no_eligible_group');
  });

  it('one real conversation joined → not sample, the group is eligible again', async () => {
    groupOf([SAMPLE, REAL]);
    const list = await candidates();
    expect(list[0].sampleOnly).toBe(false);
    const { pickGroupForAutoPr } = await import('@/lib/auto-dev/auto-pr');
    expect(pickGroupForAutoPr(list)?.id).toBe(GROUP_ID);
  });

  it('a sample- id on another source is not sample (only the seed writes web sample- visitors)', async () => {
    groupOf([{ source: 'telegram', external_user_id: 'sample-123' }, SAMPLE]);
    expect((await candidates())[0].sampleOnly).toBe(false);
  });
});

describe('POST /api/auto-dev — refuses a sample-only group', () => {
  async function post() {
    const { POST } = await import('@/app/api/auto-dev/route');
    h.rows.insight_groups = { id: GROUP_ID, bot_id: BOT_ID, status: 'open', category: 'bug', follow_up_pending: false };
    h.rows.bots = { id: BOT_ID, github_repo_url: 'https://github.com/o/r', user_id: 'owner' };
    return POST(new NextRequest('http://localhost/api/auto-dev', { method: 'POST', body: JSON.stringify({ groupId: GROUP_ID }) }));
  }

  it('all sample visitors → 400 with a clear message, no run created', async () => {
    groupOf([SAMPLE, SAMPLE2]);
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sample history/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('a real conversation in the group → the run is created as before', async () => {
    groupOf([SAMPLE, REAL]);
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).runId).toBe('run-1');
    expect(h.rpc).toHaveBeenCalledWith('create_pipeline_run', { p_bot_id: BOT_ID, p_group_id: GROUP_ID, p_insight_id: null });
  });

  it('the sample lookup fails → 500, never «not sample»', async () => {
    groupOf([SAMPLE, SAMPLE2]);
    h.failing.add('conversations');
    const res = await post();
    expect(res.status).toBe(500);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

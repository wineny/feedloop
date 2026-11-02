import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGroupTriage, normalizeTriage, TRIAGE_REASON_MAX } from '@/lib/groups/triage';

describe('normalizeTriage', () => {
  it('accepts the three verdicts, case and spacing tolerant', () => {
    expect(normalizeTriage('fix', 'broken')).toEqual({ triage: 'fix', triage_reason: 'broken' });
    expect(normalizeTriage(' Wont_Fix ')).toEqual({ triage: 'wont_fix' });
    expect(normalizeTriage('needs_decision', 'x')?.triage).toBe('needs_decision');
  });
  it('rejects anything else', () => {
    for (const bad of ['maybe', '', null, undefined, 3, {}, 'won\'t fix']) expect(normalizeTriage(bad, 'r')).toBeNull();
  });
  it('collapses the reason to one trimmed, capped line and omits it when empty', () => {
    expect(normalizeTriage('fix', 'a\n  b\t c')?.triage_reason).toBe('a b c');
    expect(normalizeTriage('fix', 'x'.repeat(TRIAGE_REASON_MAX + 50))?.triage_reason).toHaveLength(TRIAGE_REASON_MAX);
    expect(normalizeTriage('fix', '   ')).toEqual({ triage: 'fix' });
    expect(normalizeTriage('fix', 42)).toEqual({ triage: 'fix' });
  });
});

const db = vi.hoisted(() => ({
  updates: [] as { values: Record<string, unknown>; filters: [string, string, unknown][] }[],
  fail: null as null | 'error' | 'throw',
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const rec = { values, filters: [] as [string, string, unknown][] };
        db.updates.push(rec);
        expect(table).toBe('insight_groups');
        const chain = {
          eq: (col: string, v: unknown) => (rec.filters.push(['eq', col, v]), chain),
          is: (col: string, v: unknown) => (rec.filters.push(['is', col, v]), chain),
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            if (db.fail === 'throw') return Promise.reject(new Error('network')).then(resolve, reject);
            return Promise.resolve({ error: db.fail === 'error' ? { message: 'boom' } : null }).then(resolve, reject);
          },
        };
        return chain;
      },
    }),
  }),
}));

describe('applyGroupTriage', () => {
  beforeEach(() => {
    db.updates.length = 0;
    db.fail = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('pairs valid[i] with receipt.groups[i] and skips entries without a verdict', async () => {
    await applyGroupTriage(
      'bot-1',
      [{ triage: 'fix', triage_reason: 'broken checkout' }, {}, { triage: 'wont_fix' }],
      [{ id: 'g-a' }, { id: 'g-b' }, { id: 'g-c' }],
    );
    expect(db.updates.map((u) => [u.values, u.filters.find((f) => f[1] === 'id')?.[2]])).toEqual([
      [{ triage: 'fix', triage_reason: 'broken checkout' }, 'g-a'],
      [{ triage: 'wont_fix', triage_reason: null }, 'g-c'],
    ]);
    for (const u of db.updates) expect(u.filters).toContainEqual(['eq', 'bot_id', 'bot-1']);
  });

  it('writes nothing when the lengths differ', async () => {
    await applyGroupTriage('bot-1', [{ triage: 'fix' }, { triage: 'fix' }], [{ id: 'g-a' }]);
    expect(db.updates).toHaveLength(0);
  });

  it('only fills a group with no verdict yet, so joining an existing group never overwrites its verdict', async () => {
    await applyGroupTriage('bot-1', [{ triage: 'needs_decision', triage_reason: 'joined' }], [{ id: 'existing' }]);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].filters).toContainEqual(['is', 'triage', null]);
  });

  it('never throws when an update fails or errors, and keeps going', async () => {
    db.fail = 'error';
    await expect(applyGroupTriage('bot-1', [{ triage: 'fix' }, { triage: 'fix' }], [{ id: 'a' }, { id: 'b' }])).resolves.toBeUndefined();
    expect(db.updates).toHaveLength(2);
    db.fail = 'throw';
    await expect(applyGroupTriage('bot-1', [{ triage: 'fix' }], [{ id: 'a' }])).resolves.toBeUndefined();
  });
});

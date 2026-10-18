import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ many: false, merged: false }));
import { NextRequest } from 'next/server';
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('@/lib/bot/handler', () => ({ callLlm: vi.fn() }));
vi.mock('@/lib/auth/ownership', () => {
  // the groups list route now takes approvers too (resolveAccessibleBots); same stub for both
  const ok = async () => ({ ok: true, botIds: ['bot'] });
  return { resolveOwnedBots: ok, resolveAccessibleBots: ok };
});
vi.mock('@/lib/groups/auto-grouping', () => ({ catchUpAutoGrouping: async () => {}, readGroupingStatus: async () => null }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from(table: string) {
  const rows: Record<string, unknown[]> = {
    insight_groups: [
      { id: 'unknown', created_at: '2026-10-09', impact_core: null },
      { id: 'new', created_at: '2026-10-02', impact_core: false, impact_reason: '단순 불편' },
      { id: 'old', created_at: '2026-10-01', impact_core: false, impact_reason: '단순 불편' },
      { id: 'core', created_at: '2026-09-01', impact_core: true, impact_reason: '결제 차단' },
    ],
    insights: [
      { group_id: 'unknown', messages: { conversation_id: 'c1' } },
      { group_id: 'unknown', messages: [{ conversation_id: 'c2' }] },
      { group_id: 'new', messages: { conversation_id: 'c3' } },
      { group_id: 'new', messages: { conversation_id: 'c4' } },
      { group_id: 'old', messages: { conversation_id: 'c3' } },
      { group_id: 'old', messages: { conversation_id: 'c4' } },
    ],
    conversations: [{ id: 'c1', channel_person_id: 'person' }, { id: 'c2', channel_person_id: 'person' }, { id: 'c3', channel_person_id: null }, { id: 'c4', channel_person_id: null }],
    auto_dev_runs: [],
  };
  for (const row of rows.insight_groups as { id: string; status?: string }[]) {
    row.status = state.merged && row.id === 'core' ? 'merged' : 'open';
  }
  if (state.many) rows.insight_groups = Array.from({ length: 51 }, (_, i) => ({ id: `g${i}`, created_at: new Date(Date.UTC(2026, 9, 9) - i * 86400000).toISOString(), impact_core: i === 50, impact_reason: i === 50 ? '결제 차단' : '단순 불편' }));
  let range: [number, number] | null = null;
  const chain: Record<string, unknown> = {};
  chain.range = (start: number, end: number) => { range = [start, end]; return chain; };
  for (const op of ['select', 'eq', 'in', 'neq', 'order', 'limit']) chain[op] = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: range ? rows[table].slice(range[0], range[1] + 1) : rows[table], error: null });
  return chain;
} }) }));
import { GET } from '@/app/api/groups/route';
describe('GET /api/groups priority', () => {
  it('반영된 최고 점수 묶음을 열린 낮은 점수 묶음 뒤로 보낸다', async () => {
    state.merged = true;
    try {
      const response = await GET(new NextRequest('http://localhost/api/groups'));
      const { groups } = await response.json();
      expect(groups.map((g: { id: string }) => g.id)).toEqual(['new', 'old', 'unknown', 'core']);
      expect(groups[3]).toMatchObject({ status: 'merged', priority: { score: 20 } });
    } finally { state.merged = false; }
  });
  it('사람 중복을 접은 점수를 내리고 동점은 최신순으로 정렬한다', async () => {
    const response = await GET(new NextRequest('http://localhost/api/groups'));
    const { groups } = await response.json();
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['core', 'new', 'old', 'unknown']);
    expect(groups[0].priority).toEqual({ score: 20, core: true, reason: '결제 차단' });
    expect(groups[1]).toMatchObject({ conversationCount: 2, priority: { score: 8, core: false } });
    expect(groups[3]).toMatchObject({ conversationCount: 1, insightCount: 2, priority: { score: 5, core: null, reason: null } });
  });
});

it('51번째 묶음이 최고 점수면 반환 상위50에 포함한다', async () => {
  state.many = true;
  try {
    const response = await GET(new NextRequest('http://localhost/api/groups'));
    const { groups } = await response.json();
    expect(groups).toHaveLength(50);
    expect(groups[0]).toMatchObject({ id: 'g50', priority: { score: 20, core: true } });
  } finally { state.many = false; }
});

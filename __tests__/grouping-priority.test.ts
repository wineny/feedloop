import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ order: [] as string[], score: vi.fn(async () => { state.order.push('impact'); throw new Error('unavailable'); }) }));
vi.mock('@/lib/groups/priority', () => ({ scoreGroupImpact: state.score }));
vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB: async () => ({ botId: 'bot' }) }));
vi.mock('@/lib/bot/handler', () => ({ callLlm: async () => JSON.stringify({ groups: [{ existing_group_id: 'g', title: '결제 실패', summary: '오류', category: 'bug', insight_ids: ['i'] }] }) }));
vi.mock('@/lib/groups/existing-match', () => ({
  EXISTING_GROUPS_LIMIT: 50,
  matchOutcome: () => 'join',
  closeLoopForRejoins: async () => { state.order.push('closeLoop'); return { delivered: 1, failures: [], skippedDeadline: 0 }; },
}));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({
  from: () => {
    const chain: Record<string, unknown> = {};
    for (const op of ['select', 'eq', 'is', 'not', 'order', 'limit']) chain[op] = () => chain;
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return chain;
  },
  rpc: async (name: string) => ({ error: null, data: name === 'pipeline_group_snapshot'
    ? { revision: 1, insights: [{ id: 'i', category: 'bug', summary: '오류' }], existing: [{ id: 'g', category: 'bug', status: 'merged' }], pending: 1 }
    : { grouped: 1, groups: [{ id: 'g', title: '결제 실패', count: 1 }] } }),
}) }));
import { runGrouping } from '@/lib/groups/grouping';
it('묶기와 되돌림을 끝낸 뒤 임팩트가 실패해도 묶기는 성공이다', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await runGrouping(['bot']);
  expect(state.order).toEqual(['closeLoop', 'impact']);
  expect(result).toMatchObject({ grouped: 1, failures: [], loopClosed: 1 });
  expect(state.score).toHaveBeenCalledWith('bot', { botId: 'bot' }, expect.objectContaining({ apply: true, groupIds: ['g'] }));
  expect(warn).toHaveBeenCalledWith('[grouping] impact scoring failed');
  warn.mockRestore();
});

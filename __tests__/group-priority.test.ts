import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '@/lib/bot/handler';
import { getDemoData } from '@/lib/demo/mock-data';
const state = vi.hoisted(() => ({ llm: vi.fn(), updates: vi.fn(), filters: [] as unknown[][], rows: [] as unknown[], error: null as { message: string } | null }));
vi.mock('@/lib/bot/handler', () => ({ callLlm: state.llm }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: () => {
  const chain: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range']) chain[op] = (...args: unknown[]) => { state.filters.push([op, ...args]); return chain; };
  chain.update = (value: unknown) => { state.updates(value); return chain; };
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: state.rows, error: state.error });
  return chain;
} }) }));
import { compareGroupPriority, groupPriority, judgeGroupImpact, scoreGroupImpact } from '@/lib/groups/priority';
const config = { id: 'bot', llmKeyFailedAt: '2026-10-01' } as unknown as BotConfig;
const groups = [{ id: 'g1', title: '결제 실패', summary: '결제 화면 오류', insights: [{ summary: '결제 진행 불가' }] }];
beforeEach(() => { vi.clearAllMocks(); state.filters = []; state.rows = groups; state.error = null; state.llm.mockResolvedValue('{"groups":[{"id":"g1","core":true,"reason":"결제가 막혀 구매를 완료하지 못함"}]}'); });
describe('group priority', () => {
  it('사람×3+건수+핵심20, 미판정은 빈도만 계산한다', () => {
    expect(groupPriority(2, 5, true, '결제 차단')).toEqual({ score: 31, core: true, reason: '결제 차단' });
    expect(groupPriority(2, 5)).toEqual({ score: 11, core: null, reason: null });
    expect(groupPriority(2, 5, false, '단순 불편')).toEqual({ score: 11, core: false, reason: '단순 불편' });
  });
  it('점수 내림차순, 동점은 최신순이다', () => {
    const rows = [
      { status: 'open', priority: groupPriority(1, 1), createdAt: '2026-10-01' },
      { status: 'pr_created', priority: groupPriority(1, 1), createdAt: '2026-10-02' },
      { status: 'open', priority: groupPriority(1, 1, true), createdAt: '2026-09-01' },
    ];
    expect(rows.sort(compareGroupPriority).map((r) => r.createdAt)).toEqual(['2026-09-01', '2026-10-02', '2026-10-01']);
  });
  it('반영된 높은 점수는 열린 낮은 점수보다 뒤로 가고 반영된 묶음끼리도 점수·최신순이다', () => {
    const rows = [
      { id: 'merged-old', status: 'merged', priority: groupPriority(1, 1, true), createdAt: '2026-10-01' },
      { id: 'open', status: 'open', priority: groupPriority(1, 1), createdAt: '2026-09-01' },
      { id: 'merged-low', status: 'merged', priority: groupPriority(1, 1), createdAt: '2026-10-03' },
      { id: 'merged-new', status: 'merged', priority: groupPriority(1, 1, true), createdAt: '2026-10-02' },
      { id: 'pr', status: 'pr_created', priority: groupPriority(1, 2), createdAt: '2026-09-01' },
    ];
    expect(rows.sort(compareGroupPriority).map((r) => r.id)).toEqual(['pr', 'open', 'merged-new', 'merged-old', 'merged-low']);
  });
  it('데모 목록도 열린 묶음 다음에 반영된 높은 점수 묶음을 보여준다', () => {
    const { groups } = getDemoData('en').dashboard as { groups: { id: string; status: string }[] };
    expect(groups.map((g) => g.id)).toEqual(['demo-group-2', 'demo-group-1']);
    expect(groups[1].status).toBe('merged');
  });
  it('같은 config로 배치 판정하고 제한된 대표 근거를 전달한다', async () => {
    const result = await judgeGroupImpact(config, groups);
    expect(result[0]).toMatchObject({ id: 'g1', core: true });
    expect(state.llm.mock.calls[0][0]).toBe(config);
    expect(state.llm.mock.calls[0][2]).toContain('결제 진행 불가');
    expect(state.llm.mock.calls[0][3]).toMatchObject({ recordKeyFailure: false });
  });
  it.each(['{"groups":[]}', '{"groups":[{"id":"foreign","core":true,"reason":"차단"}]}', '{"groups":[{"id":"g1","core":"true","reason":"차단"}]}', 'not json'])('잘못된 판단을 저장하지 않는다: %s', async (raw) => {
    state.llm.mockResolvedValue(raw);
    await expect(scoreGroupImpact('bot', config, { apply: true })).rejects.toThrow();
    expect(state.updates).not.toHaveBeenCalled();
  });
  it('배치 일부가 누락된 응답은 성공으로 받지 않는다', async () => {
    await expect(judgeGroupImpact(config, [...groups, { ...groups[0], id: 'g2' }])).rejects.toThrow('incomplete_impact_response');
  });
  it('기본 dry-run은 저장하지 않고 NULL 묶음만 읽는다', async () => {
    expect(await scoreGroupImpact('bot', config)).toHaveLength(1);
    expect(state.updates).not.toHaveBeenCalled();
    expect(state.llm.mock.calls[0][0].llmKeyFailedAt).toBeNull();
    expect(config.llmKeyFailedAt).toBe('2026-10-01');
    expect(state.filters).toContainEqual(['is', 'impact_core', null]);
    expect(state.filters).toContainEqual(['eq', 'bot_id', 'bot']);
  });
  it('apply도 저장 시 NULL 조건과 봇 범위를 다시 확인한다', async () => {
    await scoreGroupImpact('bot', config, { apply: true, groupIds: ['g1'] });
    expect(state.filters).toContainEqual(['in', 'id', ['g1']]);
    expect(state.filters.filter((f) => f[0] === 'is')).toHaveLength(2);
    expect(state.updates).toHaveBeenCalledWith({ impact_core: true, impact_reason: '결제가 막혀 구매를 완료하지 못함', impact_scored_at: expect.any(String) });
  });
  it('기한이 지났거나 갱신된 묶음이 없으면 모델을 호출하지 않는다', async () => {
    expect(await scoreGroupImpact('bot', config, { groupIds: [] })).toEqual([]);
    expect(await scoreGroupImpact('bot', config, { deadlineMs: Date.now() - 1 })).toEqual([]);
    expect(state.llm).not.toHaveBeenCalled();
  });
});

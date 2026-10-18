import { describe, it, expect, vi, beforeEach } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ rpc }) }));
import { applyInsightWrite, planInsightWrite } from '@/lib/bot/db';
const insight = { category: 'bug', summary: '쿠폰함 흰 화면', sentiment: 'negative' };
beforeEach(() => { rpc.mockReset().mockResolvedValue({ data: { id: 'i1', created: false }, error: null }); });
describe('atomic issue membership writes', () => {
  it('marks chip/no-insight skip done atomically', async () => {
    await applyInsightWrite('b1', 'm1', insight, false, { action: 'skip' });
    expect(rpc).toHaveBeenCalledWith('pipeline_settle_insight', expect.objectContaining({ p_insight: null, p_message_id: 'm1' }));
  });
  it('normalizes and scopes insertion', async () => {
    await applyInsightWrite('b1', 'm1', { ...insight, category: 'Bug', sentiment: '화남' }, true, { action: 'insert' });
    expect(rpc).toHaveBeenCalledWith('pipeline_settle_insight', {
      p_bot_id: 'b1', p_message_id: 'm1', p_extend_id: null,
      p_insight: { ...insight, sentiment: 'neutral', follow_up_needed: true },
    });
  });
  it('extension and fallback happen in the same DB transaction', async () => {
    await applyInsightWrite('b1', 'm2', insight, false, { action: 'update', id: 'i1' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('pipeline_settle_insight', expect.objectContaining({ p_extend_id: 'i1' }));
  });
  it('failed atomic write throws for durable recovery, never falls back to unsafe insert', async () => {
    rpc.mockResolvedValue({ error: { message: 'db unavailable' } });
    await expect(applyInsightWrite('b1', 'm1', insight, false, { action: 'insert' })).rejects.toThrow('insight_persistence_failed');
    expect(rpc).toHaveBeenCalledOnce();
  });
  it('unsaved message cannot generate an orphan insight', async () => {
    await expect(applyInsightWrite('b1', null, insight, false, { action: 'insert' })).rejects.toThrow('message_not_saved');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('source-only supplements', () => {
  const refMap = new Map([['ab12cd34', { id: 'i1' }]]);
  it('known null-insight ref attaches provenance without fabricated metadata', async () => {
    const plan = planInsightWrite({ insight: null, extends: ' AB12CD34 ', refMap });
    expect(plan).toEqual({ action: 'update', id: 'i1', sourceOnly: true });
    await applyInsightWrite('b1', 'm2', null, true, plan);
    expect(rpc).toHaveBeenCalledWith('pipeline_settle_insight', { p_bot_id: 'b1', p_message_id: 'm2', p_insight: null, p_extend_id: 'i1' });
  });
  it('chip and unknown null-insight refs never attach', () => {
    expect(planInsightWrite({ insight: null, extends: 'ab12cd34', refMap, chipOnly: true })).toEqual({ action: 'skip' });
    expect(planInsightWrite({ insight: null, extends: 'deadbeef', refMap })).toEqual({ action: 'skip' });
  });
});

describe('courtesy-only source attachment guard', () => {
  const refMap = new Map([['ab12cd34', { id: 'i1' }]]);
  it.each(['네 고마워요', '네, 고마워요!', ' 감사합니다. ', '네', '맞아요'])('does not attach %s', async text => {
    const plan = planInsightWrite({ insight: null, extends: 'ab12cd34', refMap, text });
    expect(plan).toEqual({ action: 'skip' });
    await applyInsightWrite('b1', 'm2', null, false, plan);
    expect(rpc).toHaveBeenCalledWith('pipeline_settle_insight', expect.objectContaining({ p_insight: null, p_extend_id: null }));
  });
  it.each(['네, PC 크롬이에요', '고마워요. 그런데 아직 흰 화면이에요', '알겠습니다만 모바일에서도 그래요', 'PC 크롬 최신버전이고 시크릿 모드에서도 같아요'])('retains substantive reply %s', text => {
    expect(planInsightWrite({ insight: null, extends: 'ab12cd34', refMap, text })).toEqual({ action: 'update', id: 'i1', sourceOnly: true });
  });
  it('preserves semantic praise classification', () => {
    expect(planInsightWrite({ insight: { category: 'praise', summary: '감사', sentiment: 'positive' }, extends: 'ab12cd34', refMap, text: '감사합니다' })).toEqual({ action: 'update', id: 'i1' });
  });
});

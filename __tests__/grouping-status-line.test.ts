import { describe, it, expect } from 'vitest';
import { groupingStatusMessage } from '@/components/groups/GroupingStatusLine';

// 상태줄 판정(I-12). 「기다리는 중」이면 화면이 계속 다시 읽고, 아니면 멈춘다 — 그 판정이 핵심이다.
// 문구는 사전(`dashboard.grouping.<key>`)이 쓰므로 여기서는 키와 인자만 본다.
describe('groupingStatusMessage', () => {
  const now = Date.parse('2026-09-16T10:00:00Z');

  it('안 묶인 게 없으면 기다리지 않는다', () => {
    expect(groupingStatusMessage({ pending: 0, dueAt: null, running: false, lastGroupedAt: null }, now)).toEqual({
      key: 'none',
      vars: { count: 0 },
      waiting: false,
    });
  });

  it('잠금이 살아 있으면 「묶는 중」', () => {
    const r = groupingStatusMessage({ pending: 2, dueAt: null, running: true, lastGroupedAt: null }, now);
    expect(r).toEqual({ key: 'running', vars: { count: 2 }, waiting: true });
  });

  it('예정이 앞이면 남은 초를 5초 단위로 말한다', () => {
    const r = groupingStatusMessage({ pending: 2, dueAt: new Date(now + 47_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(r).toEqual({ key: 'due', vars: { count: 2, secs: 45 }, waiting: true });
  });

  it('예정이 막 지났으면(30초 안) 「곧」 — 대기하던 함수가 깨어나는 찰나다', () => {
    const r = groupingStatusMessage({ pending: 2, dueAt: new Date(now - 5_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(r).toEqual({ key: 'soon', vars: { count: 2 }, waiting: true });
  });

  it('예정이 오래 지났거나 없으면 기다리지 않는다 — 버튼이 답이다', () => {
    const stale = groupingStatusMessage({ pending: 2, dueAt: new Date(now - 60_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(stale).toEqual({ key: 'idle', vars: { count: 2 }, waiting: false });
    const none = groupingStatusMessage({ pending: 1, dueAt: null, running: false, lastGroupedAt: null }, now);
    expect(none.waiting).toBe(false);
  });
});

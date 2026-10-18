import { describe, it, expect } from 'vitest';
import { describeGroupingStatus } from '@/components/groups/GroupingStatusLine';

// 상태줄 문구(I-12). 「기다리는 중」이면 화면이 계속 다시 읽고, 아니면 멈춘다 — 그 판정이 핵심이다.
describe('describeGroupingStatus', () => {
  const now = Date.parse('2026-09-16T10:00:00Z');

  it('안 묶인 게 없으면 기다리지 않는다', () => {
    expect(describeGroupingStatus({ pending: 0, dueAt: null, running: false, lastGroupedAt: null }, now)).toEqual({
      text: '안 묶인 피드백이 없어요',
      waiting: false,
    });
  });

  it('잠금이 살아 있으면 「묶는 중」', () => {
    const r = describeGroupingStatus({ pending: 2, dueAt: null, running: true, lastGroupedAt: null }, now);
    expect(r.text).toContain('지금 묶는 중');
    expect(r.waiting).toBe(true);
  });

  it('예정이 앞이면 남은 초를 5초 단위로 말한다', () => {
    const r = describeGroupingStatus({ pending: 2, dueAt: new Date(now + 47_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(r.text).toContain('약 45초 뒤');
    expect(r.waiting).toBe(true);
  });

  it('예정이 막 지났으면(30초 안) 「곧」 — 대기하던 함수가 깨어나는 찰나다', () => {
    const r = describeGroupingStatus({ pending: 2, dueAt: new Date(now - 5_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(r.text).toContain('곧 묶어요');
    expect(r.waiting).toBe(true);
  });

  it('예정이 오래 지났거나 없으면 기다리지 않는다 — 버튼이 답이다', () => {
    const stale = describeGroupingStatus({ pending: 2, dueAt: new Date(now - 60_000).toISOString(), running: false, lastGroupedAt: null }, now);
    expect(stale).toEqual({ text: '2건이 아직 안 묶였어요', waiting: false });
    const none = describeGroupingStatus({ pending: 1, dueAt: null, running: false, lastGroupedAt: null }, now);
    expect(none.waiting).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { STOP_REASON_LABEL, stopReasonLabel } from '@/lib/auto-dev/stop-reason-labels';

describe('stopReasonLabel — 중단 사유 코드를 화면용 한국어로 (I-24)', () => {
  it('엔진이 남기는 정직 중단 코드 4종은 전부 사전에 있다', () => {
    for (const code of ['root_cause_unknown', 'insufficient_evidence', 'budget_exhausted', 'no_change']) {
      expect(STOP_REASON_LABEL[code]).toBeTruthy();
      expect(stopReasonLabel(code)).not.toBe(code);
    }
  });
  it('모르는 코드는 숨기지 않고 그대로 보여 준다', () => {
    expect(stopReasonLabel('something_new')).toBe('something_new');
    expect(stopReasonLabel(null)).toBe('');
    expect(stopReasonLabel(undefined)).toBe('');
  });
});

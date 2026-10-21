import { describe, it, expect } from 'vitest';
import { STOP_REASON_CODES, stopReasonLabel } from '@/lib/auto-dev/stop-reason-labels';
import { translator } from './helpers/intl';

describe('stopReasonLabel — 중단 사유 코드를 화면용 문구로 (I-24)', () => {
  it.each(['en', 'ko'] as const)('엔진이 남기는 중단 코드는 전부 %s 사전에 있다', (locale) => {
    const t = translator('monitor', locale);
    for (const code of STOP_REASON_CODES) {
      expect(t.has(`stopReason.${code}`)).toBe(true);
      expect(stopReasonLabel(t, code)).not.toBe(code);
    }
  });
  it('정직 중단 코드 4종이 목록에 있다', () => {
    for (const code of ['root_cause_unknown', 'insufficient_evidence', 'budget_exhausted', 'no_change']) {
      expect(STOP_REASON_CODES).toContain(code);
    }
  });
  it('모르는 코드는 숨기지 않고 그대로 보여 준다', () => {
    const t = translator('monitor');
    expect(stopReasonLabel(t, 'something_new')).toBe('something_new');
    expect(stopReasonLabel(t, null)).toBe('');
    expect(stopReasonLabel(t, undefined)).toBe('');
  });
});

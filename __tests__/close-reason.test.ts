import { describe, it, expect } from 'vitest';
import { parseCloseReasonPatch, CLOSE_REASONS, CLOSE_NOTE_MAX } from '@/lib/auto-dev/close-reason';
import { translator } from './helpers/intl';

describe('parseCloseReasonPatch', () => {
  it('사유 5종 전부 라벨이 있고 통과한다', () => {
    for (const r of CLOSE_REASONS) {
      // 화면 라벨·설명은 사전에 있다(en·ko 둘 다)
      for (const locale of ['en', 'ko'] as const) {
        const t = translator('monitor.closeReason', locale);
        expect(t(`${r}.label`)).toBeTruthy();
        expect(t(`${r}.hint`)).toBeTruthy();
      }
      expect(parseCloseReasonPatch({ close_reason: r })).toEqual({ ok: true, close_reason: r, close_note: null });
    }
  });

  it('null 은 미분류로 되돌림이고 메모도 같이 지운다', () => {
    expect(parseCloseReasonPatch({ close_reason: null, close_note: '남은 메모' })).toEqual({
      ok: true, close_reason: null, close_note: null,
    });
  });

  it('메모는 trim 되고 빈 문자열은 null', () => {
    expect(parseCloseReasonPatch({ close_reason: 'duplicate', close_note: '  중복  ' })).toEqual({
      ok: true, close_reason: 'duplicate', close_note: '중복',
    });
    expect(parseCloseReasonPatch({ close_reason: 'duplicate', close_note: '   ' })).toEqual({
      ok: true, close_reason: 'duplicate', close_note: null,
    });
  });

  it('모르는 사유·누락·긴 메모·비객체는 거절한다', () => {
    expect(parseCloseReasonPatch({ close_reason: 'bogus' }).ok).toBe(false);
    expect(parseCloseReasonPatch({}).ok).toBe(false);
    expect(parseCloseReasonPatch({ close_reason: 'other', close_note: 'x'.repeat(CLOSE_NOTE_MAX + 1) }).ok).toBe(false);
    expect(parseCloseReasonPatch({ close_reason: 'other', close_note: 42 }).ok).toBe(false);
    expect(parseCloseReasonPatch(null).ok).toBe(false);
    expect(parseCloseReasonPatch('duplicate').ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  confirmationRates,
  formatRate,
  FAILED_CONFIRMATION,
  type ConfirmationStats,
} from '@/lib/dashboard/confirmation';

/** 비율 계산은 `state` 를 보지 않는다 — 숫자만 받는다는 걸 이 헬퍼가 드러낸다. */
const stats = (fixed: number, notFixed: number, delivered: number): ConfirmationStats => ({
  state: fixed + notFixed + delivered === 0 ? 'empty' : 'ok',
  fixed,
  notFixed,
  delivered,
});

describe('되돌림 확인 비율 — 두 비율의 분모가 다르다', () => {
  it('「잘 돼요」 비율의 분모는 답한 건수, 응답률의 분모는 보낸 건수다', () => {
    expect(confirmationRates(stats(3, 1, 8))).toEqual({
      answered: 4,
      fixedRate: 0.75,
      responseRate: 0.5,
    });
  });

  it('답이 하나도 없으면 「잘 돼요」 비율은 0% 가 아니라 없음이다', () => {
    expect(confirmationRates(stats(0, 0, 5))).toEqual({
      answered: 0,
      fixedRate: null,
      responseRate: 0,
    });
  });

  it('보낸 되돌림이 없으면 응답률도 없음이다 — 0% 는 「아무도 답 안 했다」로 읽힌다', () => {
    expect(confirmationRates(stats(0, 0, 0))).toEqual({
      answered: 0,
      fixedRate: null,
      responseRate: null,
    });
  });

  it('통계가 아직 없으면(undefined) 표본 0 으로 본다', () => {
    expect(confirmationRates(undefined)).toEqual({ answered: 0, fixedRate: null, responseRate: null });
  });

  it('전부 「아직 그대로예요」면 0% 다 — 없음과 구분된다', () => {
    const rates = confirmationRates(stats(0, 2, 2));
    expect(rates.fixedRate).toBe(0);
    expect(rates.responseRate).toBe(1);
  });

  it('답이 보낸 것보다 많아도 응답률을 100% 넘겨 그리지 않는다', () => {
    expect(confirmationRates(stats(5, 0, 2)).responseRate).toBe(1);
  });

  it('집계를 못 읽었으면 비율이 없다 — 0% 로 그리면 「아무도 답 안 했다」로 읽힌다', () => {
    expect(FAILED_CONFIRMATION.state).toBe('error');
    expect(confirmationRates(FAILED_CONFIRMATION)).toEqual({
      answered: 0,
      fixedRate: null,
      responseRate: null,
    });
  });

  it('비율은 정수 퍼센트로만 말한다', () => {
    expect(formatRate(2 / 3)).toBe('67%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
  });
});

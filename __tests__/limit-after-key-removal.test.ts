import { describe, it, expect } from 'vitest';
import { DEFAULT_LIMITS, limitAfterKeyRemoval } from '@/lib/llm/limits';

// 키 제거 확인 문구 「무료 하루 100건으로 돌아가요」가 고정 숫자였다(I-26). 상한 예외 봇(데모 2000)은
// 키를 빼도 예외가 이기므로 그 숫자가 거짓말이 된다 — 문구가 이 함수 값을 쓴다.

describe('limitAfterKeyRemoval — 키를 빼면 돌아갈 상한 (I-26)', () => {
  it('예외가 없으면 키 없음 무료분이다 (키 있음=한도 없음(null) 상태에서 빼는 보통 경우)', () => {
    expect(limitAfterKeyRemoval({ dailyLimit: null, dailyLimitOverridden: false })).toBe(DEFAULT_LIMITS.noKey);
    expect(limitAfterKeyRemoval({ dailyLimit: 100, dailyLimitOverridden: false })).toBe(DEFAULT_LIMITS.noKey);
  });

  it('상한 예외가 걸린 봇은 예외 값으로 돌아간다 — 100 이라고 말하면 거짓말', () => {
    expect(limitAfterKeyRemoval({ dailyLimit: 2000, dailyLimitOverridden: true })).toBe(2000);
    expect(limitAfterKeyRemoval({ dailyLimit: 0, dailyLimitOverridden: true })).toBe(0);
  });

  it('예외 표시는 있는데 값이 없는(있을 수 없는) 조합은 무료분으로 떨어진다 — 화면이 「건」 없이 깨지지 않게', () => {
    expect(limitAfterKeyRemoval({ dailyLimit: null, dailyLimitOverridden: true })).toBe(DEFAULT_LIMITS.noKey);
  });
});

import { describe, it, expect } from 'vitest';
import { pickLocale } from '@/i18n/pick-locale';

describe('pickLocale', () => {
  it('쿠키가 있으면 Accept-Language 보다 우선한다', () => {
    expect(pickLocale('en', 'ko-KR,ko;q=0.9')).toBe('en');
    expect(pickLocale('ko', 'en-US')).toBe('ko');
  });
  it('Accept-Language ko-KR,ko;q=0.9 → ko', () => {
    expect(pickLocale(undefined, 'ko-KR,ko;q=0.9')).toBe('ko');
  });
  it('q 값이 높은 지원 언어를 고른다', () => {
    expect(pickLocale(undefined, 'fr,ko;q=0.5,en;q=0.8')).toBe('en');
  });
  it('모르는 언어·잘못된 쿠키·헤더 없음 → en', () => {
    expect(pickLocale(undefined, 'fr-FR,de;q=0.8')).toBe('en');
    expect(pickLocale('fr', undefined)).toBe('en');
    expect(pickLocale(null, null)).toBe('en');
  });
});

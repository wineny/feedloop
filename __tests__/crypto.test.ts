import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isKeyUsable, CryptoKeyError } from '@/lib/utils/crypto';

// 64자 hex = 32바이트. aes-256-gcm 이 요구하는 유일한 형식이다.
const GOOD_KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

// 2026-09-05 프로덕션에 실제로 들어 있던 형태: 32자, hex 아님.
const PROD_BROKEN_KEY = 'x'.repeat(32);

describe('crypto', () => {
  it('암호화한 값을 같은 키로 되돌린다', () => {
    const plaintext = '1234567890:AAF-telegram-bot-token-example';
    expect(decrypt(encrypt(plaintext, GOOD_KEY), GOOD_KEY)).toBe(plaintext);
  });

  it('iv:authTag:ciphertext 3파트 hex 형식으로 출력한다', () => {
    const parts = encrypt('hello', GOOD_KEY).split(':');
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p).toMatch(/^[0-9a-f]+$/);
  });

  it('같은 평문이라도 매번 다른 암호문이 된다 (iv 가 랜덤)', () => {
    expect(encrypt('hello', GOOD_KEY)).not.toBe(encrypt('hello', GOOD_KEY));
  });

  it('키 형식이 틀리면 조용히 빈 문자열을 주지 않고 던진다', () => {
    // 이 조용한 실패가 프로덕션 장애를 5개월간 숨겼다.
    expect(() => encrypt('hello', PROD_BROKEN_KEY)).toThrow(CryptoKeyError);
    expect(() => decrypt('a:b:c', PROD_BROKEN_KEY)).toThrow(CryptoKeyError);
  });

  it('다른 키로 복호화하면 던지지 않고 빈 문자열을 준다 (암호문 문제)', () => {
    expect(decrypt(encrypt('hello', GOOD_KEY), OTHER_KEY)).toBe('');
  });

  it('빈 입력은 빈 문자열이다', () => {
    expect(decrypt('', GOOD_KEY)).toBe('');
  });

  it('평문이 그대로 들어와도 (암호화 안 된 값) 빈 문자열을 준다', () => {
    // 실제 bots 행에 "kakao-..." 같은 평문 placeholder 가 들어 있었다.
    expect(decrypt('kakao-no-token', GOOD_KEY)).toBe('');
  });

  it('isKeyUsable 이 키 형식을 판별한다', () => {
    expect(isKeyUsable(GOOD_KEY)).toBe(true);
    expect(isKeyUsable(PROD_BROKEN_KEY)).toBe(false);
    expect(isKeyUsable('')).toBe(false);
  });
});

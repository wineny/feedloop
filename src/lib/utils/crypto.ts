// AES-256-GCM 암호화/복호화
// telegram-interviewer/crypto.mjs와 동일한 형식: iv:authTag:ciphertext (hex)
// 양쪽이 같은 AES_KEY를 사용하면 서로의 암호문을 복호화할 수 있음.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const AES_KEY = process.env.AES_KEY || process.env.BOT_TOKEN_ENCRYPTION_KEY || '';

/** 키 설정 오류임을 호출부가 암호문 손상과 구분할 수 있게 하는 전용 에러. */
export class CryptoKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoKeyError';
  }
}

/**
 * 키를 32바이트로 해석한다. 형식이 틀리면 조용히 넘어가지 않고 던진다.
 *
 * 2026-09-05: 프로덕션 키가 hex 가 아닌 32자 문자열이라 Buffer.from(key,'hex') 이
 * 0바이트를 만들었고, createCipheriv 가 던진 걸 decrypt 의 catch 가 빈 문자열로
 * 삼켜서 "토큰이 비었다"로만 보였다. 그 경로를 막는다.
 */
function resolveKey(keyHex?: string): Buffer {
  const raw = keyHex || AES_KEY;
  if (!raw) {
    throw new CryptoKeyError(
      'AES key is not set. Define BOT_TOKEN_ENCRYPTION_KEY (or AES_KEY) as 64 hex chars.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    // 값 자체는 절대 로그에 남기지 않는다.
    throw new CryptoKeyError(
      `AES key must be 64 hex chars (32 bytes); got ${raw.length} chars that are not valid hex. ` +
        'Regenerate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(raw, 'hex');
}

export function encrypt(plaintext: string, keyHex?: string): string {
  const key = resolveKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encryptedStr: string, keyHex?: string): string {
  if (!encryptedStr) return '';

  // 키 문제는 설정 버그다 — 삼키면 안 된다. 암호문 문제만 빈 문자열로 돌려준다.
  const key = resolveKey(keyHex);

  try {
    const [ivHex, authTagHex, cipherHex] = encryptedStr.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  } catch (error) {
    console.error('Decryption failed (ciphertext not readable with current key):', error);
    return '';
  }
}

/** 키가 쓸 수 있는 형식인지 확인한다 (헬스체크·기동 점검용). */
export function isKeyUsable(keyHex?: string): boolean {
  try {
    resolveKey(keyHex);
    return true;
  } catch {
    return false;
  }
}

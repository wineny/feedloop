import { describe, it, expect } from 'vitest';
import { encrypt } from '@/lib/utils/crypto';
import {
  generateWebhookToken,
  isWebhookTokenShape,
  matchesWebhookToken,
  matchesChannelId,
  matchesVerifyToken,
} from '@/lib/channel/verify';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('generateWebhookToken · isWebhookTokenShape', () => {
  it('URL 세그먼트로 안전한 문자만 낸다', () => {
    for (let i = 0; i < 20; i += 1) {
      const t = generateWebhookToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(isWebhookTokenShape(t)).toBe(true);
    }
  });

  it('매번 다른 값이다', () => {
    expect(generateWebhookToken()).not.toBe(generateWebhookToken());
  });

  it('형식이 아닌 값은 거른다', () => {
    for (const bad of ['', 'short', '../../etc/passwd', 'has spaces', 'a'.repeat(200), null, 42]) {
      expect(isWebhookTokenShape(bad)).toBe(false);
    }
  });
});

describe('matchesWebhookToken', () => {
  it('그 봇의 토큰이면 통과한다', () => {
    const token = generateWebhookToken();
    expect(matchesWebhookToken(token, encrypt(token, KEY), KEY)).toBe(true);
  });

  it('다른 토큰이면 막는다', () => {
    const stored = encrypt(generateWebhookToken(), KEY);
    expect(matchesWebhookToken(generateWebhookToken(), stored, KEY)).toBe(false);
  });

  it('길이가 달라도 던지지 않고 false 다 — 길이 자체를 흘리지 않으려 해시로 견준다', () => {
    const token = generateWebhookToken();
    const stored = encrypt(token, KEY);
    expect(matchesWebhookToken('x', stored, KEY)).toBe(false);
    expect(matchesWebhookToken(token + 'x'.repeat(500), stored, KEY)).toBe(false);
  });

  it('제시값이나 저장값이 없으면 막는다 — 미설정 봇이 열려 있으면 안 된다', () => {
    const stored = encrypt(generateWebhookToken(), KEY);
    expect(matchesWebhookToken(null, stored, KEY)).toBe(false);
    expect(matchesWebhookToken('', stored, KEY)).toBe(false);
    expect(matchesWebhookToken(generateWebhookToken(), null, KEY)).toBe(false);
    expect(matchesWebhookToken(generateWebhookToken(), '', KEY)).toBe(false);
  });

  it('키가 달라 복호화가 안 되면 막는다', () => {
    const token = generateWebhookToken();
    expect(matchesWebhookToken(token, encrypt(token, OTHER_KEY), KEY)).toBe(false);
  });

  it('암호문이 손상됐어도 던지지 않는다', () => {
    expect(matchesWebhookToken('anything', 'not:a:ciphertext', KEY)).toBe(false);
  });
});

describe('matchesChannelId', () => {
  it('둘 다 있고 같으면 통과, 다르면 막는다', () => {
    expect(matchesChannelId('ch-1', 'ch-1')).toBe(true);
    expect(matchesChannelId('ch-1', 'ch-2')).toBe(false);
  });

  it('둘 중 하나라도 없으면 검사하지 않는다 — 없는 근거로 정상 웹훅을 떨어뜨리지 않는다', () => {
    expect(matchesChannelId(null, 'ch-1')).toBe(true);
    expect(matchesChannelId('ch-1', null)).toBe(true);
    expect(matchesChannelId(undefined, undefined)).toBe(true);
    expect(matchesChannelId('', 'ch-1')).toBe(true);
  });
});

describe('matchesVerifyToken — 채널톡 ?token= 은 저장돼 있을 때만 대조한다', () => {
  const stored = encrypt('a1b2c3d4e5f60718293a4b5c6d7e8f90', KEY);

  it('저장된 값이 없으면 제시값이 무엇이든 통과한다 — 선택 항목이라 안 넣은 운영자를 막지 않는다', () => {
    expect(matchesVerifyToken(null, null, KEY)).toBe(true);
    expect(matchesVerifyToken('anything', null, KEY)).toBe(true);
    expect(matchesVerifyToken(undefined, '', KEY)).toBe(true);
  });

  it('저장돼 있으면 같은 값만 통과한다', () => {
    expect(matchesVerifyToken('a1b2c3d4e5f60718293a4b5c6d7e8f90', stored, KEY)).toBe(true);
    expect(matchesVerifyToken('a1b2c3d4e5f60718293a4b5c6d7e8f91', stored, KEY)).toBe(false);
  });

  it('저장돼 있는데 제시값이 없으면 막는다 — 그때부터 URL 세그먼트 하나로는 못 들어온다', () => {
    expect(matchesVerifyToken(null, stored, KEY)).toBe(false);
    expect(matchesVerifyToken('', stored, KEY)).toBe(false);
    expect(matchesVerifyToken(undefined, stored, KEY)).toBe(false);
  });

  it('키가 달라 복호화가 안 되면 막는다 — 열어 두지 않는다', () => {
    expect(matchesVerifyToken('a1b2c3d4e5f60718293a4b5c6d7e8f90', encrypt('a1b2c3d4e5f60718293a4b5c6d7e8f90', OTHER_KEY), KEY)).toBe(false);
  });
});

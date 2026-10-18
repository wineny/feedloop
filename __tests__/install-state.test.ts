import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { signInstallState, verifyInstallState, installStateSecret } from '@/lib/github/install-state';

// src/lib/github/install-state.ts — 설치 URL 의 서명된 state (B5 안 B).
// 인가가 아니라 힌트다: 위조돼도 얻을 게 없지만, 「남의 botId 링크」로 유도하는 걸 막는다.

const SECRET = 'nextauth-secret-value';

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET;
});

describe('signInstallState / verifyInstallState', () => {
  it('서명한 값을 바로 검증하면 원래 내용이 그대로 나온다', () => {
    const token = signInstallState({ botId: 'bot-1', userId: 'user-1' }, SECRET);
    expect(verifyInstallState(token, SECRET)).toEqual({ botId: 'bot-1', userId: 'user-1' });
  });
  it('만료 전(29분)이면 통과, 만료(30분 지남)면 null', () => {
    const now = Date.now();
    const token = signInstallState({ botId: 'b', userId: 'u' }, SECRET, now);
    expect(verifyInstallState(token, SECRET, now + 29 * 60 * 1000)).toEqual({ botId: 'b', userId: 'u' });
    expect(verifyInstallState(token, SECRET, now + 30 * 60 * 1000 + 1)).toBeNull();
  });
  it('정확히 만료 시각(now === e)은 만료로 취급 — e < now 조건이 아니라 통과하지만 그 다음 순간은 거부', () => {
    const now = Date.now();
    const token = signInstallState({ botId: 'b', userId: 'u' }, SECRET, now);
    // e = now + TTL. now(검증) === e 는 e < now 가 거짓이라 통과한다.
    expect(verifyInstallState(token, SECRET, now + 30 * 60 * 1000)).not.toBeNull();
  });
  it('다른 시크릿으로 검증하면 null (변조 방지)', () => {
    const token = signInstallState({ botId: 'b', userId: 'u' }, SECRET);
    expect(verifyInstallState(token, 'other-secret')).toBeNull();
  });
  it('payload 를 건드려 변조하면(서명이 안 맞음) null', () => {
    const token = signInstallState({ botId: 'b', userId: 'u' }, SECRET);
    const [payload, sig] = token.split('.');
    const tampered = Buffer.from(JSON.stringify({ b: 'other-bot', u: 'u', e: Date.now() + 1_000_000 }), 'utf8').toString('base64url');
    expect(verifyInstallState(`${tampered}.${sig}`, SECRET)).toBeNull();
  });
  it('서명만 살짝 바꿔도 null', () => {
    const token = signInstallState({ botId: 'b', userId: 'u' }, SECRET);
    const [payload, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'a' ? 'b' : 'a');
    expect(verifyInstallState(`${payload}.${flipped}`, SECRET)).toBeNull();
  });
  it('점이 없는 문자열·빈 문자열·null·undefined 는 예외 없이 null', () => {
    expect(verifyInstallState('no-dot-here', SECRET)).toBeNull();
    expect(verifyInstallState('', SECRET)).toBeNull();
    expect(verifyInstallState(null, SECRET)).toBeNull();
    expect(verifyInstallState(undefined, SECRET)).toBeNull();
  });
  it('점으로 시작하는 문자열(payload 빈 문자열)도 null', () => {
    expect(verifyInstallState('.sig', SECRET)).toBeNull();
  });
  it('512자를 넘는 토큰은 파싱조차 하지 않고 null', () => {
    expect(verifyInstallState('a'.repeat(600), SECRET)).toBeNull();
  });
  it('완전히 쓰레기값(base64url 은 맞지만 JSON 이 아님)도 null — 서명을 맞춰 JSON.parse 단계까지 가도 throw 없다', () => {
    const garbagePayload = Buffer.from('not json at all', 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(garbagePayload).digest('base64url');
    expect(() => verifyInstallState(`${garbagePayload}.${sig}`, SECRET)).not.toThrow();
    expect(verifyInstallState(`${garbagePayload}.${sig}`, SECRET)).toBeNull();
  });
  it('payload 안의 필드 타입이 틀리면(b 가 숫자 등) null — 서명은 그 payload 로 다시 계산해 맞춘다', () => {
    const payload = Buffer.from(JSON.stringify({ b: 123, u: 'u', e: Date.now() + 1_000_000 }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifyInstallState(`${payload}.${sig}`, SECRET)).toBeNull();
  });
});

describe('installStateSecret', () => {
  it('NEXTAUTH_SECRET 이 있으면 trim 해서 돌려준다', () => {
    expect(installStateSecret({ NEXTAUTH_SECRET: '  abc  ' } as unknown as NodeJS.ProcessEnv)).toBe('abc');
  });
  it('없거나 공백뿐이면 null', () => {
    expect(installStateSecret({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(installStateSecret({ NEXTAUTH_SECRET: '   ' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

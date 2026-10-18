import { describe, it, expect } from 'vitest';
import { CALLBACK_KINDS, callbackBanner, isCallbackKind } from '@/lib/github/app-state-types';
import type { CallbackKind } from '@/lib/github/app-state-types';

// src/lib/github/app-state-types.ts — 화면과 서버가 함께 보는 콜백 결과 모양 (안 B).
// 의존성 0. 라우트가 만드는 모든 값이 여기 목록에 있어야 화면이 안내를 낼 수 있고(코드 리뷰 HIGH),
// 모르는 값(프로토타입 키 포함)으로는 안내가 새면 안 된다(보안 리뷰 LOW).

describe('isCallbackKind / callbackBanner', () => {
  it('CALLBACK_KINDS 의 모든 값에 비어 있지 않은 안내 문구가 있다', () => {
    for (const kind of CALLBACK_KINDS) {
      expect(isCallbackKind(kind)).toBe(true);
      const banner = callbackBanner(kind);
      expect(banner).not.toBeNull();
      expect(typeof banner!.kind).toBe('string');
      expect(banner!.message.length).toBeGreaterThan(0);
    }
  });

  it('callbackBanner("toString") 은 null — 프로토타입 키로 조회되지 않는다', () => {
    expect(callbackBanner('toString')).toBeNull();
    expect(callbackBanner('constructor')).toBeNull();
    expect(callbackBanner('hasOwnProperty')).toBeNull();
    expect(callbackBanner('__proto__')).toBeNull();
  });

  it('isCallbackKind 도 같은 프로토타입 키를 거부한다', () => {
    expect(isCallbackKind('toString')).toBe(false);
    expect(isCallbackKind('constructor')).toBe(false);
    expect(isCallbackKind('__proto__')).toBe(false);
  });

  it('목록에 없는 값·null·undefined 는 전부 null', () => {
    expect(callbackBanner('nonsense')).toBeNull();
    expect(callbackBanner('')).toBeNull();
    expect(callbackBanner(null)).toBeNull();
    expect(callbackBanner(undefined)).toBeNull();
    expect(isCallbackKind(null)).toBe(false);
    expect(isCallbackKind(undefined)).toBe(false);
  });

  it('콜백 라우트가 실제로 내보낼 수 있는 모든 결과값은 CALLBACK_KINDS 의 멤버다', () => {
    // bindInstallation(lib/github/installation-binding.ts)의 BindOutcome.kind 전부 +
    // 라우트 자신이 만드는 분기 전부. 어느 한쪽이 새 값을 추가하고 여기를 안 늘리면
    // 화면이 조용히 안내를 못 낸다 — 그 사고를 이 테스트가 잠근다.
    const bindOutcomeKinds: CallbackKind[] = ['bound', 'no_repo', 'not_installed', 'suspended', 'no_push', 'unknown_push'];
    const routeOwnKinds: CallbackKind[] = ['requested', 'need_state', 'no_code', 'auth_failed', 'no_bot', 'unconfigured', 'busy', 'error'];
    for (const k of [...bindOutcomeKinds, ...routeOwnKinds]) {
      expect(isCallbackKind(k)).toBe(true);
    }
    // 그리고 그 합이 CALLBACK_KINDS 전체를 덮는다(빠뜨린 값이 없다)
    expect(new Set([...bindOutcomeKinds, ...routeOwnKinds])).toEqual(new Set(CALLBACK_KINDS));
  });
});

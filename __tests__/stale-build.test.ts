import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStaleBuildError, reloadOnceForStaleBuild } from '@/lib/stale-build';

/** 브라우저 흉내 — sessionStorage 와 location.reload 만 있으면 된다. */
function stubWindow(storage?: Partial<Storage>) {
  const reload = vi.fn();
  const store = new Map<string, string>();
  const session: Partial<Storage> = storage ?? {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  Object.defineProperty(globalThis, 'window', {
    value: { sessionStorage: session, location: { reload } },
    configurable: true,
    writable: true,
  });
  return { reload };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  vi.useRealTimers();
});

describe('isStaleBuildError', () => {
  it('배포가 바뀌어 청크를 못 찾는 오류를 알아본다', () => {
    const chunk = new Error('Loading chunk 42 failed.');
    chunk.name = 'ChunkLoadError';
    expect(isStaleBuildError(chunk)).toBe(true);
    expect(isStaleBuildError(new Error('Failed to fetch dynamically imported module: /_next/x.js'))).toBe(true);
    expect(isStaleBuildError(new Error('Loading CSS chunk 7 failed'))).toBe(true);
  });

  it('보통 오류는 아니라고 한다 — 아무 오류에나 새로고침을 걸면 안 된다', () => {
    expect(isStaleBuildError(new Error('봇을 찾을 수 없습니다'))).toBe(false);
    expect(isStaleBuildError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
  });
});

describe('reloadOnceForStaleBuild', () => {
  it('낡은 청크 오류면 새로고침한다', () => {
    const { reload } = stubWindow();
    expect(reloadOnceForStaleBuild(new Error('Loading chunk 3 failed'))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('보통 오류에는 손대지 않는다', () => {
    const { reload } = stubWindow();
    expect(reloadOnceForStaleBuild(new Error('권한이 없습니다'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('30초 안에 두 번은 안 한다 — 무한 새로고침이 최악이다', () => {
    const { reload } = stubWindow();
    const err = new Error('Loading chunk 3 failed');
    expect(reloadOnceForStaleBuild(err)).toBe(true);
    expect(reloadOnceForStaleBuild(err)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('30초가 지나면 다시 한 번 시도한다', () => {
    vi.useFakeTimers();
    const { reload } = stubWindow();
    const err = new Error('Loading chunk 3 failed');
    expect(reloadOnceForStaleBuild(err)).toBe(true);
    vi.advanceTimersByTime(31_000);
    expect(reloadOnceForStaleBuild(err)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('sessionStorage 를 못 쓰면 자동 새로고침도 안 한다 — 횟수를 셀 수 없으면 루프를 못 막는다', () => {
    const { reload } = stubWindow({
      getItem: () => {
        throw new Error('사생활 보호 모드');
      },
      setItem: () => {
        throw new Error('사생활 보호 모드');
      },
    });
    expect(reloadOnceForStaleBuild(new Error('Loading chunk 3 failed'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('서버(window 없음)에서는 아무 일도 하지 않는다', () => {
    expect(reloadOnceForStaleBuild(new Error('Loading chunk 3 failed'))).toBe(false);
  });
});

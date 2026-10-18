import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaptureResult, CapturedNetworkRequest } from 'posthog-js';

const ph = vi.hoisted(() => {
  const m = {
    __loaded: false,
    init: vi.fn(() => { m.__loaded = true; }),
    identify: vi.fn(),
    capture: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  };
  return m;
});
vi.mock('posthog-js', () => ({ default: ph }));

const event = { event: '$autocapture', properties: { $el_text: '김민지: 환불해 주세요' } } as unknown as CaptureResult;
const VISITOR = '8ec0aaaa-0000-4000-8000-000000000000';

async function load() {
  vi.resetModules();
  return import('@/lib/analytics/posthog');
}

describe('PostHog — 로그아웃 방문자만', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ph.__loaded = false;
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    const store = new Map<string, string>([['feedloop:visitor', VISITOR]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const win: Record<string, unknown> = { crypto: { randomUUID: () => 'new-id' } };
    win.self = win;
    win.top = win;
    vi.stubGlobal('window', win);
  });

  it('로그아웃이 확인되기 전엔 SDK 를 켜지도 않고 아무것도 보내지 않는다', async () => {
    const { dropUnlessAllowed, setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(false); // 확인 중(loading)·로그인
    expect(ph.init).not.toHaveBeenCalled();
    expect(dropUnlessAllowed(event)).toBeNull();
  });

  it('로그아웃이면 SDK 를 켜고, 위젯 id 로 잇고, 녹화를 켠다', async () => {
    const { dropUnlessAllowed, setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(dropUnlessAllowed(event)).toBe(event);
    expect(ph.identify).toHaveBeenCalledWith(VISITOR, { feedloop_label: '#8ec0' });
    expect(ph.capture).not.toHaveBeenCalled(); // 첫 $pageview 는 init 이 남긴다
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('켜진 뒤 로그인으로 바뀌면 닫고 녹화를 끈다', async () => {
    const { dropUnlessAllowed, setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    setAnalyticsAllowed(false);
    expect(dropUnlessAllowed(event)).toBeNull();
    expect(ph.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('다시 로그아웃되면 SDK 를 또 켜지 않고 화면 기록을 직접 남긴다', async () => {
    const { setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    setAnalyticsAllowed(false);
    setAnalyticsAllowed(true);
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.capture).toHaveBeenCalledWith('$pageview');
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(2);
  });

  it('키가 없으면 아무것도 하지 않는다', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { dropUnlessAllowed, setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    expect(ph.init).not.toHaveBeenCalled();
    expect(dropUnlessAllowed(event)).toBeNull();
  });

  it('데모 팝업(iframe) 안에서는 켜지 않는다', async () => {
    vi.stubGlobal('window', { self: {}, top: {} });
    const { setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    expect(ph.init).not.toHaveBeenCalled();
  });

  it('저장이 막힌 브라우저면 잇지 않고 기록만 한다', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => {} });
    const { setAnalyticsAllowed } = await load();
    setAnalyticsAllowed(true);
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.identify).not.toHaveBeenCalled();
  });

  it('세션 응답이 정상이고 비어 있을 때만 로그아웃으로 본다', async () => {
    const { confirmLoggedOut } = await load();
    const answer = (init: { ok?: boolean; json?: () => Promise<unknown> } | Error) =>
      vi.stubGlobal('fetch', vi.fn(() => (init instanceof Error ? Promise.reject(init) : Promise.resolve({ ok: true, json: async () => ({}), ...init }))));

    answer({});
    expect(await confirmLoggedOut()).toBe(true);
    answer({ json: async () => ({ user: { id: 'u1' } }) });
    expect(await confirmLoggedOut()).toBe(false);
    answer({ ok: false });
    expect(await confirmLoggedOut()).toBe(false); // 500 — NextAuth 는 이걸 'unauthenticated' 로 본다
    answer({ json: async () => { throw new SyntaxError('bad json'); } });
    expect(await confirmLoggedOut()).toBe(false);
    answer({ json: async () => null });
    expect(await confirmLoggedOut()).toBe(false);
    answer(new TypeError('network'));
    expect(await confirmLoggedOut()).toBe(false);
  });

  it('녹화에 남는 요청에서 방문자 id·헤더·본문을 지운다', async () => {
    const { stripNetworkQuery } = await load();
    const req = {
      name: 'https://ai-feedloop.vercel.app/api/widget/b/messages?visitorId=8ec0',
      requestHeaders: { cookie: 'x' },
      responseHeaders: { location: '/?e=a@b.c' },
      requestBody: '{"email":"a@b.c"}',
      responseBody: 'x',
    } as unknown as CapturedNetworkRequest;
    expect(stripNetworkQuery(req)).toMatchObject({
      name: 'https://ai-feedloop.vercel.app/api/widget/b/messages',
      requestHeaders: undefined,
      responseHeaders: undefined,
      requestBody: null,
      responseBody: null,
    });
  });
});

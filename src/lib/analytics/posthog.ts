import posthog from 'posthog-js';
import type { BeforeSendFn, CapturedNetworkRequest } from 'posthog-js';

/**
 * PostHog — 로그아웃한 방문자만 기록·녹화한다 (ny 결정 2026-10-13).
 *
 * 목적은 「위젯에 질문한 방문자 #8ec0 이 어디서 와서 무엇을 보다가 물었나」를 잇는 것.
 * 그래서 PostHog 방문자 id 를 위젯 방문자 id(`feedloop:visitor`)와 같게 맞춘다.
 *
 * 로그인한 운영자 화면엔 실제 방문자 이름·메시지가 뜬다. 클릭 기록($el_text)·첫 주소(?c=대화id)·
 * 녹화 어느 길로도 PostHog 에 가면 안 되므로 **로그아웃이 확인된 뒤에야 SDK 를 켠다**(`PostHogGate`).
 * 켜기 전엔 SDK 가 없으니 설정·플래그 요청도, `/ingest` 로 실려 갈 로그인 쿠키도 없다.
 * 구글 로그인·로그아웃은 페이지를 새로 여는 방식이라 로그인한 화면에선 SDK 가 아예 안 뜬다.
 * 켜진 뒤 로그인으로 바뀌는 드문 경우(다른 탭 로그인)는 `before_send` 가 이벤트를 버리고 녹화를 끈다.
 *
 * 「데모 모드(isDemo)」로 가르지 않는 이유: 로그인한 채 `?demo=1` 을 붙이면 클라이언트는 데모로 보지만
 * 서버 페이지(bots/page.tsx 등)는 실제 데이터를 그린다. 로그아웃이면 서버·클라이언트 모두 연습용이다.
 */

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const VISITOR_KEY = 'feedloop:visitor';
let allowed = false;

export const dropUnlessAllowed: BeforeSendFn = (event) => (allowed ? event : null);

/** 녹화에 남는 요청에서 주소의 `?` 뒤·헤더·본문을 지운다 — 위젯 요청에 방문자 id·연락처가 실린다 */
export function stripNetworkQuery(req: CapturedNetworkRequest): CapturedNetworkRequest {
  return {
    ...req,
    name: req.name.split('?')[0],
    requestHeaders: undefined,
    responseHeaders: undefined,
    requestBody: null,
    responseBody: null,
  };
}

/**
 * 위젯과 같은 방문자 id. 위젯(public/widget.js)이 뜨기 전에 instrumentation-client 가 불러
 * 없으면 먼저 만든다 — 위젯은 저장된 값을 그대로 읽어 쓴다. 저장이 막힌 브라우저면 잇지 않는다.
 */
export function ensureVisitorId(): string | null {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id && window.crypto?.randomUUID) {
      id = window.crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * 정말 로그아웃인지 서버에 다시 묻는다. NextAuth `useSession` 은 세션 조회가 실패해도(네트워크·500·깨진 JSON)
 * 'unauthenticated' 를 돌려준다 — 그 틈에 SDK 가 켜지면 로그인한 실제 화면이 녹화된다.
 * 정상 응답이 「세션 없음({})」일 때만 true.
 */
export async function confirmLoggedOut(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && !('user' in body);
  } catch {
    return false;
  }
}

/** SDK 를 켠다. 첫 화면 기록($pageview)은 init 이 스스로 남긴다. 켰으면 true */
function boot(): boolean {
  // 랜딩 데모 팝업은 우리 화면을 iframe 으로 띄운다. 바깥 페이지 녹화에 이미 담기므로 안쪽은 세지 않는다.
  if (!KEY || window.self !== window.top) return false;
  try {
    posthog.init(KEY, {
      api_host: '/ingest', // 광고 차단기에 막히지 않게 우리 도메인으로 받아 넘긴다(next.config rewrites)
      ui_host: 'https://us.posthog.com',
      defaults: '2026-08-30',
      before_send: dropUnlessAllowed,
      disable_session_recording: true, // 아래에서 켠다 — 다시 열릴 때와 같은 길로
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        // 위젯 대화창은 녹화에서 빈 상자로 — 대화 내용은 Feedloop 「대화」 탭에서 같은 id 로 본다
        blockSelector: '[data-feedloop-widget]',
        maskCapturedNetworkRequestFn: stripNetworkQuery,
      },
    });
  } catch {
    return false; // 분석 실패가 화면을 막지 않게
  }
  return posthog.__loaded;
}

export function setAnalyticsAllowed(on: boolean) {
  if (on === allowed) return;
  if (!on) {
    allowed = false;
    if (posthog.__loaded) posthog.stopSessionRecording();
    return;
  }
  const reopening = posthog.__loaded;
  allowed = true; // init 이 남기는 첫 $pageview 가 문을 통과하도록 먼저 연다
  if (!reopening && !boot()) {
    allowed = false;
    return;
  }
  const id = ensureVisitorId();
  // 알림 메일의 「방문자 #8ec0」과 같은 꼴 — PostHog 에서 이 이름으로 찾는다
  if (id) posthog.identify(id, { feedloop_label: `#${id.slice(0, 4)}` });
  if (reopening) posthog.capture('$pageview'); // 닫혀 있던 동안의 화면은 버려졌다
  posthog.startSessionRecording();
}

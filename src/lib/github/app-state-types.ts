// GitHub App 연결의 «화면과 서버가 함께 보는 모양» — 의존성 0 (서버 코드를 끌고 들어오지 않는다).
//
// 왜 라우트 파일이 아니라 여기인가: 예전에는 `GithubTokenForm`(클라이언트)이 라우트 모듈에서
// `import type` 으로 가져왔다. 타입은 컴파일 때 지워지니 «오늘은» 안전하지만, 다음 사람이 값 하나를
// 같은 경로에서 가져오는 순간 next-auth·service_role 클라이언트가 클라이언트 번들로 딸려온다.
// 형제 코드(`token-format.ts`)가 같은 이유로 이미 갈라져 있다 — 같은 규칙을 여기에도 적용한다.

/** `GET /api/bots/[id]/github-app` 의 응답. 비밀은 없다(설치 id 는 비밀이 아니다) */
export interface GithubAppState {
  /** 앱 env 가 있어 설치형을 쓸 수 있는가. false 면 화면은 이 절을 숨긴다 */
  configured: boolean;
  /** `<slug>[bot]` — PR 작성자 이름 표시용 */
  botLogin: string | null;
  repoUrl: string | null;
  /** 지금 이 봇이 설치에 묶여 있고 잃어버림 표시가 없는가 */
  installed: boolean;
  installationId: number | null;
  /** 설치된 GitHub 계정(유저 또는 조직) */
  installationLogin: string | null;
  connectedAt: string | null;
  /** 누구의 인가로 묶였나(GitHub 로그인) */
  connectedBy: string | null;
  lostAt: string | null;
  lostReason: string | null;
  lostMessage: string | null;
  /** 설치 버튼이 여는 URL(서명된 state 포함). configured 가 false 면 null */
  installUrl: string | null;
  /**
   * 「이미 설치했어요 · 연결하기」가 여는 URL. 계정에 앱이 이미 설치돼 있으면 `installUrl` 은 GitHub 설정
   * 화면으로 새어 나가 콜백이 오지 않는다 — 그때 이 URL 이 유저 인가만 다시 받아 콜백으로 돌려보낸다
   */
  authorizeUrl: string | null;
  /** GitHub 의 설치 관리 화면. 묶인 설치가 없으면 null */
  manageUrl: string | null;
  /** 봇 PAT 도 등록돼 있는가 — 둘 다 있으면 설치가 우선한다는 안내용 */
  hasToken: boolean;
  /**
   * 설치가 「All repositories」인가. 우리가 쓰는 건 이 봇의 레포 하나지만, 운영자가 «계정 전체»를
   * 내준 상태라는 사실은 화면이 말해야 한다(보안 리뷰 M3). 묶이지 않았으면 null
   */
  repositorySelection: 'all' | 'selected' | null;
}

/**
 * 설치 콜백이 `?app=` 으로 실어 보내는 결과. **화면 세 곳(`GithubTokenForm`·`/bots`·`/bots/new`)이
 * 같은 목록을 본다** — 라우트가 새 값을 늘리고 화면이 모르면 운영자는 아무 안내도 못 받는다(코드 리뷰 HIGH).
 */
export const CALLBACK_KINDS = [
  'bound',
  'no_repo',
  'not_installed',
  'suspended',
  'no_push',
  'unknown_push',
  'requested',
  'need_state',
  'no_code',
  'auth_failed',
  'no_bot',
  'unconfigured',
  'busy',
  'error',
] as const;

export type CallbackKind = (typeof CALLBACK_KINDS)[number];

export function isCallbackKind(value: string | null | undefined): value is CallbackKind {
  return typeof value === 'string' && (CALLBACK_KINDS as readonly string[]).includes(value);
}

export interface CallbackBanner {
  kind: 'ok' | 'error' | 'info';
  message: string;
}

/** 결과 하나당 한 문장. 「무엇이 됐나/안 됐나」 + 「다음에 뭘 하면 되나」 */
const BANNERS: Record<CallbackKind, CallbackBanner> = {
  bound: { kind: 'ok', message: 'GitHub 앱을 설치하고 이 봇과 연결했어요' },
  no_repo: { kind: 'error', message: '고칠 저장소를 먼저 연결해 주세요. 그 뒤에 설치하면 묶여요' },
  not_installed: {
    kind: 'error',
    message: '설치는 됐지만 이 봇의 저장소가 앱 접근 목록에 없어요. GitHub 설치 관리에서 저장소를 추가해 주세요',
  },
  suspended: { kind: 'error', message: 'GitHub 에서 앱이 일시 정지 상태예요. 설치 설정에서 정지를 풀어 주세요' },
  no_push: {
    kind: 'error',
    message: '설치한 GitHub 계정에 이 저장소의 쓰기 권한이 없어요. 저장소 소유자나 쓰기 권한이 있는 계정으로 설치해 주세요',
  },
  unknown_push: { kind: 'error', message: 'GitHub 에 확인하지 못했어요. 잠시 후 「설치 확인」을 눌러 주세요' },
  requested: {
    kind: 'info',
    message: '조직 소유자에게 설치 요청을 보냈어요. 승인되면 설치 버튼을 한 번 더 눌러 연결해 주세요',
  },
  // state 가 없으면 «어느 봇에 묶을지» 를 우리가 정하게 된다. 그건 하지 않는다(보안 리뷰 M1·M2)
  need_state: {
    kind: 'error',
    message: '어느 서비스에 연결할지 확인하지 못했어요. Feedloop 의 연결 화면에서 「설치하기」로 다시 시작해 주세요 (이미 설치돼 있으면 확인만 하고 바로 돌아와요)',
  },
  no_code: { kind: 'error', message: '연결에 필요한 인가를 받지 못했어요. 설치 버튼으로 다시 시작해 주세요' },
  auth_failed: { kind: 'error', message: 'GitHub 인가 확인에 실패했어요. 설치 버튼으로 다시 시작해 주세요' },
  no_bot: { kind: 'error', message: '연결할 서비스가 없어요. 서비스를 먼저 등록한 뒤 설치해 주세요' },
  unconfigured: { kind: 'error', message: '이 배포에는 GitHub 앱이 설정돼 있지 않아요. 토큰으로 연결해 주세요' },
  busy: { kind: 'error', message: '설치 요청이 너무 잦아요. 잠시 후 다시 시도해 주세요' },
  error: { kind: 'error', message: '연결 중 문제가 생겼어요. 잠시 후 설치 버튼으로 다시 시도해 주세요' },
};

/**
 * 주소의 `?app=` 을 안내 문구로. 모르는 값이면 null — **프로토타입 키(`toString` 등)로 조회되지 않게
 * 목록에 있는 값만 받는다**(보안 리뷰 LOW).
 */
export function callbackBanner(raw: string | null | undefined): CallbackBanner | null {
  return isCallbackKind(raw) ? BANNERS[raw] : null;
}

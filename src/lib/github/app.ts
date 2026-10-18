// GitHub App 설치형 연결 — 앱 자격(JWT)과 설치 토큰을 만드는 «유일한» 곳 (서버 전용).
//
// 구조(공식 문서 「Authenticating with a GitHub App」):
//   앱 자체(JWT, RS256, 10분) → 설치 조회·설치 토큰 발급용
//   설치(installation access token, 1시간, 활동은 `<slug>[bot]` 에 귀속) → 레포 읽기·브랜치·커밋·PR
// 유저 토큰(OAuth)은 «설치 콜백에서 한 번» — 설치한 사람이 봇 레포에 push 권한이 있는지 묻고 버린다. 로그인은 next-auth Google 하나 그대로.
//
// 지키는 것:
//  1. 개인 키(PEM) 는 env 에서만 읽고 어떤 응답·로그에도 안 나간다. 이 모듈 밖으로 나가는 건 Octokit 인스턴스뿐이다
//  2. `installation_id` 쿼리 파라미터를 «믿지 않는다». 봇에 등록된 레포로 GET /repos/{o}/{r}/installation 을 물어
//     우리 앱이 그 레포에 설치돼 있는지로 판정한다(문서: 「Bad actors can hit this URL with a spoofed installation_id」)
//  3. env 가 없으면 «기능이 꺼진 것»이지 오류가 아니다 — 기존 PAT·공용 경로가 그대로 돈다

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  /** github.com/apps/<slug> — 설치 URL 과 `<slug>[bot]` 표시에 쓴다 */
  slug: string;
  /**
   * 설치 때 「Request user authorization (OAuth) during installation」 이 켜져 있어 콜백에 `code` 가 온다.
   * 그 code 로 받은 «유저 토큰»은 딱 하나에 쓴다 — «이 Feedloop 유저가 그 레포에 push 권한이 있는가»를 GitHub 에 묻고 버린다.
   * 저장하지 않는다. 없으면 봇을 설치에 묶는 경로가 없으므로 설정 미완으로 본다
   */
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
}

/**
 * PEM 을 env 에 넣는 두 방식을 다 받는다: 줄바꿈이 `\n` 리터럴로 이스케이프된 것, base64 한 줄로 감싼 것.
 * Vercel 대시보드는 여러 줄 값을 받지만 CLI `vercel env add` 는 표준입력 그대로라 이스케이프본이 흔하다.
 */
export function normalizePem(raw: string): string {
  const s = raw.trim();
  if (s.includes('-----BEGIN')) return s.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded.trim();
  } catch {
    /* fallthrough */
  }
  return s;
}

export function readGithubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY;
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!appId || !slug || !rawKey?.trim() || !clientId || !clientSecret) return null;
  return {
    appId,
    privateKey: normalizePem(rawKey),
    slug,
    clientId,
    clientSecret,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET?.trim() || null,
  };
}

/**
 * 웹훅 서명 검증에 필요한 것은 시크릿 하나뿐이다. 앱 전체 설정(OAuth 클라이언트 포함)과 갈라 둔다 —
 * 콜백을 아직 못 쓰는 배포에서도 「설치가 제거됐다」는 소식은 받아야 한다.
 */
export function readWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GITHUB_APP_WEBHOOK_SECRET?.trim() || null;
}

export function isGithubAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readGithubAppConfig(env) !== null;
}

/** 운영자가 누르는 설치 URL. `state` 는 설치 뒤 setup URL 로 되돌아올 때 어느 봇인지 찾는 힌트(믿지 않는다 — 소유 확인은 세션이) */
export function githubAppInstallUrl(slug: string, state?: string | null): string {
  const base = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/**
 * 설치와 «독립적으로» 유저 인가만 시작하는 URL (user-to-server OAuth).
 *
 * 왜 필요한가: 계정에 앱이 «이미» 설치돼 있으면 `installations/new` 는 설치 화면 대신 GitHub 의 설치 설정
 * 페이지로 보내고, 거기서 Save 를 눌러도 우리 콜백으로 돌아오지 않는다. 그러면 **두 번째 서비스를 묶을 방법이
 * 없다**(「설치 확인」은 이미 묶인 것만 재확인한다). 이 URL 은 설치 여부와 무관하게 `code` 를 들고 콜백으로
 * 돌아오므로, 콜백이 평소대로 «설치 존재(앱 JWT) + push 권한(유저 토큰)» 을 확인하고 묶는다.
 *
 * `redirect_uri` 는 넘기지 않는다 — 앱에 등록된 콜백 URL 로 가야 로컬·프로덕션 앱이 각자 제 주소로 돌아온다.
 */
export function githubAppAuthorizeUrl(config: GithubAppConfig, state?: string | null): string {
  const params = new URLSearchParams({ client_id: config.clientId });
  if (state) params.set('state', state);
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** 설치를 관리(레포 추가·제거·제거)하는 GitHub 화면 */
export function githubInstallationManageUrl(installationId: number): string {
  return `https://github.com/settings/installations/${installationId}`;
}

/** PR·커밋에 찍히는 봇 계정 이름 */
export function githubAppBotLogin(slug: string): string {
  return `${slug}[bot]`;
}

// ── Octokit 인스턴스 ─────────────────────────────────────

/** 앱 자체로 인증한 Octokit (JWT). 설치 조회·설치 목록에만 쓴다 — 레포 내용은 못 읽는다 */
export function appOctokit(config: GithubAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
  });
}

/** 특정 설치로 인증한 Octokit. 첫 호출 때 설치 토큰(1시간)을 받고 auth-app 이 만료 전 갱신한다 */
export type OctokitRequestOptions = {
  timeout?: number;
  fetch?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/**
 * `request` 는 설치 경로에도 반드시 전달돼야 한다 — 엔진은 GitHub 호출마다 실행권·생성 예산을
 * 강제하는 fetch 를 끼운다. 설치로 나가는 봇만 그게 빠지면 예산이 안 걸린다.
 */
export function installationOctokit(
  config: GithubAppConfig,
  installationId: number,
  request?: OctokitRequestOptions,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey, installationId },
    ...(request && Object.keys(request).length ? { request } : {}),
  });
}

// ── 설치 판정 ─────────────────────────────────────────────

export interface RepoInstallation {
  id: number;
  /** 설치된 계정(유저 또는 조직) 로그인 */
  login: string;
  suspended: boolean;
  repositorySelection: 'all' | 'selected' | null;
}

/**
 * 우리 앱이 이 레포에 설치돼 있으면 그 설치를, 아니면 null. 앱 JWT 로 묻는다(레포 접근 권한 불필요).
 * 404 = 설치 안 됨(또는 레포 없음). 그 외 실패는 throw — 「설치 안 됨」과 「못 물어봄」을 섞지 않는다.
 */
export async function findInstallationForRepo(
  config: GithubAppConfig,
  owner: string,
  repo: string,
  octokit: Octokit = appOctokit(config),
): Promise<RepoInstallation | null> {
  try {
    const { data } = await octokit.apps.getRepoInstallation({ owner, repo });
    const account = data.account as { login?: string } | null;
    return {
      id: data.id,
      login: account?.login ?? '',
      suspended: Boolean(data.suspended_at),
      repositorySelection: data.repository_selection === 'all' || data.repository_selection === 'selected' ? data.repository_selection : null,
    };
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return null;
    throw err;
  }
}

// ── 설치 콜백의 유저 인가 — 「누가 설치했나」를 증명하는 유일한 수단 ──
//
// 공식 문서(about-the-setup-url): 「installation_id 는 스푸핑될 수 있으니 설치한 유저의 user access token 을 만들어
// 그 설치가 그 유저의 것인지 확인하라」. 우리는 한 걸음 더 — 유저 토큰으로 «봇 레포에 push 권한이 있는가»를 본다.
// 안 그러면: 공격자가 봇 레포를 victim/repo 로 적어 두고, 피해자가 자기 봇용으로 앱을 설치하는 순간
// 공격자 봇도 같은 설치에 묶여 피해자 레포에 PR 을 민다(setup 라우트가 «세션 봇 전부»를 후보로 삼기 때문).
// 유저 토큰(`ghu_`)은 여기서 받아 쓰고 **버린다** — DB·로그·응답 어디에도 남지 않는다.

const OAUTH_TIMEOUT_MS = 8_000;

export interface UserAuthorization {
  token: string;
  login: string | null;
}

/** 콜백의 `code` 를 유저 토큰으로 바꾼다. 실패면 null(원문 에러는 로그에 안 싣는다 — 시크릿이 섞일 수 있다) */
export async function exchangeUserCode(config: GithubAppConfig, code: string): Promise<UserAuthorization | null> {
  let res: Response;
  try {
    res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'feedloop' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
      redirect: 'error',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    console.error('[github-app] code exchange could not reach GitHub');
    return null;
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
  const token = typeof json?.access_token === 'string' ? json.access_token : null;
  if (!res.ok || !token) {
    console.warn('[github-app] code exchange rejected', { status: res.status, error: typeof json?.error === 'string' ? json.error : null });
    return null;
  }
  const login = await userLogin(token);
  return { token, login };
}

async function userLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'feedloop' },
      redirect: 'error',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { login?: unknown } | null;
    return typeof json?.login === 'string' ? json.login : null;
  } catch {
    return null;
  }
}

/**
 * 유저 토큰으로 «이 사람이 이 레포에 push 할 수 있는가». 유저 토큰의 권한은 앱∩유저라, 앱이 설치된 레포이고
 * 유저가 쓰기 권한자일 때만 true. 404 = 유저가 그 레포에 접근 못 함(존재를 숨긴다) → false.
 * 「모름」(연결 실패·5xx)은 false 가 아니라 null — 호출부가 「나중에 다시」로 답하게.
 */
export async function userCanPush(token: string, owner: string, repo: string): Promise<boolean | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'feedloop' },
      redirect: 'error',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) return false;
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { permissions?: { push?: unknown } } | null;
  return json?.permissions?.push === true;
}

// ── 웹훅 서명 ─────────────────────────────────────────────

/**
 * `X-Hub-Signature-256: sha256=<hex>` 를 원문 바디로 검증한다. 상수시간 비교.
 * 시크릿이 없으면 «항상 거짓» — 서명 없는 웹훅을 받아들이면 누구나 봇의 연결을 끊을 수 있다.
 */
export function verifyWebhookSignature(secret: string | null | undefined, rawBody: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── 잃어버림 사유 (bots.github_installation_lost_reason 고정 문자열) ──

export type InstallationLostReason = 'uninstalled' | 'suspended' | 'repo_removed' | 'missing';

export function installationLostMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'uninstalled':
      return 'GitHub 에서 Feedloop 앱이 제거됐어요. 다시 설치하면 이어서 씁니다';
    case 'suspended':
      return 'GitHub 에서 Feedloop 앱이 일시 정지됐어요. 설치 설정에서 정지를 풀어 주세요';
    case 'repo_removed':
      return '이 저장소가 앱의 접근 목록에서 빠졌어요. 설치 설정에서 저장소를 다시 추가해 주세요';
    case 'missing':
      return '이 저장소에서 Feedloop 앱 설치를 찾지 못했어요. 다시 설치해 주세요';
    default:
      return 'GitHub 앱 연결을 확인해 주세요';
  }
}

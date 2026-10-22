// 운영자 GitHub 토큰의 실호출 검증과 실패 사유 분류 (서버 전용).
//
// 이 모듈이 지키는 것 하나: **토큰 원문은 반환값에도 로그에도 절대 안 들어간다.**
// GitHub 에러 본문도 싣지 않는다. 밖으로 나가는 건 우리가 고른 사유 분류와 그에 대응하는 문구(요청 언어)뿐이다.
//
// 검증은 «저장 전»에 한다 — 반쯤 저장된 토큰은 첫 「PR 만들기」에서 죽고, 운영자는 원인을 모른다.

import { serverT } from '@/i18n/server-messages';
import type { Locale } from '@/i18n/routing';
import { parseRepoInfo } from './repo-url';

export { checkGithubTokenFormat, githubTokenLast4, type TokenFormatResult } from './token-format';

// ── 실패 사유 3분류 ─────────────────────────────────
//
// 저장 전 검증과 실행 중 실패(엔진·PR 검토)가 같은 분류를 쓴다.
// 운영자가 화면에서 보는 문구가 "뭘 고쳐야 하는지"를 말해야 한다.
//
//  - token_rejected: 토큰이 틀렸거나 만료됐거나, 그 레포에 접근 자체가 안 된다(GitHub 은 권한 없는
//    비공개 레포를 404 로 답한다 — 존재를 숨기려고). 운영자에겐 «토큰이 이 레포에 못 들어간다»가 같은 뜻이다
//  - no_push: 읽기는 되는데 쓰기 권한이 없다 — fine-grained 토큰의 Contents·Pull requests 가 Read 로만 걸린 경우
//  - connection: GitHub 에 닿지 못했다

//  - unreadable: 저장된 암호문을 우리가 못 풀었다(AES 키 교체 등). GitHub 탓이 아니다 — 통계에서 갈라 둔다

export type GithubFailureKind = 'token_rejected' | 'no_push' | 'connection' | 'unreadable';

export function classifyGithubFailure(status: number | null): GithubFailureKind {
  if (status === 401 || status === 403 || status === 404) return 'token_rejected';
  return 'connection';
}

/** 운영자 화면에 쓰는 문구(요청 언어). 원문 에러는 안 들어간다. */
export function githubFailureMessage(kind: GithubFailureKind, locale: Locale = 'en'): string {
  return serverT(locale, 'errors.githubFailure')(kind);
}

const GITHUB_FAILURE_KINDS: readonly string[] = ['token_rejected', 'no_push', 'connection', 'unreadable'];

/**
 * `bots.github_token_failed_reason` 에는 코드값(`GithubFailureKind`)을 저장한다. 화면에 낼 때 문장으로 바꾼다.
 * 코드가 아닌 값(코드 전환 전에 저장된 한국어 문장)은 그대로 돌려준다.
 */
export function githubFailureReasonText(stored: string | null, locale: Locale = 'en'): string | null {
  if (!stored) return null;
  return GITHUB_FAILURE_KINDS.includes(stored) ? githubFailureMessage(stored as GithubFailureKind, locale) : stored;
}

// ── 실호출 검증 ─────────────────────────────────────

const VERIFY_TIMEOUT_MS = 8_000;
const API = 'https://api.github.com';

export type TokenVerifyResult =
  | {
      ok: true;
      /** 토큰 주인의 GitHub 로그인 — 화면에 「@login 으로 연결됨」 표시용. 비밀이 아니다 */
      login: string | null;
      /** 레포가 있으면 push 여부, 레포가 없는 봇이면 skipped */
      repoAccess: 'push' | 'skipped';
      /**
       * classic PAT·OAuth 토큰이면 그 스코프 목록(`x-oauth-scopes`). fine-grained 면 null.
       * 이런 토큰은 «계정이 닿는 모든 레포»에 권한이 있어, 우리는 한 레포의 push 만 확인했을 뿐이다 —
       * 화면이 이 사실을 말해 fine-grained 로 바꾸길 권한다(보안 리뷰 M2: 거부 대신 경고)
       */
      broadScopes: string | null;
    }
  | { ok: false; kind: GithubFailureKind; error: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'feedloop',
  };
}

async function get(
  token: string,
  path: string,
): Promise<{ status: number | null; json: unknown; oauthScopes: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: 'GET',
      headers: headers(token),
      // 리다이렉트를 따라가지 «않는다». 따라가면 Authorization 헤더가 우리가 고르지 않은
      // 호스트로 전달될 수 있다. GitHub REST 는 이 두 경로에서 리다이렉트를 쓰지 않는다.
      redirect: 'error',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    // 에러 객체를 로그에 싣지 않는다 — fetch 에러가 요청 헤더를 품는 런타임이 있다.
    console.error(`[github] token verification could not reach GitHub: ${path}`);
    return { status: null, json: null, oauthScopes: null };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  // classic PAT·OAuth 토큰만 이 헤더를 단다(fine-grained 는 null). 값은 스코프 목록이지 비밀이 아니다
  return { status: res.status, json, oauthScopes: res.headers.get('x-oauth-scopes') };
}

/**
 * 토큰이 실제로 통하는지, 그리고 (레포가 있으면) 그 레포에 push 할 수 있는지 GitHub 에 물어본다.
 * 둘 다 GET 이라 아무것도 바꾸지 않는다.
 *
 * 레포 URL 이 없는 봇은 토큰 유효성(`/user`)만 본다 — 권한은 레포가 생길 때 다시 판정된다.
 * 잘못된 레포 URL(앵커 실패)은 여기서 throw 하지 않고 token_rejected 로 답한다 — 운영자 입장에선 같은 조치다.
 */
export async function verifyGithubToken(token: string, repoUrl: string | null, locale: Locale = 'en'): Promise<TokenVerifyResult> {
  if (!repoUrl) {
    const { status, json, oauthScopes } = await get(token, '/user');
    if (status === 200) {
      const login = typeof (json as { login?: unknown })?.login === 'string' ? (json as { login: string }).login : null;
      return { ok: true, login, repoAccess: 'skipped', broadScopes: oauthScopes };
    }
    // 403 은 토큰이 죽은 게 아니라 프로필을 못 읽는다는 뜻일 수 있다(fine-grained 는 user 권한이 따로다).
    // 레포가 없어 어차피 권한은 레포가 생길 때 다시 판정하므로 login 없이 통과시킨다. 401 만 확실한 거부다
    if (status === 403) return { ok: true, login: null, repoAccess: 'skipped', broadScopes: oauthScopes };
    const kind = classifyGithubFailure(status);
    return { ok: false, kind, error: githubFailureMessage(kind, locale) };
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoInfo(repoUrl));
  } catch {
    return { ok: false, kind: 'token_rejected', error: githubFailureMessage('token_rejected', locale) };
  }

  const { status, json, oauthScopes } = await get(token, `/repos/${owner}/${repo}`);
  if (status !== 200) {
    const kind = classifyGithubFailure(status);
    return { ok: false, kind, error: githubFailureMessage(kind, locale) };
  }

  // `permissions` 는 fine-grained 토큰에서 «토큰에 준 권한»이 아니라 «그 사람의 레포 역할»로 보인다 —
  // 자기 레포면 Contents:Read 토큰이어도 push:true 가 온다. 그래서 false 만 증거로 쓴다:
  //   false → 확실히 못 쓴다(막는다) / true·없음 → 증명이 아니다(통과시키고, 실제 쓰기 403 을 no_push 로 읽는다 — github-auth.ts)
  const permissions = (json as { permissions?: { push?: unknown } })?.permissions;
  if (permissions?.push === false) {
    return { ok: false, kind: 'no_push', error: githubFailureMessage('no_push', locale) };
  }

  // 레포 응답엔 토큰 주인이 없다. 로그인은 표시용이라 실패해도 저장을 막지 않는다
  const me = await get(token, '/user');
  const login =
    me.status === 200 && typeof (me.json as { login?: unknown })?.login === 'string'
      ? (me.json as { login: string }).login
      : null;

  return { ok: true, login, repoAccess: 'push', broadScopes: oauthScopes };
}

// GitHub App 설치 콜백 — 운영자가 GitHub 에서 「Install」 을 누르면 여기로 돌아온다 (안 B).
//
// 앱은 「Request user authorization during installation」 이 켜져 있어 `code` · `installation_id` · `setup_action` · `state` 가 온다.
// 우리가 믿는 것 셋, 전부 있어야 묶는다:
//   ① **서명된 `state`** — 어느 봇에 묶을지. 우리가 서명했고 세션 유저와 일치해야 한다
//   ② **세션** — 그 봇이 이 유저의 것인가
//   ③ **code 로 받은 유저 토큰** — 설치한 사람이 그 봇 레포에 push 할 수 있는가 (+ 앱 JWT 로 설치 존재 확인)
// `installation_id` 는 로그에만 남긴다(공식 문서: 스푸핑 가능).
//
// **state 가 없으면 아무것도 묶지 않는다.** 예전엔 세션 유저의 «봇 전부»를 후보로 돌렸는데, 그러면
//  - U 의 다른 봇(레포가 orgX 이고 동료가 이미 orgX 에 설치해 둔 경우)이 U 가 모르는 설치에 조용히 묶이고,
//  - 쿠키 인증 GET 이라 CSRF 가 성립한다 — 공격자가 자기 `code` 로 피해자를 유인하면 피해자 봇이
//    공격자가 관리하는 설치에 묶인다(보안 리뷰 M1·M2).
// state 는 우리 화면의 설치 버튼만 만들 수 있으므로, 필수로 두면 두 경로가 함께 닫힌다.
//
// 유저 토큰은 이 요청 안에서 쓰고 버린다 — 저장·로그 없음. 로그인 방식(Google)엔 손대지 않는다.

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { readGithubAppConfig, exchangeUserCode } from '@/lib/github/app';
import { installStateSecret, verifyInstallState } from '@/lib/github/install-state';
import { bindInstallation } from '@/lib/github/installation-binding';
import type { CallbackKind } from '@/lib/github/app-state-types';

export const dynamic = 'force-dynamic';

// 한 번의 콜백이 GitHub 으로 토큰 교환 1회 + 레포 조회 2회를 내보낸다. 「설치 확인」과 같은 상한을 둔다
const CALLBACK_LIMIT_PER_MIN = 10;
const callbackHits = new Map<string, number[]>();

function callbackRateExceeded(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const hits = (callbackHits.get(userId) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  callbackHits.set(userId, hits);
  if (callbackHits.size > 5000) {
    for (const [key, times] of callbackHits) if (times.every((t) => t <= cutoff)) callbackHits.delete(key);
  }
  return hits.length > CALLBACK_LIMIT_PER_MIN;
}

function backTo(req: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, req.url), { status: 303 });
}

/** 봇이 정해졌으면 그 봇의 GitHub 탭으로, 아니면 목록으로. 두 화면 다 `?app=` 을 읽어 안내를 띄운다 */
function resultPage(req: Request, botId: string | null, result: CallbackKind): NextResponse {
  const qs = `app=${encodeURIComponent(result)}`;
  return backTo(req, botId ? `/bots/${encodeURIComponent(botId)}/knowledge?tab=github&${qs}` : `/bots?${qs}`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    // code 는 10분 안에 써야 한다 — 로그인 뒤 같은 URL 로 돌아오면 이어서 처리된다
    return backTo(req, `/api/auth/signin?callbackUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const userId = session.user.id;
  if (callbackRateExceeded(userId)) return resultPage(req, null, 'busy');

  const config = readGithubAppConfig();
  if (!config) return resultPage(req, null, 'unconfigured');

  const setupAction = url.searchParams.get('setup_action');
  const installationIdParam = url.searchParams.get('installation_id');
  const secret = installStateSecret();
  const hint = secret ? verifyInstallState(url.searchParams.get('state'), secret) : null;
  const botId = hint && hint.userId === userId ? hint.botId : null;

  const log = (result: CallbackKind, extra: Record<string, unknown> = {}) =>
    console.log('[github-app] callback', { userId, botId, installationIdParam, setupAction, result, ...extra });

  // state 없이 온 설치(예: GitHub 앱 페이지에서 직접 Install) — 묶지 않고 다시 시작하게 한다
  if (!botId) {
    log('need_state');
    return resultPage(req, null, 'need_state');
  }

  // 조직 레포에서 비소유자가 「Request」 를 누른 경우 — 소유자가 승인해야 설치가 생긴다. 지금 묶을 게 없다
  if (setupAction === 'request') {
    log('requested');
    return resultPage(req, botId, 'requested');
  }

  // state 는 우리가 서명했지만 «지금도» 그 봇이 이 유저 것인지는 DB 가 답한다(봇이 지워졌거나 넘어갔을 수 있다)
  const { data: bot, error } = await getServiceRoleClient()
    .from('bots')
    .select('id, github_repo_url')
    .eq('id', botId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[github-app] bot lookup failed', { userId, botId, message: error.message });
    return resultPage(req, null, 'error');
  }
  if (!bot) {
    log('no_bot');
    return resultPage(req, null, 'no_bot');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    log('no_code');
    return resultPage(req, botId, 'no_code');
  }
  const user = await exchangeUserCode(config, code);
  if (!user) {
    log('auth_failed');
    return resultPage(req, botId, 'auth_failed');
  }

  try {
    const outcome = await bindInstallation(
      config,
      { botId: bot.id as string, repoUrl: (bot.github_repo_url as string | null) ?? null },
      user.token,
      user.login,
    );
    log(outcome.kind, { login: user.login });
    return resultPage(req, botId, outcome.kind);
  } catch (err) {
    // 우리 쪽 실패(DB 쓰기 등)다. `unknown_push`(「잠시 후 설치 확인」)로 뭉뚱그리면 고치는 방법이 다르다
    console.error('[github-app] bind failed', { botId, message: err instanceof Error ? err.message : String(err) });
    return resultPage(req, botId, 'error');
  }
}

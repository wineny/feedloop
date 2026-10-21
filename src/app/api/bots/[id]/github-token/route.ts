// 봇 설정 › GitHub 연결 — 운영자 GitHub 토큰을 읽고·바꾸고·지운다 (B5).
//
// 구조는 `llm-key/route.ts` 와 같다. 지키는 것 둘:
//  1) **토큰 원문은 어떤 응답에도 안 나간다.** AES-256-GCM 암호문으로 저장하고 화면에는 마지막 4자만.
//     되읽는 경로는 만들지 않는다 — 만들면 세션 탈취 한 번이 «남의 레포 push 권한» 유출이 된다.
//  2) 소유자 확인(`resolveOwnedBots`). 남의 봇에 토큰을 심으면 그 사람 레포에 우리 PR 이 열린다.
//
// 저장 «전»에 GitHub 에 물어본다(GET 둘, 아무것도 안 바꿈). 실패하면 DB 에 아무것도 남기지 않는다 —
// 반쯤 저장된 토큰은 첫 「PR 만들기」에서 죽고 운영자는 원인을 모른다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { encrypt } from '@/lib/utils/crypto';
import { checkGithubTokenFormat, githubTokenLast4, verifyGithubToken, githubFailureReasonText } from '@/lib/github/token';
import { readJsonBounded } from '@/lib/auto-dev/run-access';
import { apiText, apiValidation } from '@/lib/http/api-text';
import { localeFromRequest } from '@/i18n/server-locale';

export const dynamic = 'force-dynamic';

// ── 검증 속도 제한 — llm-key 와 같은 이유(우리 서버 IP 로 나가는 토큰 대입 통로가 되지 않게) ──
const VERIFY_LIMIT_PER_MIN = 5;
const verifyHits = new Map<string, number[]>();

function verifyRateExceeded(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const hits = (verifyHits.get(userId) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  verifyHits.set(userId, hits);
  if (verifyHits.size > 5000) {
    for (const [key, times] of verifyHits) {
      if (times.every((t) => t <= cutoff)) verifyHits.delete(key);
    }
  }
  return hits.length > VERIFY_LIMIT_PER_MIN;
}

const SELECT =
  'id, github_repo_url, github_token_encrypted, github_token_last4, github_token_verified_at, github_token_failed_at, github_token_failed_reason, github_token_broad';

interface BotTokenRow {
  id: string;
  github_repo_url: string | null;
  github_token_encrypted: string | null;
  github_token_last4: string | null;
  github_token_verified_at: string | null;
  github_token_failed_at: string | null;
  github_token_failed_reason: string | null;
  github_token_broad: boolean | null;
}

/** 화면이 받는 모양. **암호문은 여기에 들어가지 않는다.** 있다/없다만 `hasToken` 으로. */
function present(bot: BotTokenRow, req: Request) {
  return {
    repoUrl: bot.github_repo_url,
    hasToken: Boolean(bot.github_token_encrypted),
    tokenLast4: bot.github_token_last4,
    verifiedAt: bot.github_token_verified_at,
    failedAt: bot.github_token_failed_at,
    // 분류 코드를 요청 언어 문구로. GitHub 에러 원문은 여기 들어오지 않는다.
    failedReason: githubFailureReasonText(bot.github_token_failed_reason, localeFromRequest(req)),
    // 토큰이 없으면 공용 계정으로 시도한다 — 초대된 레포에서만 된다. 화면이 이 사실을 말한다
    platformFallback: Boolean(process.env.GITHUB_TOKEN),
    // 계정 전체 레포에 닿는 종류(classic·OAuth)인가. 경고가 새로고침에 사라지지 않게 DB 에서 읽는다(보안 재검토 R2)
    broadToken: bot.github_token_broad === true,
  };
}

async function loadBot(id: string): Promise<BotTokenRow | null> {
  const { data, error } = await getServiceRoleClient().from('bots').select(SELECT).eq('id', id).single();
  return error || !data ? null : (data as unknown as BotTokenRow);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });
  return NextResponse.json(present(bot, req));
}

/** 토큰 등록·교체: `{ token }`. 형식 → 분당 5회 → GitHub 검증(레포 접근 + push) → 저장 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // 본문 상한(16KB) — App Router 라우트는 기본 상한이 없다. run 행동 라우트와 같은 헬퍼를 쓴다(보안 리뷰 M3)
  const bounded = await readJsonBounded(req);
  if (!bounded.ok) return NextResponse.json({ error: bounded.error }, { status: bounded.status });
  const parsed = bounded.value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ error: apiText(req, 'badRequest') }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });

  const format = checkGithubTokenFormat(body.token);
  if (!format.ok) return NextResponse.json({ error: apiValidation(req, format) }, { status: 400 });
  const token = body.token as string;

  // 형식이 맞는 «뒤»에 센다. 오탈자로 한 번 틀린 것까지 한도에 넣으면 사람이 손해를 본다.
  if (verifyRateExceeded(auth.userId)) {
    return NextResponse.json(
      { error: apiText(req, 'tokenCheckTooFrequent') },
      { status: 429 },
    );
  }

  const verified = await verifyGithubToken(token, bot.github_repo_url, localeFromRequest(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error, kind: verified.kind }, { status: 400 });
  }

  return await save(req, id, {
    github_token_encrypted: encrypt(token),
    github_token_last4: githubTokenLast4(token),
    github_token_verified_at: new Date().toISOString(),
    // 새 토큰을 검증했으니 지난 실패는 해소다. 배지가 계속 떠 있으면 안 된다.
    github_token_failed_at: null,
    github_token_failed_reason: null,
    github_token_broad: verified.broadScopes !== null,
  }, { login: verified.login, repoAccess: verified.repoAccess, broadScopes: verified.broadScopes });
}

/** 토큰을 지우고 공용 계정 폴백으로 되돌린다. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return await save(req, id, {
    github_token_encrypted: null,
    github_token_last4: null,
    github_token_verified_at: null,
    github_token_failed_at: null,
    github_token_failed_reason: null,
    github_token_broad: false,
  });
}

async function save(req: Request, id: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { data, error } = await getServiceRoleClient().from('bots').update(values).eq('id', id).select(SELECT).single();
  if (error || !data) {
    // error.message 를 그대로 내보내지 않는다 — update 값에 암호문이 섞여 있다.
    console.error(`[github-token] save failed for ${id}:`, error?.message);
    return NextResponse.json({ error: apiText(req, 'saveFailed') }, { status: 500 });
  }
  return NextResponse.json({ ...present(data as unknown as BotTokenRow, req), ...extra });
}

// 운영 상태 점검용 엔드포인트.
//
// 목적 두 가지:
//  1) 설정 파손을 런타임에서 드러낸다. 2026-09-05 사고(프로덕션 암호화 키가 hex 가 아니라
//     봇 토큰 복호화가 전부 실패)가 5개월간 안 잡힌 이유는 실패가 조용했기 때문이다.
//  2) 심사 기간(9/21~10/5) 동안 Supabase 비활동 정지를 막는 keep-alive 대상이 된다.
//
// 시크릿 값은 절대 내보내지 않는다. "있다/없다", "형식이 맞다/틀리다" 만 알린다.

import { createHash } from 'node:crypto';
import { platformAnthropicKeyDedicated } from '@/lib/llm/provider';
import { NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { isKeyUsable } from '@/lib/utils/crypto';
import { readGithubAppConfig } from '@/lib/github/app';
import { WIDGET_BOT_HOURLY_LIMIT } from '@/lib/widget/http';

export const dynamic = 'force-dynamic';

export interface ChannelHealth {
  /** 채널톡 자격증명이 저장된 봇 수. */
  configured_bots: number;
  /** 아직 못 보낸 채널톡 되돌림 건수 — 쌓이면 전송 경로가 막힌 것이다. */
  undelivered: number;
  /** 마지막 오류가 기록된 봇 수. after() 안에서 조용히 죽는 실패를 여기서 본다. */
  last_error_bots: number;
}

/**
 * 채널톡 관측값 3개. **health 의 생존 판정에는 쓰지 않는다** — 관측 항목이지 조건이 아니다.
 * 그래서 조회가 실패해도 503 으로 만들지 않고 `null` 을 돌려준다. 숫자가 안 보이는 것과
 * 서비스가 죽은 것은 다른 사건이고, 둘을 같은 신호에 묶으면 진짜 파손을 못 알아본다.
 */
async function readChannelStats(): Promise<ChannelHealth | null> {
  try {
    const db = getServiceRoleClient();
    const [configured, undelivered, lastError] = await Promise.all([
      db
        .from('bots')
        .select('id', { count: 'exact', head: true })
        .not('channel_access_key_encrypted', 'is', null),
      // 대화의 입구로 좁힌다 — 카카오 되돌림도 대기열에 미전달로 남으므로
      // source 를 안 걸면 카카오 대기열이 채널톡 장애로 보인다.
      db
        .from('responses')
        .select('id, conversations!inner(source)', { count: 'exact', head: true })
        .eq('response_type', 'loop_closed')
        .is('delivered_at', null)
        .eq('conversations.source', 'channel'),
      db
        .from('bots')
        .select('id', { count: 'exact', head: true })
        .not('channel_last_error_at', 'is', null),
    ]);

    return {
      configured_bots: configured.count ?? 0,
      undelivered: undelivered.count ?? 0,
      last_error_bots: lastError.count ?? 0,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const config = {
    encryption_key_usable: isKeyUsable(),
    anthropic_api_key: Boolean(process.env.ANTHROPIC_API_KEY),
    github_token: Boolean(process.env.GITHUB_TOKEN),
    google_api_key: Boolean(process.env.GOOGLE_API_KEY),
    nextauth_secret: Boolean(process.env.NEXTAUTH_SECRET),
    openai_api_key: Boolean(process.env.OPENAI_API_KEY),
    // 방문자 이메일 답장(Postmark). 없으면 위젯의 「…로 답장을 보내드려요」가 거짓이 된다.
    postmark_server_token: Boolean(process.env.POSTMARK_SERVER_TOKEN),
    supabase_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  // 플랫폼 폴백 설정. **config 밖에 둔다** — 값이 없는 것도 정상 상태이기 때문이다
  // (env 가 없으면 코드가 gemini + 추천 기본값으로 떨어진다). config 안에 넣으면
  // 안 정한 것만으로 health 가 degraded 로 뒤집힌다.
  //
  // provider **이름만** 싣는다. `PLATFORM_LLM_MODEL` 값은 안 싣는다 — 모델명은 우리
  // 비용 구조를 드러내는 운영 정보이고, "env 가 런타임에 도달했는가"는 이 한 줄로 확인된다.
  // (`vercel env pull` 은 Sensitive 변수를 빈 값으로 주므로 확인 수단이 여기뿐이다)
  //
  // 모델은 **sha256 앞 8자만** 싣는다(2026-09-12). 분류 감사에서 코드 기본값
  // `RECOMMENDED.gemini`(3.5-flash-lite)와 기록(2.5-flash-lite)이 어긋났는데, Secret 이라
  // 대시보드에서도 읽을 수 없었다. 후보 문자열의 해시를 로컬에서 만들어 대조하면
  // 어느 쪽인지 확정되고, 밖에는 모델명이 나가지 않는다. env 가 없으면 null — 그때는
  // `RECOMMENDED` 가 쓰인다는 뜻이다.
  const platformModel = process.env.PLATFORM_LLM_MODEL?.trim();
  const runtime = {
    platform_llm_provider: process.env.PLATFORM_LLM_PROVIDER?.trim() || null,
    // 폴백 anthropic 키가 자동 PR 엔진 키와 분리돼 있는지(provider.ts). false 면 위젯 429 가 PR 을 같이 막을 수 있다
    platform_anthropic_key_dedicated: platformAnthropicKeyDedicated(),
    platform_llm_model_sha8: platformModel ? createHash('sha256').update(platformModel).digest('hex').slice(0, 8) : null,
    // 카카오 웹훅은 서명이 없어 2026-09-14 에 닫았다(I-34). 켜져 있으면 무인증 POST 를
    // 받는다는 뜻이라, 「지금 열렸나」가 밖에서 보여야 한다.
    kakao_webhook: process.env.KAKAO_WEBHOOK_ENABLED === 'true' ? 'open' : 'closed',
    // 위젯 봇별 시간당 상한(T10). 익명 위젯 POST 가 429 를 받았을 때 「상한이 몇이었나」를
    // 배포된 코드에 직접 물어볼 수 있어야 한다 — 값이 상수라 배포마다 달라질 수 있다.
    widget_bot_hourly_limit: WIDGET_BOT_HOURLY_LIMIT,
  };
  // GitHub App 설치형 연결(안 B). **config 밖** — env 가 없으면 설치형이 «꺼진 것»이고 PAT·공용 경로가 그대로 돈다.
  // 단 봇 행에 설치가 기록돼 있는데 env 가 빠지면 github-auth 가 토큰 경로로 내려가며 error 로그를 남긴다 — 그때 여기서 먼저 보인다
  const githubApp = (() => {
    const c = readGithubAppConfig();
    return { configured: c !== null, slug: c?.slug ?? null, webhook_secret: Boolean(c?.webhookSecret) };
  })();

  // Supabase 왕복 — 연결이 살아 있는지 확인하고, 비활동 정지도 함께 방지한다.
  let database: { ok: boolean; error?: string } = { ok: false };
  try {
    const client = getServiceRoleClient();
    const [bots, grouping] = await Promise.all([
      // github_token_encrypted 를 함께 고른다 — B5 는 이 컬럼 조회가 «실패»하면 공용 토큰으로 흘리지 않고 throw 하므로
      // (fail-closed) 마이그레이션 20260913_05 가 빠진 배포는 PR 루프 전체가 죽는다. 여기서 먼저 드러나게 한다
      client.from('bots').select('id, github_token_encrypted', { count: 'exact', head: true }),
      // 자동 묶기(I-10, `20260916_03`) 컬럼. 마이그레이션이 코드보다 늦은 배포에선 위젯이
      // 인사이트를 저장할 때마다 `auto_grouping_request` 가 실패한다 — 제보는 남지만 묶기가 멎는다.
      client.from('grouping_revisions').select('auto_group_due_at', { count: 'exact', head: true }),
    ]);
    const error = bots.error ?? grouping.error;
    database = error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    database = { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }

  const channel = await readChannelStats();

  const configOk = Object.values(config).every(Boolean);
  const healthy = configOk && database.ok;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checked_at: new Date().toISOString(),
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_COMMIT_SHA || 'local').slice(0, 7),
      config,
      runtime,
      github_app: githubApp,
      // 채널톡 관측. **`config` 밖 최상위 키다** — `config` 는 위에서
      // `Object.values(config).every(Boolean)` 로 접히므로, 값이 0 인 **정상** 상태
      // (설정한 봇 0 · 미전달 0 · 오류 봇 0)가 falsy 로 읽혀 healthy 가 뒤집히고
      // 503 이 된다. 그러면 keep-alive 와 배포 확인(commit)이 상시 degraded 로 떠서
      // 진짜 파손을 못 알아본다. `runtime` 이 같은 이유로 밖에 있다.
      channel,
      database,
    },
    { status: healthy ? 200 : 503 },
  );
}

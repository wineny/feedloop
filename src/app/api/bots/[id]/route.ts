// 봇 설정 변경 — 지금은 PR 모드(승인/자동)만 받는다.
//
// 자동 모드는 크론이 우리 GITHUB_TOKEN 으로 그 봇의 레포에 PR 을 여는 것이라
// 소유자 확인 없이 바뀌면 안 된다. 위젯 모양(appearance)과 같은 게이트를 쓴다.
//
// 채널톡이 연결된 봇은 자동 모드 자체를 막는다(계획 U4). 웹훅 토큰이 새면
// 익명 POST → 인사이트 → 묶음 → 크론 → **사람 없이 PR** 까지 사슬이 이어진다.
// 토큰은 URL 경로에 있어 요청 로그에 남는 값이라 「안 샐 것이다」에 기댈 수 없다.
// 사슬을 「사람이 승인」 한 칸으로 끊는다.

import { removeBotShots, sweepBotShotPrefix } from '@/lib/widget/shots';
import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { invalidateBotCache } from '@/lib/bot/core';

export const dynamic = 'force-dynamic';

/**
 * 삭제를 막는 실행 상태. DB 의 활성 유니크 인덱스(`auto_dev_active_group`)와 같은 집합이다 —
 * 엔진이 리스를 쥔 채 봇 행이 사라지면 결과 저장이 실패하고 GitHub 에 브랜치·PR 이 고아로 남는다.
 */
const ACTIVE_RUN_STATUSES = ['running', 'in_progress'] as const;

// ── 서비스 삭제 (I-25, 2026-09-16 ny 결정: 하드 삭제) ──────────
//
// 지워지는 범위는 DB 가 정한다. 프로덕션 실측(2026-09-16): bots 를 참조하는 12개 테이블
// (messages·insights·responses·conversations·insight_groups·auto_dev_runs·bot_usage·
// insight_message_sources·grouping_revisions·classification_recovery_cycles·
// handoff_email_deliveries·cooldown_state)이 전부 ON DELETE CASCADE 다. 앱이 테이블 목록을
// 들고 있지 않는 이유 — 목록을 손으로 적으면 다음 마이그레이션이 하나를 빠뜨린다.
//
// `user_id` 를 WHERE 에 한 번 더 건다. 소유 확인은 위에서 끝났지만 삭제는 되돌릴 수 없어
// 검사와 실행 사이의 창(소유권이 바뀌는 일은 없지만)을 DB 에서 한 번 더 닫는다.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const db = getServiceRoleClient();

  const { count, error: runError } = await db
    .from('auto_dev_runs')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', id)
    .in('status', [...ACTIVE_RUN_STATUSES]);

  if (runError) {
    console.error(`[bots/${id}] active run check failed:`, runError.message);
    return NextResponse.json({ error: '삭제 전 확인에 실패했습니다. 다시 시도해 주세요' }, { status: 500 });
  }
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: '수정안을 만드는 중이에요. 끝난 뒤 다시 시도해 주세요' },
      { status: 409 },
    );
  }

  // 「화면에서 선택하기」 스크린샷(I-55) — DB CASCADE 는 Storage 객체를 안 지운다. 봇 행이 사라지면
  // 경로를 알 길이 없으니 «먼저» 비운다. 못 비우면 봇도 안 지운다(다시 누르면 된다).
  if (!(await removeBotShots(id))) {
    return NextResponse.json({ error: '저장된 화면 이미지를 지우지 못했습니다. 다시 시도해 주세요' }, { status: 500 });
  }

  const { data, error } = await db
    .from('bots')
    .delete()
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select('id');

  if (error) {
    console.error(`[bots/${id}] delete failed:`, error.message);
    return NextResponse.json({ error: '삭제하지 못했습니다' }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: '봇을 찾을 수 없습니다' }, { status: 404 });
  }

  // 위젯·웹훅이 메모리에 물고 있던 봇 설정을 버린다 — 안 그러면 이 인스턴스에서는 지운 봇이 잠시 더 답한다.
  invalidateBotCache(id);
  // 경로를 읽은 뒤 삭제 전에 들어온 업로드는 행이 CASCADE 로 사라졌다 — 접두사 아래를 한 번 더 비운다
  await sweepBotShotPrefix(id);

  return NextResponse.json({ deleted: true });
}

const PR_MODES = ['approve', 'auto'] as const;
type PrMode = (typeof PR_MODES)[number];

function isPrMode(v: unknown): v is PrMode {
  return typeof v === 'string' && (PR_MODES as readonly string[]).includes(v);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { pr_mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
  }

  if (!isPrMode(body.pr_mode)) {
    return NextResponse.json({ error: 'pr_mode 는 approve 또는 auto 여야 합니다' }, { status: 400 });
  }

  const db = getServiceRoleClient();

  if (body.pr_mode === 'auto') {
    const { data: bot } = await db
      .from('bots')
      // 값은 판정에만 쓰고 응답에는 싣지 않는다 — 암호문이라도 내보낼 이유가 없다.
      .select('channel_access_key_encrypted')
      .eq('id', id)
      .maybeSingle();

    const connected = (bot as { channel_access_key_encrypted?: string | null } | null)
      ?.channel_access_key_encrypted;
    if (connected) {
      return NextResponse.json(
        { error: '채널톡이 연결된 서비스는 승인 모드만 쓸 수 있어요' },
        { status: 400 },
      );
    }
  }

  const { data, error } = await db
    .from('bots')
    .update({ pr_mode: body.pr_mode })
    .eq('id', id)
    .select('id, pr_mode')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: '저장하지 못했습니다' }, { status: 500 });
  }

  return NextResponse.json(data);
}

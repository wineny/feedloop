import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { codeFixBlockedReason, isCodeFixable } from '@/lib/groups/policy';

export async function POST(req: NextRequest) {
  // 1. 인증 확인
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 인사이트 1건(예전 경로) 또는 묶음 1개(설계 §5)로 실행한다.
  let { insightId, groupId } = await req.json().catch(() => ({}));
  if ((!insightId && !groupId) || (insightId && groupId)) {
    return NextResponse.json({ error: 'insightId 또는 groupId가 필요합니다' }, { status: 400 });
  }

  const targetId=groupId ?? insightId;
  if(typeof targetId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) return NextResponse.json({error:'유효한 대상 ID가 필요합니다'},{status:400});
  const db = getServiceRoleClient();

  // 2. 대상 조회 + 봇 확인
  let targetBotId: string | null = null;

  if (groupId) {
    const { data: group } = await db
      .from('insight_groups')
      .select('id, bot_id, status, category, follow_up_pending')
      .eq('id', groupId)
      .maybeSingle();

    if (!group) {
      return NextResponse.json({ error: '묶음을 찾을 수 없습니다' }, { status: 404 });
    }
    if (group.status !== 'open' || group.follow_up_pending) {
      return NextResponse.json({ error: '닫힌 묶음입니다' }, { status: 400 });
    }
    // 기능 요청·칭찬·문의에 코드 수정 PR 을 여는 것은 대개 틀린 답이다 (설계: lib/groups/policy).
    // 화면에서도 버튼을 안 띄우지만, 직접 호출을 막는 건 여기다.
    if (!isCodeFixable(group.category)) {
      return NextResponse.json({ error: codeFixBlockedReason(group.category) }, { status: 400 });
    }
    targetBotId = group.bot_id;
  } else {
    const { data: insight, error: insightError } = await db
      .from('insights')
      .select('id, bot_id, category, group_id')
      .eq('id', insightId)
      .single();

    if (insightError || !insight) {
      return NextResponse.json({ error: '피드백 묶음을 찾을 수 없습니다' }, { status: 404 });
    }
    // 소유권을 먼저 본다 — 아래 400/409 는 남의 인사이트의 «상태»를 한 비트씩 흘린다(보안 리뷰 L1).
    const { data: owner } = await db.from('bots').select('user_id').eq('id', insight.bot_id).maybeSingle();
    if (!owner || owner.user_id !== session.user.id) {
      return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
    }
    // 묶음 경로와 «같은 기준»으로 막는다. 예전엔 이 갈래에만 검사가 없어서
    // 기능 요청·문의 인사이트에 직접 호출로 코드 PR 을 열 수 있었다
    // (화면의 「PR 만들기」 버튼도 feature_request 에 떠 있었다).
    if (!isCodeFixable(insight.category)) {
      return NextResponse.json({ error: codeFixBlockedReason(insight.category) }, { status: 400 });
    }
    targetBotId = insight.bot_id;
    // I-10 — 인사이트 단건 PR 은 더 이상 만들지 않는다. 묶였으면 그 묶음으로 보내고,
    // 아직이면 자동 묶기(제보 뒤 약 1~2분)를 기다리라고 말한다. 화면 진입점은 0 이지만
    // 예전 클라이언트·직접 호출이 조각마다 PR 을 여는 경로를 서버가 막는다.
    if (!insight.group_id) {
      return NextResponse.json(
        { error: '아직 묶이지 않은 피드백이에요. 잠시 뒤 자동으로 묶이면 대시보드의 「피드백 묶음」에서 수정안을 만들어 주세요.' },
        { status: 409 },
      );
    }
    groupId = insight.group_id;
    insightId = null;
  }

  // 봇의 github_repo_url 확인
  const { data: bot } = await db
    .from('bots')
    .select('id, github_repo_url, user_id')
    .eq('id', targetBotId)
    .single();

  if (!bot || bot.user_id !== session.user.id) {
    return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
  }

  if (!bot.github_repo_url) {
    return NextResponse.json(
      { error: 'github_repo_url이 설정되지 않았습니다. 봇 설정에서 GitHub 저장소 URL을 입력해주세요.' },
      { status: 400 },
    );
  }

  // 3. auto_dev_runs 기록
  const { data: runId, error: runError } = await db.rpc('create_pipeline_run', {p_bot_id:targetBotId,p_group_id:groupId ?? null,p_insight_id:insightId ?? null});
  const run = runId ? {id:runId} : null;

  if (runError || !run) {
    return NextResponse.json({ error: runError?.message ?? '실행 기록 생성 실패' }, { status: runError?.message.includes('hold') ? 409 : 500 });
  }

  // 4. stream URL 반환
  return NextResponse.json({
    runId: run.id,
    streamUrl: `/api/auto-dev/stream?runId=${run.id}`,
  });
}

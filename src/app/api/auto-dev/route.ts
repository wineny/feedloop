import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { codeFixBlockedReasonKey, isCodeFixable } from '@/lib/groups/policy';
import { apiText } from '@/lib/http/api-text';
import { isSampleConversation } from '@/lib/demo/sample-marker';

/**
 * true when every conversation behind the group's insights is a seeded sample visitor; false when any is real or
 * none is found; null when a lookup failed (the caller refuses — never guess «not sample»).
 */
async function isSampleOnlyGroup(db: ReturnType<typeof getServiceRoleClient>, groupId: string): Promise<boolean | null> {
  const ins = await db.from('insights').select('message_id').eq('group_id', groupId).limit(2000);
  if (ins.error) return null;
  const messageIds = [...new Set((ins.data ?? []).map((r) => r.message_id as string | null).filter((id): id is string => Boolean(id)))];
  if (messageIds.length === 0) return false;
  // `in()` puts the ids in the URL, so 200 at a time (same reason as auto-pr.ts ID_CHUNK).
  const convIds = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 200) {
    const msgs = await db.from('messages').select('conversation_id').in('id', messageIds.slice(i, i + 200)).limit(200);
    if (msgs.error) return null;
    for (const r of msgs.data ?? []) if (r.conversation_id) convIds.add(r.conversation_id as string);
  }
  if (convIds.size === 0) return false;
  const ids = [...convIds];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const convs = await db.from('conversations').select('id, source, external_user_id').in('id', chunk).limit(200);
    if (convs.error) return null;
    const rows = (convs.data ?? []) as { source?: string | null; external_user_id?: string | null }[];
    if (rows.length !== chunk.length || !rows.every(isSampleConversation)) return false;
  }
  return true;
}

export async function POST(req: NextRequest) {
  // 1. 인증 확인
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 인사이트 1건(예전 경로) 또는 묶음 1개(설계 §5)로 실행한다.
  let { insightId, groupId } = await req.json().catch(() => ({}));
  if ((!insightId && !groupId) || (insightId && groupId)) {
    return NextResponse.json({ error: apiText(req, 'targetRequired') }, { status: 400 });
  }

  const targetId=groupId ?? insightId;
  if(typeof targetId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) return NextResponse.json({error:apiText(req, 'targetIdInvalid')},{status:400});
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
      return NextResponse.json({ error: apiText(req, 'groupNotFound') }, { status: 404 });
    }
    if (group.status !== 'open' || group.follow_up_pending) {
      return NextResponse.json({ error: apiText(req, 'groupClosed') }, { status: 400 });
    }
    // 기능 요청·칭찬·문의에 코드 수정 PR 을 여는 것은 대개 틀린 답이다 (설계: lib/groups/policy).
    // 화면에서도 버튼을 안 띄우지만, 직접 호출을 막는 건 여기다.
    if (!isCodeFixable(group.category)) {
      return NextResponse.json({ error: apiText(req, codeFixBlockedReasonKey(group.category)) }, { status: 400 });
    }
    targetBotId = group.bot_id;
  } else {
    const { data: insight, error: insightError } = await db
      .from('insights')
      .select('id, bot_id, category, group_id')
      .eq('id', insightId)
      .single();

    if (insightError || !insight) {
      return NextResponse.json({ error: apiText(req, 'feedbackGroupNotFound') }, { status: 404 });
    }
    // 소유권을 먼저 본다 — 아래 400/409 는 남의 인사이트의 «상태»를 한 비트씩 흘린다(보안 리뷰 L1).
    const { data: owner } = await db.from('bots').select('user_id').eq('id', insight.bot_id).maybeSingle();
    if (!owner || owner.user_id !== session.user.id) {
      return NextResponse.json({ error: apiText(req, 'forbidden') }, { status: 403 });
    }
    // 묶음 경로와 «같은 기준»으로 막는다. 예전엔 이 갈래에만 검사가 없어서
    // 기능 요청·문의 인사이트에 직접 호출로 코드 PR 을 열 수 있었다
    // (화면의 「PR 만들기」 버튼도 feature_request 에 떠 있었다).
    if (!isCodeFixable(insight.category)) {
      return NextResponse.json({ error: apiText(req, codeFixBlockedReasonKey(insight.category)) }, { status: 400 });
    }
    targetBotId = insight.bot_id;
    // I-10 — 인사이트 단건 PR 은 더 이상 만들지 않는다. 묶였으면 그 묶음으로 보내고,
    // 아직이면 자동 묶기(제보 뒤 약 1~2분)를 기다리라고 말한다. 화면 진입점은 0 이지만
    // 예전 클라이언트·직접 호출이 조각마다 PR 을 여는 경로를 서버가 막는다.
    if (!insight.group_id) {
      return NextResponse.json(
        { error: apiText(req, 'notGroupedYet') },
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
    return NextResponse.json({ error: apiText(req, 'forbidden') }, { status: 403 });
  }

  // Seeded sample history (scripts/seed-sample-history.ts) is demo data, not a real report: never a PR for a group
  // whose conversations are all sample visitors. The screen hides the button; this refuses direct calls.
  const sample = await isSampleOnlyGroup(db, groupId as string);
  if (sample === null) return NextResponse.json({ error: apiText(req, 'groupsReadFailed') }, { status: 500 });
  if (sample) return NextResponse.json({ error: apiText(req, 'sampleGroupNoPr') }, { status: 400 });

  if (!bot.github_repo_url) {
    return NextResponse.json(
      { error: apiText(req, 'repoUrlMissing') },
      { status: 400 },
    );
  }

  // 3. auto_dev_runs 기록
  const { data: runId, error: runError } = await db.rpc('create_pipeline_run', {p_bot_id:targetBotId,p_group_id:groupId ?? null,p_insight_id:insightId ?? null});
  const run = runId ? {id:runId} : null;

  if (runError || !run) {
    return NextResponse.json({ error: runError?.message ?? apiText(req, 'runCreateFailed') }, { status: runError?.message.includes('hold') ? 409 : 500 });
  }

  // 4. stream URL 반환
  return NextResponse.json({
    runId: run.id,
    streamUrl: `/api/auto-dev/stream?runId=${run.id}`,
  });
}

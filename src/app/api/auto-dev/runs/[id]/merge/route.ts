// 「서비스에 반영하기」 — 앱 안에서 PR 을 squash 머지하고 그 자리에서 되돌림까지 보낸다 (I-19).
//
// 전에는 운영자가 ①Feedloop → ②GitHub 본문 → ③Checks 의 프리뷰 → ④Merge → ⑤Feedloop 「머지 확인」
// 다섯 번 왔다 갔다 했고 ⑤를 잊으면 되돌림이 크론(하루 1회)까지 밀렸다. 여기서 ④⑤가 한 번에 끝난다.
//
// 막는 것: 빌드 실패·진행 중·충돌(`mergeBlockedBy`). 화면이 같은 함수로 버튼을 잠그지만 서버가
// 다시 본다 — 화면이 본 뒤 빌드가 깨질 수 있다. 되돌림은 `closeLoopForRun` 그대로다(대화별 1건,
// 카카오 대기열, 이메일, 중복 방지 2겹) — 여기서 새 규칙을 만들지 않는다.

import { NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { loadOwnedRun, openPrProblem, crossOriginProblem, commitTitleFrom } from '@/lib/auto-dev/run-access';
import { mergeBlockedBy, mergePr, MergeError, MERGE_BLOCK_MESSAGE } from '@/lib/auto-dev/pr-review';
import { reviewAndPromoteDraft } from '@/lib/auto-dev/draft-promotion';
import { closeLoopForRun } from '@/lib/auto-dev/loop-closed';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await loadOwnedRun(id);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { run } = access;

  // 본문 없는 POST 한 번이 프로덕션 머지와 방문자 통지를 일으킨다 — 같은 사이트에서만
  const cross = crossOriginProblem(req);
  if (cross) return NextResponse.json({ error: cross }, { status: 403 });

  const problem = openPrProblem(run);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  const repoUrl = run.repoUrl as string;
  const prNumber = run.prNumber as number;
  const db = getServiceRoleClient();

  let review;
  try {
    review = await reviewAndPromoteDraft(repoUrl, prNumber, { botId: run.botId, allowUnavailableForMerge: true });
  } catch (err) {
    console.error('[runs/merge] review failed', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'GitHub 에서 PR 상태를 읽지 못했어요. 잠시 후 다시 시도해 주세요' }, { status: 502 });
  }

  // GitHub 에서 이미 머지·닫힘이면 그 사실을 DB 에 맞추고 돌려준다 — 화면이 「열림」이라 거짓말하지 않게
  if (review.merged || review.state === 'closed') {
    const result = await closeLoopForRun({
      id: run.id, bot_id: run.botId, group_id: run.groupId, insight_id: run.insightId,
      pr_url: run.prUrl, pr_number: prNumber, merged_at: null, title: run.title,
    });
    return NextResponse.json(
      { error: review.merged ? MERGE_BLOCK_MESSAGE.merged : MERGE_BLOCK_MESSAGE.closed, synced: result },
      { status: 409 },
    );
  }

  const blocked = mergeBlockedBy(review);
  if (blocked) {
    return NextResponse.json({ error: MERGE_BLOCK_MESSAGE[blocked], blockedBy: blocked }, { status: 409 });
  }

  if (review.draftGateBlocked && !(review.draftGateBlocked === 'checks_unavailable' && review.build.unavailable && !review.draft)) {
    const messages = {
      lock_unavailable: '초안을 검토 요청으로 바꾸는 잠금을 확인하지 못했어요. 잠시 후 다시 시도해 주세요',
      write_failed: 'GitHub에서 자동 검사 게이트 처리를 완료하지 못했어요. 안전하게 반영을 멈췄으니 잠시 후 다시 시도해 주세요',
      gate_failed: '자동 검사 게이트를 확인하지 못했어요. 안전하게 반영을 멈췄으니 잠시 후 다시 시도해 주세요',
      manual_draft: '담당자가 다시 초안으로 둔 PR이에요. GitHub에서 직접 검토 요청으로 바꾼 뒤 반영해 주세요',
      checks_unavailable: '자동 검사 상태를 모두 확인하지 못했어요. GitHub 검사 조회 권한을 확인한 뒤 다시 시도해 주세요',
    };
    return NextResponse.json({ error: messages[review.draftGateBlocked], blockedBy: 'draft_waiting', reason: review.draftGateBlocked }, { status: 409 });
  }


  // 검사가 없는 초안도 처음 10분은 기다린다. GitHub 에 초안 머지를 보내지 않는다.
  if (review.draft) {
    return NextResponse.json({ error: '자동 검사를 기다리는 초안이에요. 잠시 후 다시 시도해 주세요', blockedBy: 'draft_waiting' }, { status: 409 });
  }

  let outcome;
  try {
    outcome = await mergePr(repoUrl, prNumber, {
      expectedHeadSha: review.headSha,
      title: commitTitleFrom(run.title, prNumber),
      // squash 커밋 본문 — 레포 히스토리에서 Feedloop 이 만든 변경임을 알 수 있게
      message: `Feedloop 이 유저 피드백을 근거로 만든 수정안을 담당자가 검토하고 반영했습니다.\n\n${run.prUrl}`,
      headRef: review.headRef,
      headRepo: review.headRepo,
      baseRef: review.baseRef,
    }, { botId: run.botId });
  } catch (err) {
    if (err instanceof MergeError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error('[runs/merge] merge failed', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'GitHub 머지에 실패했어요. 잠시 후 다시 시도해 주세요' }, { status: 502 });
  }

  // 머지는 됐다. 여기서부터 실패해도 되돌림은 「머지 확인」·크론이 다시 시도한다(merged_at 이 null 이면)
  const mergedAt = new Date().toISOString();
  const { error: updateError } = await db
    .from('auto_dev_runs')
    .update({ merged_at: mergedAt, merge_commit_sha: outcome.sha })
    .eq('id', run.id)
    .is('merged_at', null);
  if (updateError) console.error('[runs/merge] merged_at update failed', { runId: run.id, message: updateError.message });
  if (run.groupId) {
    await db.from('insight_groups').update({ status: 'merged', follow_up_pending: true }).eq('id', run.groupId);
  }

  let delivered = 0;
  let emailed = 0;
  let skipped = 0;
  let loopFailed = false;
  try {
    const result = await closeLoopForRun({
      id: run.id, bot_id: run.botId, group_id: run.groupId, insight_id: run.insightId,
      pr_url: run.prUrl, pr_number: prNumber, merged_at: mergedAt, merge_commit_sha: outcome.sha, title: run.title,
    });
    delivered = result.delivered;
    emailed = result.emailed;
    skipped = result.skipped;
  } catch (err) {
    loopFailed = true;
    console.error('[runs/merge] loop-closed failed', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
  }

  return NextResponse.json({
    merged: true,
    mergedAt,
    sha: outcome.sha,
    mergeMethod: outcome.method,
    branchDeleted: outcome.branchDeleted,
    delivered,
    emailed,
    skipped,
    loopError: loopFailed ? '반영 알림을 지금 보내지 못했어요. 「반영됐는지 확인」을 누르면 다시 시도해요' : null,
  });
}

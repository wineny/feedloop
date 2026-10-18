// 「반영하지 않기」 — 앱 안에서 PR 을 닫고 사유를 같이 적는다 (I-19).
//
// 기존 PATCH(`../route.ts`)는 GitHub 에서 닫힌 «뒤에» 사유만 적는 구조였다. 여기서는 닫는 행동과
// 사유가 한 번에 간다 — 사유가 필수다. GitHub 만 닫고 사유를 잊는 경로를 없애려는 것이고,
// 사유가 쌓여야 어떤 실수가 반복되는지 보인다(close-reason.ts).
// 묶음은 `pr_created → open` 으로 되돌린다(`checkMergedRuns` 의 닫힘 분기와 같은 값).

import { NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { loadOwnedRun, openPrProblem, crossOriginProblem, readJsonBounded } from '@/lib/auto-dev/run-access';
import { closePr, getPrReview } from '@/lib/auto-dev/pr-review';
import { parseCloseReasonPatch } from '@/lib/auto-dev/close-reason';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await loadOwnedRun(id);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { run } = access;

  const cross = crossOriginProblem(req);
  if (cross) return NextResponse.json({ error: cross }, { status: 403 });

  const body = await readJsonBounded(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const patch = parseCloseReasonPatch(body.value);
  if (!patch.ok) return NextResponse.json({ error: patch.error }, { status: 400 });
  if (!patch.close_reason) {
    return NextResponse.json({ error: '반영하지 않는 이유를 하나 골라 주세요' }, { status: 400 });
  }

  const problem = openPrProblem(run);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  const repoUrl = run.repoUrl as string;
  const prNumber = run.prNumber as number;

  // 브랜치명·head 레포는 GitHub 에서 읽는다 — DB 에는 없다
  let branchDeleted = false;
  try {
    const review = await getPrReview(repoUrl, prNumber, { botId: run.botId });
    if (review.merged) {
      return NextResponse.json({ error: '이미 GitHub 에서 반영된 수정안이에요. 「반영됐는지 확인」으로 상태를 맞춰 주세요' }, { status: 409 });
    }
    if (review.state !== 'closed') {
      ({ branchDeleted } = await closePr(repoUrl, prNumber, {
        headRef: review.headRef, headRepo: review.headRepo, baseRef: review.baseRef,
      }, { botId: run.botId }));
    }
  } catch (err) {
    console.error('[runs/close] github failed', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'GitHub 에서 PR 을 닫지 못했어요. 잠시 후 다시 시도해 주세요' }, { status: 502 });
  }

  const db = getServiceRoleClient();
  const closedAt = new Date().toISOString();
  const { data, error } = await db
    .from('auto_dev_runs')
    .update({ closed_at: closedAt, close_reason: patch.close_reason, close_note: patch.close_note })
    .eq('id', run.id)
    .select('id, closed_at, close_reason, close_note')
    .single();
  if (error || !data) {
    // GitHub 는 닫혔는데 DB 가 안 따라왔다 — 「머지 확인」이 closed_at 은 찍어 주지만 사유는 다시 골라야 한다
    console.error('[runs/close] update failed', { runId: run.id, message: error?.message });
    return NextResponse.json({ error: 'PR 은 닫혔지만 사유를 저장하지 못했어요. 다시 골라 주세요' }, { status: 500 });
  }
  if (run.groupId) {
    await db.from('insight_groups').update({ status: 'open' }).eq('id', run.groupId).eq('status', 'pr_created');
  }

  return NextResponse.json({
    closedAt: data.closed_at,
    closeReason: data.close_reason,
    closeNote: data.close_note ?? null,
    branchDeleted,
  });
}

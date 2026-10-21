// [AI 에게 확인시키기] — 「확인하지 못한 것」의 `code` 항목 하나를 그 파일을 읽고 다시 판단한다 (I-19).
//
// 본문은 `{ index }` 뿐이다. 무엇을 확인할지는 엔진이 수정안을 만들 때 스스로 적어 둔 것(`files`)이고,
// 여기서 새 질문을 받지 않는다 — 자유 입력은 예산·시간을 못 지키고 프롬프트 주입 통로가 된다.
// 결과는 같은 JSON(`explanation.unverified[index].verdict`)에 쓰고 PR 댓글로도 남긴다.

import { NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { loadOwnedRun, openPrProblem, readJsonBounded } from '@/lib/auto-dev/run-access';
import { getPrReview, commentOnPr } from '@/lib/auto-dev/pr-review';
import { verifyUnverifiedItem, buildVerdictComment } from '@/lib/auto-dev/verify-item';
import { parseStoredExplanation } from '@/lib/auto-dev/explanation';
import { apiText } from '@/lib/http/api-text';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await loadOwnedRun(id, req);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { run } = access;

  const body = await readJsonBounded(req);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const index = (body.value as { index?: unknown } | null)?.index;
  if (!Number.isInteger(index) || (index as number) < 0) {
    return NextResponse.json({ error: apiText(req, 'indexInvalid') }, { status: 400 });
  }

  const problem = openPrProblem(run, req);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  if (!run.explanation) {
    return NextResponse.json({ error: apiText(req, 'noExplanation') }, { status: 409 });
  }
  const item = run.explanation.unverified[index as number];
  if (!item) return NextResponse.json({ error: apiText(req, 'noSuchItem') }, { status: 409 });
  if (item.verifiableBy !== 'code' || item.files.length === 0) {
    return NextResponse.json({ error: apiText(req, 'notVerifiable') }, { status: 409 });
  }
  if (item.verdict) {
    return NextResponse.json({ error: apiText(req, 'alreadyVerified'), explanation: run.explanation }, { status: 409 });
  }

  const repoUrl = run.repoUrl as string;
  const prNumber = run.prNumber as number;
  const db = getServiceRoleClient();

  try {
    const review = await getPrReview(repoUrl, prNumber, { botId: run.botId });
    const verdict = await verifyUnverifiedItem({
      repoUrl,
      botId: run.botId,
      headSha: review.headSha,
      title: run.title,
      explanation: run.explanation,
      item,
      files: review.files.map((f) => ({ path: f.path, patch: f.patch })),
    });

    // The database locks the row and changes only this item, preserving concurrent verdicts.
    const { data: saved, error } = await db.rpc('save_run_verdict', {
      p_run_id: run.id, p_index: index, p_expected_item: item, p_verdict: verdict,
    });
    if (error) return NextResponse.json({ error: apiText(req, 'verifySaveFailed') }, { status: 500 });
    if (!saved) return NextResponse.json({ error: apiText(req, 'verifyChanged') }, { status: 409 });
    const next = parseStoredExplanation(saved);
    if (!next) return NextResponse.json({ error: apiText(req, 'explanationFormat') }, { status: 500 });

    // 저장이 끝난 뒤에만 댓글 — 저장에 진 요청이 댓글만 두 번 남기지 않게
    const commented = await commentOnPr(repoUrl, prNumber, buildVerdictComment(item, verdict), { botId: run.botId });
    return NextResponse.json({ explanation: next, verdict, commented });
  } catch (err) {
    console.error('[runs/verify]', { runId: run.id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: apiText(req, 'verifyFailed') }, { status: 502 });
  }
}

// 「수정 PR」 상세가 GitHub 에서 읽는 것 — diff · 프리뷰 URL · 빌드 상태 (I-19).
//
// 화면은 이걸 상세를 열 때 한 번, 빌드가 진행 중이면 1분마다 다시 읽는다.
// 설명(`explanation`)은 DB 것이 우선이고, 이 기능 전 실행이면 PR 본문에서 최선을 뽑아 돌려준다.

import { NextResponse } from 'next/server';
import { loadOwnedRun } from '@/lib/auto-dev/run-access';
import { mergeBlockedBy } from '@/lib/auto-dev/pr-review';
import { reviewAndPromoteDraft } from '@/lib/auto-dev/draft-promotion';
import { extractLegacyExplanation } from '@/lib/auto-dev/explanation';
import { extractPickedTargets } from '@/lib/auto-dev/picked-targets';
import { loadRunPickedShots } from '@/lib/widget/shots';
import { apiText } from '@/lib/http/api-text';
import { localeFromRequest } from '@/i18n/server-locale';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await loadOwnedRun(id, req);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const { run } = access;

  if (!run.prUrl || !run.prNumber || !run.repoUrl) {
    return NextResponse.json({ error: apiText(req, 'noPrYet') }, { status: 409 });
  }

  try {
    const [review, pickedShots] = await Promise.all([
      reviewAndPromoteDraft(run.repoUrl, run.prNumber, { botId: run.botId }),
      // 근거 제보가 짚은 화면(I-55) — 소유 확인(loadOwnedRun)을 지난 뒤, 10분 서명 URL 로
      loadRunPickedShots(run, 3, localeFromRequest(req, 'operator')),
    ]);
    // 담당자에게 PR 본문 원문은 필요 없다 — 옛 실행의 설명을 뽑는 데만 쓰고 내보내지 않는다
    const { body, ...rest } = review;
    return NextResponse.json({
      review: rest,
      blockedBy: mergeBlockedBy(review),
      legacyExplanation: run.explanation ? null : extractLegacyExplanation(body),
      // 짚은 요소와 그리는 파일 — 대조 결과가 본문에만 있어 여기서 뽑아 상세에 한 줄로(B3 3차 후속)
      pickedTargets: extractPickedTargets(body),
      pickedShots,
    });
  } catch (err) {
    // 원문(토큰 부재·GitHub 응답)은 로그에만 — 화면엔 고정 문구
    console.error('[runs/pr]', { runId: id, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: apiText(req, 'prReadFailed') }, { status: 502 });
  }
}

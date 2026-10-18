// "머지됐는지 지금 확인" — 대시보드 버튼용.
// 크론과 같은 일을 하지만 세션 인증이고 자기 봇만 본다.
// 시연에서 크론 주기를 기다리지 않으려고 둔다.

import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { checkMergedRuns } from '@/lib/auto-dev/loop-closed';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { botId } = await req.json().catch(() => ({}));

  const auth = await resolveOwnedBots(botId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.botIds.length === 0) {
    return NextResponse.json({ checked: 0, merged: 0, delivered: 0, deferred: 0, skipped: 0 });
  }

  try {
    const { results, skipped } = await checkMergedRuns(auth.botIds);
    return NextResponse.json({
      checked: results.length,
      failed: results.filter(r => r.error).length,
      failures: results.filter(r => r.error).map(r => ({ runId: r.runId, error: r.error })),
      merged: results.filter((r) => r.merged).length,
      delivered: results.reduce((sum, r) => sum + r.delivered, 0),
      // 화면이 「몇 건은 아직 못 보냈다」를 말할 수 있어야 한다. 조용히 0 으로 보이면
      // 운영자는 다 갔다고 믿는다.
      deferred: results.reduce((sum, r) => sum + r.deferred, 0),
      skipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '확인에 실패했습니다';
    console.error('[loop/check-merged]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

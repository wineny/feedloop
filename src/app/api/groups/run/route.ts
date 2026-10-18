// "지금 묶기" — 아직 묶이지 않은 인사이트를 지금 묶는다(자동 묶기의 폴백, 같은 잠금을 쓴다).

import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { runGroupingNow } from '@/lib/groups/auto-grouping';

// Gemini 한 번 + 묶음 수만큼의 insert. 기본값에 기대지 않고 의도를 박는다.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { botId } = await req.json().catch(() => ({}));

  const auth = await resolveOwnedBots(botId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.botIds.length === 0) {
    return NextResponse.json({ grouped: 0, groups: [], message: '등록된 봇이 없습니다' });
  }

  try {
    // 자동 묶기와 같은 잠금을 탄다 — 자동 실행이 도는 봇은 건너뛰고 `busy` 로 알린다(겹치면 revision 충돌로 503).
    const result = await runGroupingNow(auth.botIds, Date.now()+100_000);
    return NextResponse.json({...result,...(result.failures?.length ? {error:'일부 묶기에 실패했습니다. 실패 기록을 확인하고 다시 시도하세요.'}: {})},{status:result.failures?.length ? 503 : 200});
  } catch (err) {
    const message = err instanceof Error ? err.message : '묶기에 실패했습니다';
    console.error('[groups/run]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

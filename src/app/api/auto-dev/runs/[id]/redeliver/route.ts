// 「되돌림 재전송」 — 「수정 PR」 상세의 버튼.
//
// 크론을 새로 만들 수 없어서(Vercel Hobby 2개 상한이 이미 꽉 찼다) 못 보낸 되돌림의
// 회복 경로가 둘뿐이다: 그 유저가 다시 말을 걸 때, 그리고 사람이 이 버튼을 누를 때.
// 조용한 유저에게는 **이쪽이 유일한 경로**라 시연의 주 경로이기도 하다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { retryUndeliveredForRun, MANUAL_RETRY_MAX } from '@/lib/channel/redeliver';
import { apiText } from '@/lib/http/api-text';

/** 건당 3초 × 최대 5건 + DB 왕복. 사람이 기다리는 화면이라 넉넉히 잡되 상한은 둔다. */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const db = getServiceRoleClient();

  const { data: run, error: loadError } = await db
    .from('auto_dev_runs')
    .select('id, bot_id')
    .eq('id', id)
    .maybeSingle();

  // DB 오류를 404 로 뭉개면 운영자가 엉뚱한 곳을 찾는다.
  if (loadError) {
    return NextResponse.json(
      { error: apiText(req, 'runReadFailed', { message: loadError.message }) },
      { status: 500 },
    );
  }
  // 남의 봇 run 은 404 로 — 존재 여부를 알려주지 않는다.
  if (!run || !auth.botIds.includes(run.bot_id as string)) {
    return NextResponse.json({ error: apiText(req, 'runNotFound') }, { status: 404 });
  }

  const outcome = await retryUndeliveredForRun(id, MANUAL_RETRY_MAX);

  // 다섯 칸을 접지 않고 그대로 내보낸다. 화면이 「고쳐야 할 것」(exhausted)과
  // 「다시 누르면 되는 것」(remaining)과 「그냥 기다리면 되는 것」(skippedNonChannel)을
  // 구분해 말해야 하는데, 한 숫자로 합치면 그 구분이 사라진다.
  // 다섯 개가 전부 0 이면 보낼 되돌림이 없었다는 뜻이다 — 성공도 실패도 아니다.
  return NextResponse.json(outcome);
}

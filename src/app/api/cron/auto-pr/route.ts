// 자동 PR 크론 — pr_mode='auto' 인 봇마다 가장 큰 묶음 1개에 PR 을 만든다 (설계 §5).
//
// ⚠️ Hobby 플랜은 하루 1회보다 잦은 크론이면 배포 자체가 거부된다 (CLAUDE.md 교훈).
// vercel.json 의 스케줄은 `0 0 * * *`(KST 09:00) 로 둔다.

import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { runAutoPrForBot, type AutoPrBotResult } from '@/lib/auto-dev/auto-pr';

// 2-pass 엔진 한 번이 85~128초. 봇 하나 끝낸 뒤 남은 시간이 넉넉할 때만 다음 봇을 시작한다.
export const maxDuration = 300;
const NEXT_BOT_DEADLINE_MS = 150_000;

export async function GET(req: NextRequest) {
  // Vercel 크론은 Authorization: Bearer <CRON_SECRET> 을 붙여 부른다.
  // 열려 있으면 아무나 남의 레포에 PR 을 만들 수 있다.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET이 설정되지 않았습니다' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const db = getServiceRoleClient();
  const { data: bots,error:botError } = await db
    .from('bots')
    .select('id')
    .eq('pr_mode', 'auto')
    .not('github_repo_url', 'is', null)
    // U4 — 채널톡이 붙은 봇은 자동 PR 대상이 아니다.
    //
    // PATCH 쪽 두 게이트가 이미 pr_mode 를 approve 로 묶어 두지만, 그건 read-then-write 라
    // 경합에서 새어 나갈 수 있고 앞으로 생길 다른 쓰기 경로는 그 게이트를 안 지날 수도 있다.
    // 사람이 안 보는 크론이 남의 레포에 PR 을 여는 일이라 최종 방어를 여기 한 겹 더 둔다 —
    // 조건이 쿼리에 있으면 어떤 경로로 pr_mode 가 바뀌든 이 크론은 그 봇을 집지 않는다.
    .is('channel_access_key_encrypted', null)
    .order('created_at', { ascending: true });

  if(botError) return NextResponse.json({error:botError.message},{status:500});
  const results: AutoPrBotResult[] = [];
  let deferred = 0;

  for (const bot of bots ?? []) {
    if (Date.now() - started > NEXT_BOT_DEADLINE_MS) {
      // 시간이 모자라 오늘은 못 도는 봇. 내일 다시 앞에서부터 돈다.
      deferred += 1;
      continue;
    }
    results.push(await runAutoPrForBot(bot.id as string, started + 240_000));
  }

  const created = results.filter((r) => r.prUrl).length;
  // 익명 1인 묶음이라 막힌 봇 수(I-34 ③). 「고를 게 없었다」와 달리 **누가 익명으로 PR 을
  // 만들려 했다**는 신호일 수 있어, 로그 한 줄에서 바로 보이게 따로 센다.
  const anonymousBlocked = results.filter((r) => r.skippedReason === 'anonymous_only').length;
  console.log(
    `[cron/auto-pr] 봇 ${results.length} · PR ${created} · 익명차단 ${anonymousBlocked} · 미룸 ${deferred} · ${Date.now() - started}ms`,
  );
  return NextResponse.json({ bots: results.length, created, anonymousBlocked, deferred, results });
}

// PR 머지 감지 크론 — 머지된 PR 을 찾아 되돌림을 만든다.
//
// GitHub 웹훅을 쓰지 않는 이유: 운영자 레포마다 웹훅 등록을 요구하게 된다.
// 폴링은 GITHUB_TOKEN 만 있으면 되고, 놓쳐도 다음 주기에 다시 본다.

import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { checkMergedRuns } from '@/lib/auto-dev/loop-closed';
import { cleanupShots, type ShotCleanupResult } from '@/lib/widget/shots';

/**
 * 「화면에서 선택하기」 스크린샷 정리(I-55) — 붙지 않은 지 24시간 된 고아 + 보존 90일 지난 것.
 * 새 크론 칸이 없어(Hobby 2칸 다 씀) 여기 얹는다. 머지 확인과 무관한 일이라 그쪽이 실패해도 돈다.
 * 실패는 결과에만 남긴다 — 정리가 막혀도 되돌림 크론이 500 이 되면 안 된다.
 */
async function runShotCleanup(): Promise<ShotCleanupResult> {
  try {
    const shots = await cleanupShots();
    console.log(`[cron/check-merged] 화면 정리 · 고아 ${shots.orphans} · 기한 경과 ${shots.expired}${shots.failed ? ' · 일부 실패' : ''}`);
    return shots;
  } catch (err) {
    console.error('[cron/check-merged] 화면 정리 실패', err instanceof Error ? err.message : err);
    return { orphans: 0, expired: 0, failed: true };
  }
}

// GitHub 왕복 + 대화 조회가 run 수만큼 돈다.
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  // Vercel 크론은 Authorization: Bearer <CRON_SECRET> 을 붙여 부른다.
  // 이 라우트는 인증 없이 열려 있으면 아무나 되돌림을 트리거할 수 있다.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET이 설정되지 않았습니다' }, { status: 500 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 봇 조회 실패를 삼키지 않는다 — 빈 배열로 흘리면 「확인 0건」이 성공처럼 보인다.
    const db = getServiceRoleClient();
    const { data: bots, error } = await db.from('bots').select('id');
    if (error) throw new Error(`follow_up_bots_lookup_failed: ${error.message}`);
    const botIds = (bots ?? []).map((b) => b.id as string);

    const { results, skipped } = await checkMergedRuns(botIds);
    const merged = results.filter((r) => r.merged);
    const delivered = results.reduce((sum, r) => sum + r.delivered, 0);
    // 예산에 걸려 전송을 시도조차 못 한 채널톡 건수. 이 행들은 대기열에 남아
    // 그 유저의 다음 발화나 수동 재전송 버튼이 회수한다 — 유실이 아니다.
    const deferred = results.reduce((sum, r) => sum + r.deferred, 0);

    // 확인하다 던진 run. `skipped`(마감에 걸려 못 본 run)·`deferred`(전송을 미룬 건)와
    // 다르다 — 셋을 한 숫자로 접으면 「기다리면 되는 것」과 「사람이 고쳐야 하는 것」이 섞인다.
    const failures = results
      .filter((r) => r.error)
      .map((r) => ({ runId: r.runId, error: r.error }));

    console.log(
      `[cron/check-merged] 확인 ${results.length} · 머지 ${merged.length} · 되돌림 ${delivered}` +
        ` · 미룸 ${deferred} · 못 본 run ${skipped} · 실패 ${failures.length}`,
    );
    const shots = await runShotCleanup();
    return NextResponse.json({
      shots,
      checked: results.length,
      merged: merged.length,
      delivered,
      deferred,
      skipped,
      failed: failures.length,
      failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('[cron/check-merged]', message);
    await runShotCleanup();
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

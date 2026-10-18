// Gleap 차용 P0-1·P0-2·P1-3 실측 스크립트.
// 실행: npx tsx --env-file=.env.local scripts/verify-gleap-adopt.ts <botId> [--pr] [--spec <groupId>]
//
// auto-dev API 는 next-auth 세션이 필요해서 엔진 함수를 직접 호출한다(spike-autodev.ts 와 같은 이유).

import { createClient } from '@supabase/supabase-js';
import { runGrouping } from '../src/lib/groups/grouping';
import { claimRun, executeClaimedRun, loadRun } from '../src/lib/auto-dev/execute-run';
import { generateGroupSpec } from '../src/lib/groups/spec';
import { loadAutoPrCandidates, pickGroupForAutoPr } from '../src/lib/auto-dev/auto-pr';

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const botId = process.argv[2];
  if (!botId) throw new Error('사용법: verify-gleap-adopt.ts <botId> [--pr] [--spec <groupId>]');

  const specIdx = process.argv.indexOf('--spec');
  if (specIdx > -1) {
    const groupId = process.argv[specIdx + 1];
    console.log(`\n=== 스펙 초안 생성: ${groupId} ===`);
    const result = await generateGroupSpec(groupId);
    console.log(`근거 ${result.evidenceCount}건\n`);
    console.log(result.spec);
    return;
  }

  console.log('\n=== 1. 묶기 ===');
  const grouped = await runGrouping([botId]);
  console.log(JSON.stringify(grouped));

  const { data: groups } = await db()
    .from('insight_groups')
    .select('id, title, category, status, created_at')
    .eq('bot_id', botId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });

  console.log('\n=== 2. open 묶음 ===');
  for (const g of groups ?? []) console.log(`  ${g.id} | ${g.category} | ${g.title}`);

  // 자동 모드 선택 로직도 같이 확인 — 분류 필터·익명 게이트가 실제로 도는지.
  // 후보를 손으로 다시 만들지 않는다. 엔진과 같은 함수를 불러야 여기 출력이 크론과 같아진다.
  const picked = pickGroupForAutoPr(await loadAutoPrCandidates(botId));
  console.log(`\n자동 모드라면 고를 묶음: ${picked ? `${picked.id} (${picked.category}, ${picked.insightCount}건)` : '없음'}`);

  if (!process.argv.includes('--pr')) {
    console.log('\n(--pr 를 붙이면 실제 PR 을 만듭니다)');
    return;
  }

  const target = picked;
  if (!target) throw new Error('PR 대상 묶음이 없습니다');

  console.log(`\n=== 3. PR 생성: ${target.id} ===`);
  const { data: run, error } = await db()
    .from('auto_dev_runs')
    .insert({ bot_id: botId, group_id: target.id, status: 'running' })
    .select('id')
    .single();
  if (error || !run) throw new Error(`run 생성 실패: ${error?.message}`);

  const claimed = await claimRun(run.id);
  if (!claimed) throw new Error('실행권 획득 실패');

  const loaded = await loadRun(run.id);
  if (!loaded) throw new Error('run 로드 실패');

  const started = Date.now();
  const result = await executeClaimedRun(loaded, claimed, (msg) => console.log(`  · ${msg}`));
  console.log(`\n완료 ${Math.round((Date.now() - started) / 1000)}초`);
  console.log(`PR: ${result.pr_url}`);
  console.log(`파일: ${JSON.stringify(result.files_changed)}`);
}

main().catch((err) => {
  console.error('\n실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});

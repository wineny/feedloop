// 스파이크: 카카오 피드백 → 분류된 insight → 자동 PR 생성 루프 검증
// 실행: npx tsx --env-file=.env.local scripts/spike-autodev.ts <insightId>
// auto-dev API 라우트는 next-auth 세션이 필요해서, 엔진 함수를 직접 호출한다.

import { createClient } from '@supabase/supabase-js';
import { callAutoDev } from '../src/lib/auto-dev/ai-engine';

async function main() {
  const insightId = process.argv[2];
  if (!insightId) throw new Error('사용법: spike-autodev.ts <insightId>');

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: insight, error } = await db
    .from('insights')
    .select('id, category, summary, bot_id, messages(body)')
    .eq('id', insightId)
    .single();
  if (error || !insight) throw new Error(`insight 조회 실패: ${error?.message}`);

  const { data: bot } = await db
    .from('bots')
    .select('github_repo_url, service_name')
    .eq('id', insight.bot_id)
    .single();
  if (!bot?.github_repo_url) throw new Error('bots.github_repo_url 없음');

  const messageBody = (insight.messages as unknown as { body: string } | null)?.body || '';
  console.log(`서비스: ${bot.service_name} | 레포: ${bot.github_repo_url}`);
  console.log(`피드백: [${insight.category}] ${insight.summary}`);

  const result = await callAutoDev({
    repoUrl: bot.github_repo_url,
    insight: {
      category: insight.category,
      summary: insight.summary,
      message_body: messageBody,
    },
    onProgress: (m) => console.log(`  → ${m}`),
  });

  if (result.status !== 'published') { console.log(`중단: ${result.reason}`); return; }
  console.log('\n=== PR 생성 (배포·해결 미확인) ===');
  console.log(`PR: ${result.pr_url}`);
  console.log(`변경 파일: ${result.files_changed.map((f) => `${f.path}(${f.action})`).join(', ')}`);
}

main().catch((err) => {
  console.error('스파이크 실패:', err.message);
  process.exit(1);
});

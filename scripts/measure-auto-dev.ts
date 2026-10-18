// 자동 PR 엔진의 단계별 소요를 잰다 — PR 은 만들지 않는다.
//
// 2-pass 가 이미 128초였고 함수 한도는 300초다. 프롬프트에 무엇을 더 넣을 때마다
// 여기로 실측하고 CLAUDE.md 의 시간 기록을 갱신한다. 실 묶음을 그대로 넣어 재현한다.
//
//   npx tsx scripts/measure-auto-dev.ts --env ../app/.env.local --group <insight_groups.id>
//   npx tsx scripts/measure-auto-dev.ts --env ../app/.env.local --group <id> --repo https://github.com/o/r
//   --summary '…' --body '…' [--category ux]   ← 묶음 대신 피드백을 직접 넣어 「수정안이 나오는 경로」를 잰다

import { readFileSync } from 'node:fs';

function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const envPath = arg('env');
  if (envPath) loadEnv(envPath);
  const groupId = arg('group');
  if (!groupId) throw new Error('--group <insight_groups.id> 가 필요합니다');

  // env 를 먼저 채운 뒤에 불러야 supabase 클라이언트가 값을 본다
  const { getServiceRoleClient } = await import('@/lib/supabase');
  const { mergeContextsForPrompt, collectContextItems } = await import('@/lib/widget/context');
  const { prepareCodeFix } = await import('@/lib/auto-dev/ai-engine');
  const { one } = await import('@/lib/auto-dev/execute-run');

  const db = getServiceRoleClient();
  const { data: group, error } = await db
    .from('insight_groups')
    .select('id, title, summary, category, bot_id, bots(github_repo_url)')
    .eq('id', groupId)
    .single();
  if (error || !group) throw new Error(`묶음을 찾지 못했습니다: ${error?.message}`);

  const repoUrl = arg('repo') ?? one<{ github_repo_url: string }>(group.bots)?.github_repo_url;
  if (!repoUrl) throw new Error('레포 URL 이 없습니다 (--repo 로 지정)');

  // execute-run.ts 의 collectGroupEvidence 와 같은 규칙 (대표 5건 · 250자)
  const { data: rows } = await db
    .from('insights')
    .select('summary, messages(body, context)')
    .eq('group_id', groupId)
    .limit(5);
  const bodies = (rows ?? [])
    .map((i) => one<{ body?: string }>(i.messages)?.body ?? i.summary)
    .filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    .map((b) => (b.length > 250 ? `${b.slice(0, 250)}…` : b));
  const raws = (rows ?? []).map((i) => one<{ context?: unknown }>(i.messages)?.context);

  const override = arg('summary');
  const insight = override
    ? {
        category: arg('category') ?? 'ux',
        summary: override,
        message_body: arg('body') ?? override,
      }
    : {
        category: group.category as string,
        summary: group.title as string,
        message_body:
          bodies.length === 0
            ? (group.summary as string)
            : `${group.summary}\n\n실제 제보 ${bodies.length}건:\n${bodies.map((b) => `- ${b}`).join('\n')}`,
        context: mergeContextsForPrompt(raws) || undefined,
        contextItems: collectContextItems(raws),
      };

  console.log(`# ${override ? `피드백 직접 지정: ${override}` : `묶음: ${group.title} (${group.category}) · 제보 ${bodies.length}건`} · 레포 ${repoUrl}`);
  const started = Date.now();
  const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;

  try {
    const prepared = await prepareCodeFix({
      repoUrl,
      insight,
      onProgress: (m) => console.log(`[${stamp()}] ${m}`),
    });
    console.log('\n## 결과');
    console.log(`총 ${((Date.now() - started) / 1000).toFixed(1)}초`);
    console.log('단계별(ms):', prepared.timings);
    console.log('이웃:', prepared.neighbors.map((n) => `${n.path} (${n.content.length}자)`));
    console.log('분석:', prepared.fix.analysis);
    console.log('수정 파일:', prepared.fix.files.map((f) => `${f.path} (${f.action}, ${f.content.length}자)`));
    console.log('리뷰 노트:', prepared.fix.review_notes);
  } catch (err) {
    console.log('\n## 중단');
    console.log(`총 ${((Date.now() - started) / 1000).toFixed(1)}초`);
    console.log(err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

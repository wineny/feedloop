// npx tsx scripts/score-impact.ts --bot <botId> [--apply]
import { config as loadEnv } from 'dotenv';

async function main() {
  const args = process.argv.slice(2);
  const botIndex = args.indexOf('--bot');
  const botId = botIndex >= 0 ? args[botIndex + 1] : undefined;
  if (!botId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(botId)) throw new Error('--bot <botId UUID> 가 필요합니다');
  if (args.some((arg, i) => i !== botIndex + 1 && arg !== '--bot' && arg !== '--apply')) throw new Error('지원 옵션: --bot <botId> [--apply]');
  loadEnv({ path: '.env.local', quiet: true });
  const { getBotConfigFromDB } = await import('../src/lib/bot/core');
  const { scoreGroupImpact } = await import('../src/lib/groups/priority');
  const apply = args.includes('--apply');
  const results = await scoreGroupImpact(botId, await getBotConfigFromDB(botId), { apply });
  console.log(JSON.stringify({ botId, mode: apply ? 'apply' : 'dry-run', groups: results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'impact_scoring_failed');
  process.exitCode = 1;
});

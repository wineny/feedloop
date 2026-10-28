// 데모 봇 비우기 실행부. scripts/reset-demo.ts 는 인자만 읽어 이 함수를 부른다.
// 클라이언트·Storage 정리·출력을 밖에서 받아, 테스트가 가짜 클라이언트로 호출을 기록해 검사한다
// (__tests__/demo-reset-run.test.ts).
//
// 순서
//   1. 데모 봇 확인 — --bot 이 데모 봇이 아니면 거부.
//   2. 표별 개수(+ PR 기록이 있는 실행의 pr_url) 출력. 진행 중인 작업이 있고 --yes 면 거부.
//   3. (--yes) Storage 스크린샷 객체 삭제 → 진행 중 작업 «다시» 확인 → 표 삭제 → 봇 접두사 한 번 더 비우기.
//
// 직접 DELETE 는 전부 `bot_id = <데모 봇>` 으로 묶는다. CASCADE 자식은 부모를 따라 지워진다.

import type { SupabaseClient } from '@supabase/supabase-js';
import { BOT_SCOPE_COLUMN, DEMO_RESET_CASCADE, DEMO_RESET_DELETE, DEMO_RESET_KEEP, IN_FLIGHT } from './reset-plan';

export interface ResetOptions {
  /** --bot <id>. 데모 봇이 아니면 거부한다. */
  botArg?: string;
  /** --yes. false 면 세기만 한다. */
  confirmed: boolean;
  /** 행에 적힌 경로로 Storage 객체를 지운다. false = 실패(아무 행도 안 지운다). */
  removeShots: (botId: string) => Promise<boolean>;
  /** 표를 다 지운 뒤 봇 접두사 아래 남은 객체를 비운다. */
  sweepShots: (botId: string) => Promise<void>;
  log: (line: string) => void;
}

type Bot = { id: string; service_name: string; is_demo: boolean };

const pad = (s: string) => s.padEnd(32);

export async function runReset(db: SupabaseClient, opts: ResetOptions): Promise<void> {
  const { botArg, confirmed, log } = opts;

  const bot = await findDemoBot(db, botArg);
  log(`${confirmed ? 'DELETE' : 'DRY RUN'} — demo bot ${bot.id} (${bot.service_name})`);
  log('');

  const inFlight = await countInFlight(db, bot.id);

  log(confirmed ? 'Rows to delete:' : 'Rows that WOULD be deleted:');
  let total = 0;
  for (const step of DEMO_RESET_DELETE) {
    const n = await countRows(db, step.table, bot.id);
    total += n;
    log(`  ${pad(step.table)}${String(n).padStart(6)}  ${step.what}`);
  }
  for (const c of DEMO_RESET_CASCADE) {
    const n = await countCascaded(db, c, bot.id);
    log(`  ${pad(c.table)}${String(n).padStart(6)}  (cascades from ${c.parent})`);
  }
  log(`  ${pad('total (direct)')}${String(total).padStart(6)}`);
  log('');

  // PR 은 GitHub 에 그대로 남는다 — 기록만 지워지니 어떤 PR 인지 보여 준다.
  const prUrls = await listPrUrls(db, bot.id);
  if (prUrls.length > 0) {
    log('PRs recorded by auto-dev runs (the PRs stay open on GitHub; only the records are deleted):');
    for (const url of prUrls) log(`  ${url}`);
    log('');
  }
  log(`Kept: ${DEMO_RESET_KEEP.join(', ')}`);
  log('');

  if (inFlight.runs > 0 || inFlight.payments > 0) {
    log(describeInFlight(inFlight));
    if (confirmed) throw new Error('refused: wait until they finish (or resolve them in the inbox), then re-run.');
  }

  if (!confirmed) {
    log('Dry run — nothing was deleted. Re-run with --yes to delete.');
    return;
  }

  // Storage 객체는 CASCADE 로 안 지워진다. 행에서 경로를 읽어야 하니 행보다 «먼저» 지운다.
  if (!(await opts.removeShots(bot.id))) {
    throw new Error('widget screenshot files could not be removed — nothing deleted. Re-run to retry.');
  }

  // 첫 확인과 Storage 정리 사이에 PR 생성·환불이 시작됐을 수 있다 — 지우기 직전에 한 번 더 본다.
  const again = await countInFlight(db, bot.id);
  if (again.runs > 0 || again.payments > 0) {
    throw new Error(`${describeInFlight(again)} refused: nothing deleted. Re-run when they finish.`);
  }

  log('Deleted:');
  for (const step of DEMO_RESET_DELETE) {
    const { count, error } = await db.from(step.table).delete({ count: 'exact' }).eq(BOT_SCOPE_COLUMN, bot.id);
    if (error) {
      throw new Error(`delete ${step.table} failed: ${error.message} (earlier tables are already empty; re-run to finish)`);
    }
    log(`  ${pad(step.table)}${String(count ?? 0).padStart(6)}`);
  }

  // 경로를 읽은 뒤 들어온 업로드, 1000 행 넘는 목록에서 빠진 객체 — 봇 접두사 아래를 한 번 더 비운다.
  await opts.sweepShots(bot.id);
  log('Done. The demo bot, its settings, products and approvers are unchanged.');
}

async function findDemoBot(db: SupabaseClient, botArg: string | undefined): Promise<Bot> {
  if (botArg) {
    const { data: pinned, error } = await db
      .from('bots')
      .select('id, service_name, is_demo')
      .eq('id', botArg)
      .maybeSingle();
    if (error) throw new Error(`bot lookup failed: ${error.message}`);
    if (!pinned) throw new Error(`bot ${botArg} not found.`);
    // 데모 봇이 아니면 어떤 플래그로도 진행하지 않는다 — 실제 고객 봇의 대화를 지우는 사고를 막는다.
    if (!(pinned as Bot).is_demo) {
      throw new Error(`refused: bot ${botArg} is not the demo bot (bots.is_demo = false). This script only resets the demo bot.`);
    }
    return pinned as Bot;
  }
  const { data: demo, error } = await db
    .from('bots')
    .select('id, service_name, is_demo')
    .eq('is_demo', true)
    .maybeSingle();
  if (error) throw new Error(`demo lookup failed: ${error.message}`);
  if (!demo) throw new Error('No demo bot found (bots.is_demo = true). Run `npm run db:seed-demo` first.');
  return demo as Bot;
}

async function countRows(db: SupabaseClient, table: string, botId: string): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(BOT_SCOPE_COLUMN, botId);
  if (error) throw new Error(`count ${table} failed: ${error.message}`);
  return count ?? 0;
}

// bot_id 가 없는 자식은 부모를 inner join 해서 센다.
async function countCascaded(
  db: SupabaseClient,
  c: (typeof DEMO_RESET_CASCADE)[number],
  botId: string,
): Promise<number> {
  const { count, error } = await db
    .from(c.table)
    .select(`${c.fk}, ${c.parent}!inner(${BOT_SCOPE_COLUMN})`, { count: 'exact', head: true })
    .eq(`${c.parent}.${BOT_SCOPE_COLUMN}`, botId);
  if (error) throw new Error(`count ${c.table} failed: ${error.message}`);
  return count ?? 0;
}

async function listPrUrls(db: SupabaseClient, botId: string): Promise<string[]> {
  const { data, error } = await db
    .from('auto_dev_runs')
    .select('pr_url')
    .eq(BOT_SCOPE_COLUMN, botId)
    .not('pr_url', 'is', null);
  if (error) throw new Error(`auto-dev PR lookup failed: ${error.message}`);
  return ((data ?? []) as { pr_url: string }[]).map((r) => r.pr_url);
}

async function countInFlight(db: SupabaseClient, botId: string): Promise<{ runs: number; payments: number }> {
  const runs = await db
    .from('auto_dev_runs')
    .select('id', { count: 'exact', head: true })
    .eq(BOT_SCOPE_COLUMN, botId)
    .or(
      `status.in.(${IN_FLIGHT.autoDevRunStatuses.join(',')}),publication_status.in.(${IN_FLIGHT.autoDevPublicationStatuses.join(',')})`,
    );
  if (runs.error) throw new Error(`in-flight run check failed: ${runs.error.message}`);
  const payments = await db
    .from('payment_actions')
    .select('id', { count: 'exact', head: true })
    .eq(BOT_SCOPE_COLUMN, botId)
    .in('status', [...IN_FLIGHT.paymentActionStatuses]);
  if (payments.error) throw new Error(`in-flight payment check failed: ${payments.error.message}`);
  return { runs: runs.count ?? 0, payments: payments.count ?? 0 };
}

function describeInFlight(f: { runs: number; payments: number }): string {
  return `In flight: ${f.runs} auto-dev run(s) still creating a PR, ${f.payments} payment action(s) executing or unresolved.`;
}

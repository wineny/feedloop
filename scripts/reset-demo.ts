// Empties the ONE demo bot back to a clean slate — before recording the demo video and during judging.
// Run when judges are not actively using the widget.
//
//   npx tsx scripts/reset-demo.ts              dry run: prints, per table, how many rows WOULD be deleted
//   npx tsx scripts/reset-demo.ts --yes        deletes them
//     [--bot <id>]   pin the bot id; refused unless that bot is the demo bot (bots.is_demo)
//
// 비우기만 한다(ny 결정 2026-10-27) — 다시 채우지 않는다. 지우는 표·순서·남기는 표는
// src/lib/demo/reset-plan.ts, 실행 순서는 src/lib/demo/reset.ts(runReset). 이 파일은 인자만 읽는다.
// 지우는 것: 대화·메시지·답장·인사이트·묶음·자동개발 실행(PR 기록)·PayPal 주문·환불/승인 행·웹훅 이벤트·
// 스크린샷(Storage 객체 포함)·알림 메일 기록·하루 AI 호출 계수.
// 남기는 것: 봇 행(지식·위젯 모양·환불 한도·PayPal 연결·웹훅 id)·상품·승인자·계정, 그리고 전역 표.
//
// 직접 DELETE 는 전부 `bot_id = <데모 봇>` 으로 묶는다(CASCADE 자식은 부모를 따라 지워진다).
// 다른 봇의 행은 건드리지 않는다. PR 생성이나 환불 실행이 진행 중이면 --yes 를 거부한다
// (중간에 기록을 지우면 돈·PR 이 기록 없이 남는다). 지우기 직전에 한 번 더 확인한다.

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { runReset } from '../src/lib/demo/reset';
import { removeBotShots, sweepBotShotPrefix } from '../src/lib/widget/shots';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const botArg = arg('bot')?.trim();
const confirmed = process.argv.includes('--yes');
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.argv.includes('--bot') && (!botArg || botArg.startsWith('--'))) {
  console.error('Missing value for --bot <id>.');
  process.exit(1);
}
if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

runReset(createClient(supabaseUrl, serviceKey), {
  botArg,
  confirmed,
  removeShots: removeBotShots,
  sweepShots: sweepBotShotPrefix,
  log: (line) => console.log(line),
}).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

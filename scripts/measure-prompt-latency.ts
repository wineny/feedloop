// 분류 기준 블록을 넣어 «카카오 4초 예산»이 깨지지 않는지 잰다. DB 에 쓰지 않는다.
//
// 왜 카카오냐 — 위젯은 10초, 텔레그램은 30초인데 카카오 오픈빌더만 5초 안에 응답해야
// 하고 우리는 4초에서 끊는다. 프롬프트에 무엇을 더할 때 가장 먼저 깨지는 곳이다.
// 널널투어 봇은 지식 6.8K 를 이미 싣고 있어 여유가 가장 적다.
//
//   npx tsx scripts/measure-prompt-latency.ts --env ../app/.env.local --bot <bot_id>
//   npx tsx scripts/measure-prompt-latency.ts --env ../app/.env.local --bot <id> --runs 5

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

loadEnv(resolve(process.cwd(), flag('env') ?? '.env.local'));

const BOT_ID = flag('bot');
const RUNS = Number(flag('runs') ?? 5);
const MODEL = flag('model') ?? 'gemini-2.5-flash';

/** 카카오 스킬 서버가 LLM 에 주는 예산. 이걸 넘기면 폴백 문구가 나간다. */
const KAKAO_BUDGET_MS = 4_000;

async function call(system: string, text: string): Promise<number> {
  const started = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_API_KEY! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: `사용자: ${text}` }] }],
      }),
    },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
  await res.json();
  return Date.now() - started;
}

function report(label: string, ms: number[], chars: number) {
  const sorted = [...ms].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const over = ms.filter((x) => x > KAKAO_BUDGET_MS).length;
  console.log(
    `${label.padEnd(22)} ${String(chars).padStart(6)}자  ` +
      `p50 ${(p50 / 1000).toFixed(2)}초  최대 ${(max / 1000).toFixed(2)}초  ` +
      `4초 초과 ${over}/${ms.length}`,
  );
}

async function main() {
  if (!BOT_ID) throw new Error('--bot <bot_id> 가 필요합니다');

  const { getBotConfigFromDB } = await import('../src/lib/bot/core');
  const { getSystemPrompt } = await import('../src/lib/bot/prompts');
  const { TAXONOMY_BLOCK } = await import('../src/lib/classify/taxonomy');

  const config = await getBotConfigFromDB(BOT_ID);
  const withTaxonomy = getSystemPrompt(config.serviceProfile);
  // 분류 기준을 «빼면» 얼마나 빨라지는지가 이 블록의 비용이다.
  const without = withTaxonomy.replace(TAXONOMY_BLOCK, '');

  // 카카오에서 실제로 오는 성격의 한 문장. 짧은 입력이 가장 흔하다.
  const probe = '예약할 때 날짜 바꾸면 인원수가 초기화돼요';

  console.log(`봇 ${BOT_ID} · 모델 ${MODEL} · ${RUNS}회씩\n`);

  // 번갈아 부른다 — 몰아서 부르면 provider 쪽 웜업 차이가 그대로 결과가 된다.
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    b.push(await call(without, probe));
    a.push(await call(withTaxonomy, probe));
  }

  report('분류 기준 없음', b, without.length);
  report('분류 기준 있음', a, withTaxonomy.length);

  const delta =
    a.reduce((s, x) => s + x, 0) / a.length - b.reduce((s, x) => s + x, 0) / b.length;
  console.log(`\n평균 차이 ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(2)}초`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

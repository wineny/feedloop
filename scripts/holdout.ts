// 골든셋 과적합을 검사하는 도구.
//
// 왜 필요한가 — `evals/classify/golden-set.json` 은 **분류 프롬프트를 쓴 사람이 같이 만들었다.**
// 경계가 애매한 곳에서 내가 고른 라벨 = 프롬프트가 시키는 답이라, 모델이 «옳아서»가 아니라
// «우리 관례에 동의해서» 점수를 받는 부분이 얼마인지 그 숫자만 보면 알 수 없다.
//
// 두 갈래로 가른다.
//
//   generate — 프롬프트를 **한 줄도 안 본** 다른 모델(Claude)이, 다른 도메인에서 새 케이스를
//              만든다. 우리 경계 규칙(해결책제안·후속문의·성능…)을 주지 않는다 — 주면
//              시험 문제를 답안지 보고 내는 셈이다.
//   label    — 같은 모델이 **분류 기준 블록 없이**, 카테고리 이름과 «이 라벨이 그다음에
//              무슨 일을 일으키는가»만 보고 독립적으로 라벨을 단다. 2차 라벨러다.
//
// 그러면 세 숫자가 나온다.
//   ① Gemini(우리 프롬프트) vs 내 라벨        ← 지금까지 재던 것
//   ② Gemini(우리 프롬프트) vs 2차 라벨러      ← 관례를 빼면 남는 실력
//   ③ 2차 라벨러 vs 내 라벨                   ← 내 라벨이 얼마나 «우리만의 답»인지
// ①이 높고 ②③이 낮으면 과적합이다. ②③이 같이 낮으면 그냥 경계가 원래 어려운 것이다.
//
//   npx tsx scripts/holdout.ts generate --env .env.local --count 36
//   npx tsx scripts/holdout.ts label --env .env.local --set evals/classify/holdout-set.json
//   npx tsx scripts/holdout.ts label --env .env.local --set evals/classify/golden-set.json
//   npx tsx scripts/holdout.ts agree --set evals/classify/golden-set.json

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';

function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd !== 'generate' && cmd !== 'label' && cmd !== 'agree') {
  console.error('사용법: holdout.ts <generate|label|agree> [--env .env.local] [--set <path>]');
  process.exit(1);
}
if (cmd !== 'agree') loadEnv(resolve(process.cwd(), flag('env') ?? '.env.local'));

/** 시험 보는 쪽(Gemini)과 **다른 계열**이어야 한다. 같은 계열이면 같은 편향을 공유한다. */
const JUDGE_MODEL = flag('judge') ?? 'claude-opus-5';

interface Case {
  id: string;
  text: string;
  category?: string;
  sentiment?: string | string[];
  boundary?: string;
  note?: string;
}

async function callClaude(system: string, prompt: string): Promise<string> {
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { generateText } = await import('ai');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 없습니다');

  const { text } = await generateText({
    model: createAnthropic({ apiKey })(JUDGE_MODEL),
    system,
    prompt,
    maxOutputTokens: 16000,
    maxRetries: 1,
  });
  return text;
}

function parseJsonArray(text: string): unknown {
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      /* 뒤에 군더더기가 붙은 경우 — 아래로 */
    }
  }
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`JSON 배열을 못 찾았습니다: ${s.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// ── generate ───────────────────────────────────────────
//
// ⚠️ 여기에 우리 분류 기준을 **쓰지 않는다.** 도메인도 널널투어(여행·쿠폰)가 아닌 것으로
// 고른다 — 실데이터 22건이 전부 그 도메인이라, 같은 도메인으로 더 만들면 «분류 기준의
// 판별력»이 아니라 «그 도메인에 얼마나 익숙한가»를 한 번 더 재게 된다.

const GEN_SYSTEM = `당신은 실제 사용자가 쓴 것 같은 제품 피드백 문장을 만드는 사람입니다.
분류나 라벨은 하지 않습니다. 문장만 만듭니다.`;

const GEN_PROMPT = (n: number) => `「프리랜서를 위한 계약·정산 관리 웹서비스」에 들어온
사용자 메시지 ${n}개를 한국어로 만들어 주세요. 이 서비스는 계약서 작성, 전자서명,
청구서 발행, 입금 확인, 세금 자료 정리를 합니다.

실제 고객센터 창에 들어오는 말처럼 쓰세요.
- 길이가 제각각이어야 합니다(한 줄짜리부터 서너 문장까지).
- 말투도 제각각이어야 합니다(짜증, 담담함, 정중함, 반말, 오타).
- 다음 상황이 골고루 섞이게 하세요: 뭔가 작동하지 않을 때 / 작동은 하는데 쓰기
  답답할 때 / 지금 없는 걸 해달라고 할 때 / 그냥 궁금해서 물어볼 때 / 고마움을 표현할 때 /
  서비스와 상관없는 말.
- **${Math.round(n / 3)}개쯤은 어느 쪽인지 딱 잘라 말하기 어려운 것**으로 만드세요.
  두 가지 성격이 한 문장에 섞였거나, 사용자가 문제 대신 원하는 해결책을 말하거나,
  이미 얘기한 건의 진행 상황을 묻거나, 질문인지 요청인지 모호한 것들입니다.

JSON 배열만 출력하세요. 각 항목은 {"text": "..."} 입니다. 설명을 붙이지 마세요.`;

async function generate() {
  const count = Number(flag('count') ?? 36);
  const out = resolve(process.cwd(), flag('out') ?? 'evals/classify/holdout-set.json');
  if (existsSync(out) && !args.includes('--force')) {
    throw new Error(`${out} 이 이미 있습니다. 덮어쓰려면 --force (라벨이 같이 날아갑니다)`);
  }

  console.log(`${JUDGE_MODEL} 로 ${count}건 생성 중...`);
  const raw = await callClaude(GEN_SYSTEM, GEN_PROMPT(count));
  const items = parseJsonArray(raw) as { text?: unknown }[];

  const cases: Case[] = [];
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text.trim() : '';
    if (!text) continue;
    cases.push({ id: `hold:${String(cases.length + 1).padStart(2, '0')}`, text });
  }
  if (cases.length === 0) throw new Error('생성 결과가 비었습니다');

  writeFileSync(
    out,
    JSON.stringify(
      {
        note:
          '홀드아웃. 분류 프롬프트를 보지 않은 모델이 다른 도메인(프리랜서 계약·정산)에서 만들었다. ' +
          'category/sentiment 는 2차 라벨러(holdout.ts label)와 사람이 함께 확정한다.',
        generatedBy: JUDGE_MODEL,
        cases,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  console.log(`${cases.length}건 → ${out}`);
}

// ── label ──────────────────────────────────────────────
//
// 2차 라벨러. **분류 기준 블록을 주지 않는다.** 대신 «이 라벨이 그다음에 무슨 일을
// 일으키는가»만 준다 — 그게 이 분류가 존재하는 진짜 이유이고, 우리 문구를 안 빌리고도
// 판단할 수 있는 유일한 근거다.

const LABEL_SYSTEM = `당신은 제품팀에서 들어온 사용자 메시지를 분류하는 사람입니다.
주어진 여섯 카테고리 중 하나를 고르고, 감정을 고릅니다.

카테고리: bug, ux, feature_request, praise, cs, other
감정: positive, neutral, negative

이 라벨은 다음에 무슨 일이 일어날지를 정합니다.
- bug, ux → 엔지니어가 코드를 고치는 작업으로 넘어갑니다.
- feature_request → 기획 초안을 쓰는 작업으로 넘어갑니다.
- praise, cs, other → 아무 작업도 만들지 않고, 사람이 읽고 답할 수 있게 남습니다.

잘못 보내면 엔지니어가 고칠 것이 없는 곳을 고치려 듭니다. 그 결과를 생각하고 고르세요.
당신의 판단으로 고르세요. 정해진 세부 규칙은 없습니다.`;

async function label() {
  const setPath = resolve(process.cwd(), flag('set') ?? 'evals/classify/holdout-set.json');
  const data = JSON.parse(readFileSync(setPath, 'utf-8')) as { cases: Case[] };

  const out =
    flag('out') ??
    join(dirname(setPath), basename(setPath).replace(/\.json$/, '') + '-secondlabels.json');

  console.log(`${JUDGE_MODEL} 로 ${data.cases.length}건 독립 라벨링...`);

  // 한 번에 다 넣으면 뒤쪽을 대충 본다 — 라우트가 50건에서 그랬듯이. 20건씩 끊는다.
  const CHUNK = 20;
  const labels: Record<string, { category: string; sentiment: string; reason: string }> = {};

  for (let i = 0; i < data.cases.length; i += CHUNK) {
    const chunk = data.cases.slice(i, i + CHUNK);
    const prompt = `다음 메시지를 각각 분류하세요.

${JSON.stringify(chunk.map((c) => ({ id: c.id, text: c.text })))}

JSON 배열만 출력하세요. 각 항목은
{"id": "...", "category": "...", "sentiment": "...", "reason": "한 줄 근거"} 입니다.`;
    const raw = await callClaude(LABEL_SYSTEM, prompt);
    for (const r of parseJsonArray(raw) as Record<string, unknown>[]) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!id) continue;
      labels[id] = {
        category: String(r.category ?? ''),
        sentiment: String(r.sentiment ?? ''),
        reason: String(r.reason ?? ''),
      };
    }
    console.log(`  ${Math.min(i + CHUNK, data.cases.length)}/${data.cases.length}`);
  }

  writeFileSync(
    out,
    JSON.stringify({ labeledBy: JUDGE_MODEL, note: '분류 기준 블록을 보지 않은 2차 라벨러', labels }, null, 2) + '\n',
    'utf-8',
  );
  console.log(`→ ${out}`);
  agree(setPath, out);
}

// ── agree ──────────────────────────────────────────────

function agree(setPath?: string, labelPath?: string) {
  const sp = resolve(process.cwd(), setPath ?? flag('set') ?? 'evals/classify/golden-set.json');
  const lp = resolve(
    process.cwd(),
    labelPath ?? flag('labels') ?? join(dirname(sp), basename(sp).replace(/\.json$/, '') + '-secondlabels.json'),
  );

  const data = JSON.parse(readFileSync(sp, 'utf-8')) as { cases: Case[] };
  const second = JSON.parse(readFileSync(lp, 'utf-8')) as {
    labels: Record<string, { category: string; reason: string }>;
  };

  let compared = 0;
  let same = 0;
  const diffs: string[] = [];
  const pairs = new Map<string, number>();

  for (const c of data.cases) {
    if (!c.category) continue; // 아직 사람 라벨이 없는 홀드아웃
    const s = second.labels[c.id];
    if (!s) continue;
    compared++;
    if (s.category === c.category) {
      same++;
      continue;
    }
    const key = `${c.category} → ${s.category}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
    diffs.push(
      `  ${c.id}  내 라벨 ${c.category} · 2차 ${s.category}` +
        `${c.boundary ? ` [${c.boundary}]` : ''}\n     "${c.text.slice(0, 70)}"\n     2차 근거: ${s.reason}`,
    );
  }

  if (compared === 0) {
    console.log('\n비교할 사람 라벨이 없습니다 (홀드아웃은 라벨을 확정한 뒤 다시 돌리세요)');
    return;
  }
  console.log(`\n2차 라벨러 vs 내 라벨  ${same}/${compared}  ${((same / compared) * 100).toFixed(1)}%`);
  if (pairs.size > 0) {
    console.log('\n갈린 곳 (내 라벨 → 2차)');
    for (const [k, v] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${v}건`);
    console.log('\n' + diffs.join('\n'));
  }
}

const run = cmd === 'generate' ? generate : cmd === 'label' ? label : async () => agree();
run().catch((err) => {
  console.error(err);
  process.exit(1);
});

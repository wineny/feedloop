// 저장된 예측을 «다른 라벨»로 다시 채점한다. LLM 을 부르지 않는다.
//
// 왜 필요한가 — 라벨을 고친 뒤 다시 측정하면 점수 변화가 라벨 때문인지
// 모델/프롬프트 때문인지 구분되지 않는다. 예측을 고정하고 정답만 바꿔 잰다.
//
// 「전」도 저장된 metrics 가 아니라 지금의 score() 로 다시 계산한다 — 안 그러면 채점
// 규칙이 바뀐 날 그 차이가 라벨 효과로 둔갑한다. 이 파일이 없애려는 바로 그 혼동이다.
//
//   npx tsx scripts/rescore-audit.ts [runsDir]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES } from '../src/lib/classify/taxonomy';
import { score, type Outcome } from './lib/classify-eval';

const dir = process.argv[2] ?? 'evals/classify/audit-2026-09-12/runs';
const humanFile = 'evals/classify/holdout-set-humanlabels.json';
const human = JSON.parse(readFileSync(humanFile, 'utf-8')) as {
  labels: Record<string, { category: string; text: string }>;
};
for (const [id, label] of Object.entries(human.labels)) {
  // 오타(`UX`)는 어떤 예측과도 안 맞고 groupAction 도 none 이라 조용히 두 지표를 깎는다.
  if (!(CATEGORIES as readonly string[]).includes(label.category)) throw new Error(`${humanFile}: ${id} category '${label.category}' is outside taxonomy`);
  if (typeof label.text !== 'string' || !label.text.trim()) throw new Error(`${humanFile}: ${id} has no text to match against`);
}
const ids = Object.keys(human.labels);

type Artifact = { set: string; setHash: string; outcomes: Outcome[] };
const artifacts = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ f, d: JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Artifact }))
  .filter(({ d }) => d.set.includes('holdout'));

// 실행들이 같은 셋 파일을 읽었는지. 다르면 id 가 같아도 같은 문장이 아닐 수 있다.
const hashes = new Set(artifacts.map(({ d }) => d.setHash));
if (hashes.size > 1) throw new Error(`holdout runs were measured against ${hashes.size} different set files — do not pool them`);

const pct = (v: number | null) => (typeof v === 'number' ? v.toFixed(1) : '–');
console.log(`사람 확정 라벨 ${ids.length}건으로 재채점 (${humanFile})`);
console.log('확정된 건만 정답을 바꾸고, 나머지는 기존 라벨 그대로 둔다. 전·후 모두 지금의 score() 로 계산.\n');
console.log('실행                                         category(전→후)   action(전→후)   바뀐 건');
console.log('─'.repeat(100));

for (const { f, d } of artifacts) {
  const before = score(d.outcomes);
  let changed = 0;
  const outcomes = d.outcomes.map((o) => {
    const fixed = human.labels[o.c.id];
    if (!fixed) return o;
    // id 만 믿지 않는다 — 셋이 재정렬·수정돼 같은 id 가 다른 문장을 가리키면 라벨이 엉뚱한 건에 붙는다.
    if (fixed.text !== o.c.text) throw new Error(`${f}: ${o.c.id} text differs from ${humanFile} — labels would attach to the wrong case`);
    if (fixed.category !== o.c.category) changed++;
    return { ...o, c: { ...o.c, category: fixed.category } };
  });
  const after = score(outcomes);
  console.log(
    `${f.replace(/\.json$/, '').padEnd(44)} ${pct(before.category.percent).padStart(5)}% → ${pct(after.category.percent).padStart(5)}%   ` +
      `${pct(before.action.percent).padStart(5)}% → ${pct(after.action.percent).padStart(5)}%   ${changed}건`,
  );
}

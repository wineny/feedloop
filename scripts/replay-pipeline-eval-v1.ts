import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, writeScore } from './lib/pipeline-eval';
import { compareIntegration } from './lib/pipeline-eval-integration';
import { deriveReplay } from './lib/pipeline-eval-replay-v1';

const root = 'evals/classify/pipeline-20260913';
const output = resolve(root + '/integration/offline-replay-v1');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--freeze', '--run', '--verify'].includes(args[0])) throw new Error('Use exactly --freeze, --run or --verify; no model calls exist in this script');
const protectedFiles = ['manifest.json','baseline.json','candidate.json','comparison.json','budget.jsonl','context-set.json','integration/manifest.json','integration/integration.json','integration/comparison.json','integration/budget.jsonl','integration/partial.json'].map(p => root + '/' + p);
const labels = ['golden-set.json','holdout-set.json','holdout-set-humanlabels.json','holdout-set-secondlabels.json','holdout-set-thirdlabels.json'].map(p => 'evals/classify/' + p);
const source = ['scripts/replay-pipeline-eval-v1.ts','scripts/lib/pipeline-eval-replay-v1.ts','scripts/lib/pipeline-eval-integration.ts','scripts/lib/pipeline-eval.ts','scripts/lib/classify-eval.ts','src/lib/bot/db.ts','src/lib/bot/handler.ts','src/lib/bot/holding.ts','src/lib/bot/reply-context.ts','src/lib/classify/recovery.ts','src/lib/classify/taxonomy.ts','src/lib/groups/policy.ts','src/lib/widget/chips.ts'];
const digests = (paths: string[]) => Object.fromEntries(paths.map(p => [p, hash(readFileSync(p))]));
const method = { version: 'offline-replay-v1', paidCalls: 0, evidence: digests(protectedFiles), labels: digests(labels), source: digests(source), method: 'Stage1 keeps recorded live outcome scores. Stage2 corrects only proven recovery chip-only no-model outcomes, never real parsing failures. Stage3 replays identical recorded raw strings against current shared parser/holding/planner with original text, including courtesy-only source guard. Labels and category scoring remain unchanged.', limitations: 'Offline deterministic policy/scoring regression only; not new live performance, not DB persistence. Original live humanGate and operationalGate stay failed. Legacy bulk8 versus independent recovery8 is a method change; no causal identical-method comparison.' };
const manifestFile = output + '/manifest.json';
if (args[0] === '--freeze') {
  mkdirSync(output, { recursive: true });
  writeFileSync(manifestFile, JSON.stringify({ ...method, frozenAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  console.log('Offline replay method frozen before calculation.');
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); delete manifest.frozenAt;
  if (JSON.stringify(manifest) !== JSON.stringify(method)) throw new Error('Replay inputs/source/method changed');
  const receipt = JSON.parse(readFileSync(root + '/integration/integration.json', 'utf8'));
  const baseline = JSON.parse(readFileSync(root + '/baseline.json', 'utf8'));
  const original = JSON.parse(readFileSync(root + '/integration/comparison.json', 'utf8'));
  const derived = deriveReplay(receipt);
  const comparisons = Object.fromEntries(Object.entries(derived).map(([stage, outcomes]) => [stage, compareIntegration(baseline, { ...outcomes, blocked: receipt.blocked })]));
  const result = { version: 'offline-replay-v1', manifestHash: hash(readFileSync(manifestFile)), paidCalls: 0, originalLive: { humanGate: original.humanGate, operationalGate: original.operationalGate, writes: original.writes, realtime: original.realtime, recovery: original.recovery }, comparisons, writes: Object.fromEntries(Object.entries(derived).map(([stage, outcomes]) => [stage, { realtime: writeScore(outcomes.outcomes), recovery: writeScore(outcomes.recoveryOutcomes) }])), derived, limitation: method.limitations };
  const resultFile = output + '/result.json';
  if (args[0] === '--run') writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  else if (!existsSync(resultFile) || JSON.stringify(JSON.parse(readFileSync(resultFile, 'utf8'))) !== JSON.stringify(result)) throw new Error('Replay artifact mismatch');
  if (JSON.stringify(digests(protectedFiles)) !== JSON.stringify(method.evidence)) throw new Error('Original evidence changed during replay');
  console.log(JSON.stringify({ paidCalls: 0, originalLiveHumanGate: original.humanGate, originalLiveOperationalGate: original.operationalGate, writes: result.writes, derivedGates: Object.fromEntries(Object.entries(comparisons).map(([k,v]) => [k, {humanGate:v.humanGate, operationalGate:v.operationalGate}])) }, null, 2));
}

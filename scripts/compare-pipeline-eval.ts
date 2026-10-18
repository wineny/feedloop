import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from './lib/pipeline-eval';
import { compareRuns } from './lib/pipeline-eval-compare';
const root = resolve(process.argv[2] ?? 'evals/classify/pipeline-20260913');
try {
  const baseline = JSON.parse(readFileSync(root + '/baseline.json', 'utf8'));
  const candidate = JSON.parse(readFileSync(root + '/candidate.json', 'utf8'));
  const manifest = JSON.parse(readFileSync(root + '/manifest.json', 'utf8'));
  const comparison = compareRuns(baseline, candidate, manifest.caseIds, hash(readFileSync(root + '/manifest.json')));
  const summarize = (run: typeof baseline) => { const times = run.calls.map((c: { elapsedMs: number }) => c.elapsedMs).sort((a: number, b: number) => a - b); return { calls: run.calls.length, inputTokens: run.calls.reduce((n: number, c: {usage?:{inputTokens?:number}}) => n + (c.usage?.inputTokens ?? 0), 0), outputTokens: run.calls.reduce((n: number, c: {usage?:{outputTokens?:number}}) => n + (c.usage?.outputTokens ?? 0), 0), knownActualUsd: run.calls.reduce((n: number, c: {actualUsd?:number}) => n + (c.actualUsd ?? 0), 0), unknownUsageCalls: run.calls.filter((c: {actualUsd?:number}) => c.actualUsd == null).length, latencyMs: { p50: times[Math.floor(times.length * 0.5)] ?? null, p95: times[Math.floor(times.length * 0.95)] ?? null, max: times.at(-1) ?? null } }; };
  const evidence = { ...comparison, usage: { baseline: summarize(baseline), candidate: summarize(candidate) }, comparisonCodeHash: hash(readFileSync('scripts/lib/pipeline-eval-compare.ts')) };
  writeFileSync(root + '/comparison.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (!comparison.complete || !comparison.humanGate || !comparison.operationalGate) process.exitCode = 1;
} catch { console.error('Cannot compare: missing or mismatched frozen evidence.'); process.exitCode = 1; }

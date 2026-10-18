/** Amendment to the immutable September 13 run; offline unless --live is explicit. */
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateText } from 'ai';
import { resolveModel } from '../src/lib/llm/provider';
import { prepareRecoveryCase, parseRecoveryResult } from '../src/lib/classify/recovery';
import { buildInsightRefMap } from '../src/lib/bot/reply-context';
import { failedOutcome, parseRealtime, safeCallFailure, score, type Outcome } from './lib/classify-eval';
import { hash, PROFILE, prepareCase, parseCase, reservation, provenanceScores, writeScore, type PipelineCase } from './lib/pipeline-eval';
import { parentEvidence, integrationBudget, reserveIntegration, settleCall, compareIntegration } from './lib/pipeline-eval-integration';

async function main() {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(a => !['--freeze', '--dry-run', '--live'].includes(a)) || (args.includes('--freeze') && args.includes('--live'))) throw new Error('invalid flags');
  const parentRoot = resolve('evals/classify/pipeline-20260913');
  const root = parentRoot + '/integration';
  const files = { manifest: parentRoot + '/manifest.json', ledger: parentRoot + '/budget.jsonl', baseline: parentRoot + '/baseline.json', candidate: parentRoot + '/candidate.json' };
  const parent = parentEvidence(files);
  const old = JSON.parse(readFileSync(files.manifest, 'utf8'));
  const baseline = JSON.parse(readFileSync(files.baseline, 'utf8'));
  const cases: PipelineCase[] = baseline.outcomes.map((o: Outcome) => o.c);
  const recoveryCases: PipelineCase[] = [...baseline.batchOutcomes.map((o: Outcome) => o.c), ...cases.filter(c => c.expectedWrite != null)];
  if (cases.length !== 98 || recoveryCases.length !== 20 || JSON.stringify(cases.map(c => c.id)) !== JSON.stringify(old.caseIds)) throw new Error('case denominator mismatch');
  for (const [name, digest] of Object.entries(old.files)) {
    const path = name === 'context-set.json' ? parentRoot + '/' + name : 'evals/classify/' + name;
    if (hash(readFileSync(path)) !== digest) throw new Error('original data changed');
  }
  for (const [key, path] of Object.entries({ scorer: 'scripts/lib/classify-eval.ts', harness: 'scripts/lib/pipeline-eval.ts', cli: 'scripts/eval-pipeline.ts' })) if (hash(readFileSync(path)) !== old[key]) throw new Error('original evaluator changed');
  const sourceFiles = [...Object.keys(old.sources.candidate), 'src/lib/bot/conversations.ts', 'src/lib/classify/recovery.ts', 'src/lib/llm/usage.ts', 'src/lib/bot/core.ts', 'supabase/migrations/20260913_14_pipeline_source_context.sql', 'scripts/eval-pipeline-integration.ts', 'scripts/lib/pipeline-eval-integration.ts'];
  const source = Object.fromEntries(sourceFiles.map(p => [p, hash(readFileSync(p))]));
  const config = { ...old.config, callsCap: 318, additionalCallsCap: 118, realtimeTimeoutMs: 10000, recoveryTimeoutMs: 60000, repeat: 1 };
  const plan = { version: 2, phase: 'integration', parent, source, config, caseIds: cases.map(c => c.id), recoveryCaseIds: recoveryCases.map(c => c.id), reason: 'Upstream B2 v2 2a6c94b integration and demonstrated valid-extends/null-insight source-loss repair. This is not a score-tuning rerun.', acceptance: old.acceptance, operationalAcceptance: 'Both realtime and recovery contextual write outcomes must each pass all 12 frozen assertions.', methodChange: 'Recovery20 uses actual production preparation/parser/holding/write helpers with supplied original-time fixtures, not legacy 4-case bulk prompts. Compare8human subset descriptively with legacy baseline; no DB persistence claim.', transportDifference: 'Same fixed provider/maxRetries=0/output ceiling1400 as parent. Production recovery has no1400output ceiling; evaluation retains budget ceiling. Realtime10s, recovery60s. Chip-only recovery skips model dispatch as production does.' };
  const manifestFile = root + '/manifest.json';
  if (args.includes('--freeze')) {
    mkdirSync(root, { recursive: true });
    writeFileSync(manifestFile, JSON.stringify({ ...plan, frozenAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  }
  const frozen = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  if (frozen) { const expected = { ...frozen }; delete expected.frozenAt; if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('frozen integration mismatch'); }
  const realtimeJobs = cases.map(c => ({ path: 'realtime' as const, c, ...prepareCase(c), skip: false }));
  const recoveryJobs = recoveryCases.map(c => {
    const refMap = buildInsightRefMap(c.existing ?? []);
    const prepared = prepareRecoveryCase({ profile: PROFILE, timeline: (c.history ?? []).map((t, i) => ({ ...t, id: `turn-${i}`, at: '2026-09-13T00:00:00Z' })), refMap, messageId: 'eval-message', text: c.text, context: c.context, widget_hint: c.hint });
    return { path: 'recovery' as const, c, system: prepared.system, prompt: prepared.user, refMap, skip: prepared.chipOnly };
  });
  const jobs = [...realtimeJobs, ...recoveryJobs];
  const receipt = { phase: 'integration', manifestHash: frozen ? hash(readFileSync(manifestFile)) : null, parent, config, source, codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sdk: { ai: JSON.parse(readFileSync('node_modules/ai/package.json', 'utf8')).version, anthropic: JSON.parse(readFileSync('node_modules/@ai-sdk/anthropic/package.json', 'utf8')).version, node: process.version }, maximumAdditionalCalls: jobs.filter(j => !j.skip).length, promptHashes: jobs.map(j => ({ id: j.c.id, path: j.path, system: hash(j.system), prompt: hash(j.prompt), skip: j.skip, ...reservation(j.system, j.prompt) })) };
  if (!args.includes('--live') || args.includes('--dry-run')) { console.log(JSON.stringify(receipt, null, 2)); return; }
  if (!receipt.manifestHash) throw new Error('freeze required');
  if (process.env.NODE_OPTIONS || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || Object.keys(process.env).some(k => /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ANTHROPIC_BASE_URL|AI_GATEWAY_BASE_URL|FEEDLOOP_QA_)/i.test(k) && process.env[k])) throw new Error('custom transport refused');
  const resultFile = root + '/integration.json';
  if (existsSync(resultFile)) throw new Error('integration receipt already exists');
  const lock = root + '/budget.lock'; const fd = openSync(lock, 'wx');
  const ledger = root + '/budget.jsonl';
  const outcomes: Outcome[] = []; const recoveryOutcomes: Outcome[] = []; const calls: unknown[] = [];
  let blocked: string | null = null;
  const checkpoint = () => ({ ...receipt, blocked, calls, outcomes, recoveryOutcomes, writes: { realtime: writeScore(outcomes), recovery: writeScore(recoveryOutcomes) }, metrics: { realtime: score(outcomes), recovery: score(recoveryOutcomes) }, provenance: { realtime: provenanceScores(outcomes), recovery: provenanceScores(recoveryOutcomes) }, budget: { calls: integrationBudget(ledger, receipt.manifestHash!, parent).calls, chargedUsd: integrationBudget(ledger, receipt.manifestHash!, parent).charged } });
  try {
    process.env.PLATFORM_LLM_PROVIDER = config.provider; process.env.PLATFORM_LLM_MODEL = config.model;
    let model;
    try { model = await resolveModel({ botId: 'offline-eval-fixture' }); } catch { blocked = 'provider_key_unavailable'; }
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i]; const target = j.path === 'realtime' ? outcomes : recoveryOutcomes;
      if (blocked || !model) { target.push(failedOutcome(j.c, 'omitted', i)); continue; }
      if (j.skip) { target.push({ ...parseRealtime(j.c, JSON.stringify({ insight: null }), i), write: { action: 'skip' }, dispatch: 'chip_only_no_model' } as Outcome); continue; }
      const id = `integration:${j.path}:${j.c.id}`; const reserved = reservation(j.system, j.prompt);
      try { reserveIntegration(ledger, receipt.manifestHash, parent, id, reserved.reservedUsd); } catch { blocked = 'budget_or_resume_guard'; target.push(failedOutcome(j.c, 'omitted', i)); continue; }
      const start = Date.now();
      try {
        const response = await generateText({ model: model.model, system: j.system, prompt: j.prompt, maxRetries: 0, maxOutputTokens: config.outputTokens, timeout: j.path === 'realtime' ? config.realtimeTimeoutMs : config.recoveryTimeoutMs });
        const { inputTokens, outputTokens } = response.usage;
        const actualUsd = inputTokens == null || outputTokens == null ? null : (inputTokens + outputTokens * 5) / 1e6;
        if (actualUsd != null) settleCall(ledger, id, actualUsd, receipt.manifestHash);
        calls.push({ id, elapsedMs: Date.now() - start, usage: response.usage, actualUsd, reserved, raw: response.text, responseId: response.response.id });
        if (j.path === 'realtime') target.push(parseCase(j.c, response.text, i));
        else {
          const { parsed, plan: write } = parseRecoveryResult(response.text, j.refMap, j.c.text);
          target.push({ ...parseRealtime(j.c, JSON.stringify(parsed), i), ...(parsed.parsed === false ? { status: 'parse' as const } : {}), write, response: parsed.response } as Outcome);
        }
      } catch (error) {
        const failure = safeCallFailure(error); calls.push({ id, ...failure, elapsedMs: Date.now() - start, reserved }); target.push(failedOutcome(j.c, failure.failure!, i)); blocked = 'provider_or_accounting_failure_no_retry';
      }
      writeFileSync(root + '/partial.json', JSON.stringify(checkpoint(), null, 2));
    }
    const result = { ...checkpoint(), finishedAt: new Date().toISOString() };
    writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const comparison = compareIntegration(baseline, result);
    writeFileSync(root + '/comparison.json', JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ blocked, calls: calls.length, budget: result.budget, comparison }, null, 2));
    if (blocked || !comparison.humanGate || !comparison.operationalGate) process.exitCode = 1;
  } finally { closeSync(fd); unlinkSync(lock); }
}
main().catch(error => { console.error(`Integration evaluation stopped: ${error instanceof Error && /^[a-zA-Z0-9 _-]+$/.test(error.message) ? error.message : 'configuration or persistence error'}`); process.exitCode = 1; });

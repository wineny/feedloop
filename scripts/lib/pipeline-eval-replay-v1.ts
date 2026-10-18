/** Offline derivation only: never invokes a model or persistence. */
import { extractResult } from '../../src/lib/bot/handler';
import { applyHoldingPolicy } from '../../src/lib/bot/holding';
import { planInsightWrite, type InsightWritePlan } from '../../src/lib/bot/db';
import { buildInsightRefMap } from '../../src/lib/bot/reply-context';
import { parseRecoveryResult } from '../../src/lib/classify/recovery';
import { isChipOnlyText } from '../../src/lib/widget/chips';
import { failedOutcome, parseRealtime, type Outcome } from './classify-eval';
import type { PipelineCase } from './pipeline-eval';

export type ReplayOutcome = Outcome & { write?: InsightWritePlan; dispatch?: string };
export interface RecordedCall { id: string; raw?: string; failure?: string }
export interface ReplayReceipt {
  outcomes: ReplayOutcome[]; recoveryOutcomes: ReplayOutcome[];
  calls: RecordedCall[]; promptHashes: Array<{ id: string; path: string; skip: boolean }>;
}
/** Only a proven skipped dispatch is eligible; a parse failure from an actual call is not. */
export function noModelChipOutcome(c: PipelineCase, callIndex: number, proof: { dispatch: string | undefined; skip: boolean; calls: number }): ReplayOutcome {
  if (!isChipOnlyText(c.text) || proof.dispatch !== 'chip_only_no_model' || !proof.skip || proof.calls !== 0) throw new Error('unproven no-model dispatch');
  return { ...failedOutcome(c, 'no-insight', callIndex), write: { action: 'skip' }, dispatch: 'chip_only_no_model' };
}
export function replayRaw(c: PipelineCase, raw: string, path: 'realtime' | 'recovery', callIndex: number): ReplayOutcome {
  const refMap = buildInsightRefMap(c.existing ?? []);
  const chipOnly = isChipOnlyText(c.text);
  let result; let write;
  if (path === 'recovery') {
    const recovery = parseRecoveryResult(raw, refMap, c.text); result = recovery.parsed; write = recovery.plan;
  } else {
    result = applyHoldingPolicy(extractResult(raw));
    if (chipOnly) { result.insight = null; result.extends = null; }
    write = planInsightWrite({ insight: result.insight, extends: result.extends, refMap, chipOnly, text: c.text });
  }
  if (result.parsed === false) return failedOutcome(c, 'parse', callIndex);
  return { ...parseRealtime(c, JSON.stringify(result), callIndex), write };
}
export function deriveReplay(receipt: ReplayReceipt) {
  const corrected = { outcomes: receipt.outcomes, recoveryOutcomes: receipt.recoveryOutcomes.map(o => {
    if (o.dispatch !== 'chip_only_no_model') return o;
    const jobs = receipt.promptHashes.filter(j => j.path === 'recovery' && j.id === o.c.id);
    if (jobs.length !== 1) throw new Error('no-model job mismatch');
    return noModelChipOutcome(o.c, o.callIndex, { dispatch: o.dispatch, skip: jobs[0].skip, calls: receipt.calls.filter(c => c.id === `integration:recovery:${o.c.id}`).length });
  }) };
  const replay = (path: 'realtime' | 'recovery', outcomes: ReplayOutcome[]) => outcomes.map(o => {
    if (o.dispatch === 'chip_only_no_model') return o;
    const calls = receipt.calls.filter(c => c.id === `integration:${path}:${o.c.id}`);
    if (calls.length > 1) throw new Error('duplicate raw call');
    if (!calls.length || typeof calls[0].raw !== 'string') {
      if (o.status === 'ok' || o.status === 'no-insight') throw new Error('missing raw evidence');
      return o;
    }
    return replayRaw(o.c, calls[0].raw, path, o.callIndex);
  });
  return { correctedScoringOnly: corrected, finalPolicyReplay: { outcomes: replay('realtime', corrected.outcomes), recoveryOutcomes: replay('recovery', corrected.recoveryOutcomes) } };
}

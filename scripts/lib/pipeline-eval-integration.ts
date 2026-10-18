import { appendFileSync, readFileSync } from 'node:fs';
import { hash, budgetState, settleCall, writeScore } from './pipeline-eval';
import { score, type Outcome } from './classify-eval';

export interface ParentEvidence { manifest: string; ledger: string; baseline: string; candidate: string }
export function parentEvidence(files: ParentEvidence) {
  const hashes = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, hash(readFileSync(path))]));
  const state = budgetState(files.ledger, hashes.manifest);
  const seen = new Set<string>();
  for (const phase of ['baseline', 'candidate'] as const) {
    const receipt = JSON.parse(readFileSync(files[phase], 'utf8'));
    if (receipt.phase !== phase || receipt.manifestHash !== hashes.manifest || receipt.blocked) throw new Error('invalid parent receipt');
    for (const call of receipt.calls) {
      if (seen.has(call.id) || !state.reserved.has(call.id)) throw new Error('parent call mismatch');
      seen.add(call.id);
      if (call.actualUsd != null && state.settled.get(call.id) !== call.actualUsd) throw new Error('parent usage mismatch');
    }
  }
  if (seen.size !== state.reserved.size || seen.size !== 200) throw new Error('incomplete parent accounting');
  return { hashes, calls: state.reserved.size, chargedUsd: state.charged };
}
export function integrationBudget(file: string, manifestHash: string, parent: ReturnType<typeof parentEvidence>) {
  const state = budgetState(file, manifestHash);
  return { ...state, calls: parent.calls + state.reserved.size, charged: parent.chargedUsd + state.charged };
}
export function reserveIntegration(file: string, manifestHash: string, parent: ReturnType<typeof parentEvidence>, id: string, reservedUsd: number) {
  const state = integrationBudget(file, manifestHash, parent);
  if (state.reserved.has(id) || !id.startsWith('integration:') || !Number.isFinite(reservedUsd) || reservedUsd <= 0 || state.calls >= 318 || state.charged + reservedUsd > 3) throw new Error('integration budget rejected');
  appendFileSync(file, JSON.stringify({ id, reservedUsd, manifestHash }) + '\n', { flush: true });
}
export { settleCall };
export function compareIntegration(baseline: { outcomes: Outcome[]; batchOutcomes: Outcome[] }, final: { outcomes: Outcome[]; recoveryOutcomes: Outcome[]; blocked: string | null }) {
  if (JSON.stringify(baseline.outcomes.map(o => o.c)) !== JSON.stringify(final.outcomes.map(o => o.c))) throw new Error('integration cases changed');
  const human = (outcomes: Outcome[]) => score(outcomes.filter(o => o.c.provenance === 'human'));
  const before = human(baseline.outcomes); const after = human(final.outcomes);
  const beforeRecovery = human(baseline.batchOutcomes); const afterRecovery = human(final.recoveryOutcomes);
  const expected = [...baseline.batchOutcomes.map(o => o.c), ...baseline.outcomes.filter(o => o.c.expectedWrite != null).map(o => o.c)];
  if (JSON.stringify(expected) !== JSON.stringify(final.recoveryOutcomes.map(o => o.c))) throw new Error('recovery denominator changed');
  const passes = (a: ReturnType<typeof score>, b: ReturnType<typeof score>) => b.category.hit >= a.category.hit && b.action.hit >= a.action.hit && b.wrongPr.hit <= a.wrongPr.hit;
  const writes = { realtime: writeScore(final.outcomes), recovery: writeScore(final.recoveryOutcomes) };
  return { complete: !final.blocked, realtime: { baseline: before, integration: after, nonRegression: passes(before, after) }, recovery: { legacyBulkBaseline: beforeRecovery, integration: afterRecovery, nonRegression: passes(beforeRecovery, afterRecovery), methodChange: 'Legacy 4-case bulk prompts compared descriptively with current independent contextual recovery; not an identical-method causal comparison.' }, writes, humanGate: passes(before, after) && passes(beforeRecovery, afterRecovery), operationalGate: Object.values(writes).every(w => w.total === 12 && w.hit === 12), limitations: 'One repeat. Original failed comparison remains unchanged. Model/unknown labels are not human truth. Recovery measures pure preparation/parser/write planning, not DB outcomes. wrongPr is eligibility, not patch quality.' };
}

import { appendFileSync, readFileSync } from 'node:fs';
import { hash, budgetState } from './pipeline-eval';
import { parentEvidence, compareIntegration } from './pipeline-eval-integration';

/** Derive carry-forward only from both immutable ledgers and matching raw receipts. */
export function finalParentEvidence(root: string) {
  const original = parentEvidence({ manifest: root + '/manifest.json', ledger: root + '/budget.jsonl', baseline: root + '/baseline.json', candidate: root + '/candidate.json' });
  const files = ['integration/manifest.json','integration/budget.jsonl','integration/integration.json','integration/comparison.json'];
  const hashes = Object.fromEntries(files.map(p => [p, hash(readFileSync(root + '/' + p))]));
  const manifest = JSON.parse(readFileSync(root + '/integration/manifest.json','utf8'));
  const receipt = JSON.parse(readFileSync(root + '/integration/integration.json','utf8'));
  const manifestHash = hashes['integration/manifest.json'];
  if (JSON.stringify(manifest.parent) !== JSON.stringify(original) || JSON.stringify(receipt.parent) !== JSON.stringify(original) || receipt.phase !== 'integration' || receipt.blocked || receipt.manifestHash !== manifestHash) throw new Error('integration parent mismatch');
  const state = budgetState(root + '/integration/budget.jsonl', manifestHash);
  const seen = new Set<string>();
  for (const call of receipt.calls) {
    if (typeof call.id !== 'string' || !call.id.startsWith('integration:') || seen.has(call.id) || !state.reserved.has(call.id) || call.reserved?.reservedUsd !== state.reserved.get(call.id)) throw new Error('integration call mismatch');
    if (call.actualUsd != null && state.settled.get(call.id) !== call.actualUsd) throw new Error('integration usage mismatch');
    seen.add(call.id);
  }
  if (seen.size !== 116 || seen.size !== state.reserved.size) throw new Error('incomplete integration history');
  return { original, originalComparisonHash: hash(readFileSync(root + '/comparison.json')), integrationHashes: hashes, calls: original.calls + state.reserved.size, chargedUsd: original.chargedUsd + state.charged };
}
export function finalBudget(file: string, manifestHash: string, parent: ReturnType<typeof finalParentEvidence>) {
  const state = budgetState(file, manifestHash);
  return { ...state, calls: parent.calls + state.reserved.size, charged: parent.chargedUsd + state.charged };
}
export function reserveFinal(file: string, manifestHash: string, parent: ReturnType<typeof finalParentEvidence>, id: string, reservedUsd: number) {
  const state = finalBudget(file, manifestHash, parent);
  if (parent.calls !== 316 || state.reserved.has(id) || !id.startsWith('final-v1:') || !Number.isFinite(reservedUsd) || reservedUsd <= 0 || state.calls >= 378 || state.charged + reservedUsd > 3) throw new Error('final budget rejected');
  appendFileSync(file, JSON.stringify({ id, reservedUsd, manifestHash }) + '\n', { flush: true });
}
export function compareFinal(baseline: Parameters<typeof compareIntegration>[0], final: Parameters<typeof compareIntegration>[1]) {
  const outcomes = baseline.outcomes.filter(o => o.c.provenance === 'human' || o.c.expectedWrite != null);
  if (outcomes.length !== 42) throw new Error('final subset mismatch');
  return { ...compareIntegration({ ...baseline, outcomes }, final), scope: 'Final predeclared42 realtime subset:30 previously exposed human-labeled cases+12contexts,20 recovery cases. Not full98-case performance. Holdout has already been exposed; no fresh independent holdout claim. One final repeat; earlier failed gates remain unchanged.' };
}

import { score, type Outcome } from './classify-eval';
import { writeScore } from './pipeline-eval';
interface Run { phase: string; manifestHash: string; blocked: string | null; config: unknown; sdk: unknown; outcomes: Outcome[]; batchOutcomes: Outcome[] }
export function compareRuns(baseline: Run, candidate: Run, ids: string[], manifestHash: string) {
  if (baseline.phase !== 'baseline' || candidate.phase !== 'candidate' || baseline.manifestHash !== manifestHash || candidate.manifestHash !== manifestHash || JSON.stringify(baseline.config) !== JSON.stringify(candidate.config) || JSON.stringify(baseline.sdk) !== JSON.stringify(candidate.sdk)) throw new Error('comparison configuration mismatch');
  for (const r of [baseline, candidate]) if (JSON.stringify(r.outcomes.map(o => o.c.id)) !== JSON.stringify(ids)) throw new Error('case denominator mismatch');
  if (JSON.stringify(baseline.outcomes.map(o => o.c)) !== JSON.stringify(candidate.outcomes.map(o => o.c)) || JSON.stringify(baseline.batchOutcomes.map(o => o.c)) !== JSON.stringify(candidate.batchOutcomes.map(o => o.c))) throw new Error('labels or batch IDs mismatch');
  const paths = Object.fromEntries(['realtime', 'batch'].map(path => {
    const before = path === 'realtime' ? baseline.outcomes : baseline.batchOutcomes;
    const after = path === 'realtime' ? candidate.outcomes : candidate.batchOutcomes;
    const slices = Object.fromEntries(['human', 'model', 'unknown'].map(label => {
      const a = score(before.filter(o => o.c.provenance === label)); const b = score(after.filter(o => o.c.provenance === label));
      return [label, { baseline: a, candidate: b, nonRegression: b.category.hit >= a.category.hit && b.action.hit >= a.action.hit && b.wrongPr.hit <= a.wrongPr.hit }];
    }));
    const datasets = Object.fromEntries(['golden', 'holdout', 'contextual'].map(set => { const matches = (o: Outcome) => set === 'golden' ? /^(real|synth):/.test(o.c.id) : o.c.id.startsWith(set === 'holdout' ? 'hold:' : 'context:'); return [set, { baseline: score(before.filter(matches)), candidate: score(after.filter(matches)), human: { baseline: score(before.filter(o => matches(o) && o.c.provenance === 'human')), candidate: score(after.filter(o => matches(o) && o.c.provenance === 'human')) } }]; }));
    return [path, { baseline: score(before), candidate: score(after), slices, datasets }];
  }));
  const writes = { baseline: writeScore(baseline.outcomes), candidate: writeScore(candidate.outcomes) };
  return { manifestHash, complete: !baseline.blocked && !candidate.blocked, blocked: { baseline: baseline.blocked, candidate: candidate.blocked }, humanGate: Object.values(paths).every(p => p.slices.human.nonRegression), operationalGate: writes.candidate.total > 0 && writes.candidate.hit === writes.candidate.total, paths, writes, limitation: 'One repeat, descriptive only; batch only 8 selected human holdout cases; unknown and model labels are not human truth. wrongPr measures classification eligibility, not patch quality. API/parse/omission failures remain in denominators.' };
}

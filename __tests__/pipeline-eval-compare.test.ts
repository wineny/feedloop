import { describe, it, expect } from 'vitest';
import { compareRuns } from '../scripts/lib/pipeline-eval-compare';
import { failedOutcome } from '../scripts/lib/classify-eval';
const c = {id:'human',text:'broken',category:'bug',provenance:'human'};
const outcome = {c,got:{category:'bug',sentiment:'negative',summary:'broken'},status:'ok' as const,rawCategory:'bug',rawSentiment:'negative',callIndex:0};
const run = {manifestHash:'m',blocked:null,config:{model:'same'},sdk:'same',outcomes:[outcome],batchOutcomes:[outcome]};
describe('paired comparison evidence', () => {
  it('fails the human non-regression gate when a human case times out', () => {
    const result=compareRuns({...run,phase:'baseline'},{...run,phase:'candidate',outcomes:[failedOutcome(c,'timeout',0)]},['human'],'m');
    expect(result.humanGate).toBe(false);
    expect(result.paths.realtime.candidate.category.total).toBe(1);
  });
  it('rejects model, label and denominator mismatch instead of producing a comparison', () => {
    const baseline={...run,phase:'baseline'};const candidate={...run,phase:'candidate'};
    expect(()=>compareRuns(baseline,{...candidate,config:{model:'different'}},['human'],'m')).toThrow();
    expect(()=>compareRuns(baseline,{...candidate,outcomes:[]},['human'],'m')).toThrow();
    expect(()=>compareRuns(baseline,{...candidate,outcomes:[{...outcome,c:{...c,category:'ux'}}]},['human'],'m')).toThrow();
  });
  it('marks unavailable provider as incomplete even when both zero-hit scores tie', () => {
    expect(compareRuns({...run,phase:'baseline',blocked:'key_missing'},{...run,phase:'candidate'},['human'],'m').complete).toBe(false);
  });
});

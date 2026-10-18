import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCase, prepareCase, reservation, reserveCall } from '../scripts/lib/pipeline-eval';
describe('pipeline evaluation guards', () => {
  it('uses production context and chip suppression even against model instruction failure', () => {
    const c = { id: 'chip', text: '불편한 점이 있어요', history: [{ kind: 'user' as const, body: '앞선 대화' }] };
    expect(prepareCase(c).prompt).toContain('앞선 대화');
    const out = parseCase(c, JSON.stringify({ response:'접수', insight:{category:'bug',summary:'invented',sentiment:'negative'} }), 0);
    expect(out.got).toBeNull();
    expect(out.write.action).toBe('skip');
  });
  it('reserves before dispatch, rejects replay and uses settled actual cost without forgetting call count', () => {
    const dir = mkdtempSync(join(tmpdir(),'eval-budget-')); const file = join(dir,'budget');
    try {
      reserveCall(file, {id:'a', reservedUsd:2, manifestHash:'frozen'});
      expect(() => reserveCall(file,{id:'a',reservedUsd:0.1,manifestHash:'frozen'})).toThrow(/already/);
      expect(() => reserveCall(file,{id:'b',reservedUsd:2,manifestHash:'frozen'})).toThrow(/budget/);
      appendFileSync(file, JSON.stringify({settled:'a',actualUsd:0.1,manifestHash:'frozen'})+'\n');
      reserveCall(file,{id:'b',reservedUsd:2,manifestHash:'frozen'});
      expect(() => reserveCall(file,{id:'c',reservedUsd:0.1,manifestHash:'different'})).toThrow(/mismatch/);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('uses UTF8 bytes with wrapper allowance for conservative reservation', () => {
    expect(reservation('가','나').inputUpperBound).toBe(518);
  });
});

describe('frozen contextual policy cases', () => {
  it('candidate includes masked technical context while baseline follows the old prompt', () => {
    const c = { id: 'tech', text: '오류', context: { url: 'https://fixture.example/x?token=private', errors: ['fixture-error'] } };
    expect(prepareCase(c, 'candidate').prompt).toContain('fixture-error');
    expect(prepareCase(c, 'candidate').prompt).not.toContain('private');
    expect(prepareCase(c, 'baseline').prompt).not.toContain('fixture-error');
  });
  it('invalid JSON cannot obtain explicit-no-insight credit', () => {
    expect(parseCase({ id: 'bad', text: '질문' }, '{}', 0).status).toBe('parse');
  });
  it('rejects forged negative and duplicate budget settlements', async () => {
    const { settleCall, budgetState } = await import('../scripts/lib/pipeline-eval');
    const dir = mkdtempSync(join(tmpdir(),'eval-budget-')); const file = join(dir,'budget');
    try {
      reserveCall(file,{id:'a',reservedUsd:0.2,manifestHash:'h'});
      expect(() => settleCall(file,'a',-0.1,'h')).toThrow();
      expect(() => settleCall(file,'a',0.3,'h')).toThrow();
      settleCall(file,'a',0.1,'h');
      expect(() => settleCall(file,'a',0.1,'h')).toThrow();
      appendFileSync(file,JSON.stringify({settled:'a',actualUsd:-1,manifestHash:'h'})+'\n');
      expect(() => budgetState(file,'h')).toThrow();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('counts no-label skipped turns and API failures in operational denominator and checks update identity', async () => {
    const { writeScore } = await import('../scripts/lib/pipeline-eval');
    const out = parseCase({id:'chip',text:'기능 제안이 있어요',expectedWrite:'skip'},'{"response":"어떤 기능인가요?","insight":null}',0);
    const failed = {...out, c:{...out.c,id:'failed'}, status:'api' as const};
    const wrongTarget = {...out,c:{...out.c,id:'target',expectedWrite:'update',expectedTarget:'a'},status:'ok' as const,write:{action:'update' as const,id:'b'}};
    expect(writeScore([out,failed,wrongTarget])).toEqual({hit:1,total:3,failedIds:['failed','target']});
  });
});

describe('aggregate call cap', () => {
  it('settlement cannot free any of the 200 reserved call slots', async () => {
    const { settleCall } = await import('../scripts/lib/pipeline-eval');
    const dir = mkdtempSync(join(tmpdir(),'eval-cap-')); const file=join(dir,'budget');
    try {
      for(let i=0;i<200;i++) reserveCall(file,{id:String(i),reservedUsd:0.001,manifestHash:'h'});
      settleCall(file,'0',0,'h');
      expect(()=>reserveCall(file,{id:'201',reservedUsd:0.001,manifestHash:'h'})).toThrow(/budget/);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});

import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TrustedValidationProfile} from '@/lib/auto-dev/validation';
// digest(null) — 검증 없이 만든 발행 의사의 프로필 자리. 앱의 UNVERIFIED_PROFILE_DIGEST 와 같은 값.
const UNVERIFIED_DIGEST='74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b';
const state=vi.hoisted(()=>({engine:vi.fn(),writes:[] as Record<string,unknown>[],run:{} as Record<string,unknown>,completes:[] as Record<string,unknown>[],legacyGate:false}));
vi.mock('@/lib/auto-dev/ai-engine',()=>({callAutoDev:state.engine}));
vi.mock('@/lib/insights/supplements',()=>({loadSupplementBodies:async()=>[],appendSupplements:(s:string)=>s}));
/**
 * `complete_pipeline_run` 의 SQL 게이트를 «실제로» 흉내낸다.
 * 예전 가짜는 모든 rpc 에 무조건 {data:true} 를 줘서, PR 을 만든 뒤 DB 가 거절하는
 * 결함(고아 PR + 영구 실패 루프)을 초록으로 덮었다.
 * `state.legacyGate=true` 로 두면 완화 전 규칙(validated 만 허용)을 재현한다 — 음성 대조용.
 */
function completeGate(run:Record<string,unknown>,result:Record<string,unknown>):string|null{
 const intent=run.publication_intent as Record<string,unknown>|undefined;
 const ev=run.validation_evidence as Record<string,unknown>|null|undefined;
 if(run.publication_status!=='pending'||!result?.pr_url)return 'publication_evidence_mismatch';
 const hex=(v:unknown,n:number)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
 if(run.validation_status==='validated'){
  if(!ev||ev.status!=='validated')return 'publication_evidence_mismatch';
  if(!hex(ev.patchDigest,64)||!hex(ev.profileDigest,64)||!hex(ev.baseSha,40))return 'publication_evidence_mismatch';
  if(ev.patchDigest!==intent?.patchDigest||ev.profileDigest!==intent?.profileDigest||ev.baseSha!==intent?.baseSha)return 'publication_evidence_mismatch';
  if(ev.runId!==run.id)return 'publication_evidence_mismatch';
  return null;
 }
 if(!state.legacyGate&&run.validation_status==='unverifiable'){
  if(ev)return 'publication_evidence_mismatch';
  if(intent?.profileDigest!==UNVERIFIED_DIGEST)return 'publication_evidence_mismatch';
  if(!hex(intent?.patchDigest,64)||!hex(intent?.baseSha,40))return 'publication_evidence_mismatch';
  if(intent?.runId!==run.id)return 'publication_evidence_mismatch';
  return null;
 }
 return 'publication_evidence_mismatch';
}
vi.mock('@/lib/supabase',()=>({getServiceRoleClient:()=>({
 rpc:async(name:string,a:Record<string,unknown>)=>{
  if(name==='save_pipeline_run'){const v=a.p_values as Record<string,unknown>;state.writes.push(v);Object.assign(state.run,v);}
  if(name==='complete_pipeline_run'){
   const err=completeGate({...state.run,id:a.p_id},a.p_result as Record<string,unknown>);
   if(err)return {data:null,error:{message:err}};
   state.completes.push(a.p_result as Record<string,unknown>);
  }
  return {data:true,error:null};
 },
 from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data:[],error:null})};return q;}
})}));
import {executeClaimedRun,resolveRunValidationInput,type LoadedRun} from '@/lib/auto-dev/execute-run';
import {loadTrustedValidationConfig} from '@/lib/auto-dev/validation-config';
const run:LoadedRun={id:'run',bot_id:'bot',insight_id:null,group_id:'11111111-1111-4111-8111-111111111111',status:'in_progress',pr_url:null,pr_number:null,files_changed:null,error_message:null,insights:null,insight_groups:{title:'coupon bug',summary:'coupon bug',category:'bug',status:'open'},bots:{github_repo_url:'https://github.com/qa/repo',user_id:'owner'}};
let dir:string,path:string,profile:TrustedValidationProfile;
beforeEach(async()=>{
 state.engine.mockReset();state.writes=[];state.run={};state.completes=[];state.legacyGate=false;dir=await mkdtemp(join(tmpdir(),'feedloop-binding-'));path=join(dir,'profiles.json');
 vi.stubEnv('FEEDLOOP_VALIDATION_PROFILES',path);vi.stubEnv('FEEDLOOP_VALIDATION_PROFILE_DIGEST','');
 const input=await resolveRunValidationInput(run);
 profile={id:'coupon',repository:'qa/repo',targetBinding:{target:input.target,evidenceDigest:input.evidenceDigest,reproductionCheckId:'reproduction'},image:'fixture',files:[],checks:[{id:'reproduction',argv:['node','test.js'],successMarker:'PASS'}],intendedFailureMarker:'FAIL',editablePaths:['coupon.ts']};
 await writeFile(path,JSON.stringify({profiles:[profile]}));
});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
it('matching canonical target and exact evidence reaches engine',async()=>{
 state.engine.mockResolvedValue({status:'stopped',reason:'no_change',files_changed:[]});
 await expect(executeClaimedRun(run,'token')).rejects.toThrow('no_change');
 expect(state.engine).toHaveBeenCalledOnce();expect(state.engine.mock.calls[0][0].validation.profile.targetBinding).toEqual(profile.targetBinding);
});
// 이 대상을 겨냥해 사람이 프로필을 «썼는데» 적용할 수 없는 경우다.
// 검증이 조용히 사라지면 안 되므로 완화 뒤에도 종전 그대로 중단한다.
it.each(['duplicate','changed-evidence','missing-reproduction','missing','repository-mismatch'])('%s binding stops before model, runner or PR entry',async(kind)=>{
 let targetRun=run;let profiles=[profile];
 if(kind==='duplicate')profiles=[profile,profile];
 if(kind==='missing')delete profile.targetBinding;
 if(kind==='repository-mismatch')profile.repository='qa/other-repo';
 if(kind==='changed-evidence')targetRun={...run,insight_groups:{title:'normal UX complaint',summary:'working behavior is inconvenient',category:'ux',status:'open'}};
 if(kind==='missing-reproduction')profile.checks=[];
 await writeFile(path,JSON.stringify({profiles}));
 await expect(executeClaimedRun(targetRun,'token')).rejects.toThrow('insufficient_evidence');
 expect(state.engine).not.toHaveBeenCalled();expect(state.writes).toContainEqual(expect.objectContaining({status:'stopped',stop_reason:'insufficient_evidence'}));
});
// 완화(2026-09-14): 이 대상을 겨냥한 프로필이 «없으면» 검증 없이 진행한다.
// 프로필은 제보마다 손으로 쓰는 것이고 생성하는 코드가 없어서, 여기서 막으면 자동 PR 이 영영 꺼진다.
it('이 대상을 겨냥한 프로필이 아예 없으면 검증 없이 진행하고 unverifiable 로 남는다',async()=>{
 state.engine.mockResolvedValue({status:'stopped',reason:'no_change',files_changed:[]});
 const targetRun={...run,group_id:'22222222-2222-4222-8222-222222222222',insight_groups:{title:'coupon bug',summary:'coupon bug',category:'bug',status:'open'}};
 await expect(executeClaimedRun(targetRun,'token')).rejects.toThrow('no_change');
 expect(state.engine).toHaveBeenCalledOnce();
 expect(state.engine.mock.calls[0][0].validation).toBeUndefined();
 expect(state.writes).toContainEqual(expect.objectContaining({validation_status:'unverifiable'}));
});
it('프로필 파일이 아예 없으면 none 이고, 다른 종류의 대상에는 프로필이 짝지어지지 않는다',async()=>{
 const input=await resolveRunValidationInput(run);
 // group 프로필을 같은 id 의 insight 대상에 쓸 수 없다 — 절대 'profile' 이 되어선 안 된다
 expect((await loadTrustedValidationConfig('qa/repo',{kind:'insight',id:run.group_id!},input.evidenceDigest)).kind).toBe('none');
 vi.stubEnv('FEEDLOOP_VALIDATION_PROFILES','');
 expect(await loadTrustedValidationConfig('qa/repo',input.target,input.evidenceDigest)).toEqual({kind:'none',profilesForRepository:0});
});
it('unmatched reconciliation keeps previously validated proof intact',async()=>{
 const pending={...run,publication_status:'pending',publication_intent:{branch:'stable'},validation_status:'validated',validation_evidence:{status:'validated'},insight_groups:{title:'changed issue',summary:'new evidence',category:'bug',status:'open'}};
 await expect(executeClaimedRun(pending,'token')).rejects.toThrow('insufficient_evidence');
 expect(state.engine).not.toHaveBeenCalled();expect(state.writes.every(p=>!('validation_evidence'in p)&&!('validation_status'in p))).toBe(true);
});

// 실제 엔진이 약한 경로에서 하는 일을 그대로 흉내낸다 — 발행 의사를 «먼저» 기록하고 PR 을 만든다.
function publishWithoutProfile(){
 state.engine.mockImplementation(async(o:{runId:string;onPublicationIntent:(i:unknown)=>Promise<void>})=>{
  await o.onPublicationIntent({runId:o.runId,branch:`feedloop/run-${o.runId}`,baseSha:'a'.repeat(40),
   patchDigest:'b'.repeat(64),profileDigest:UNVERIFIED_DIGEST,repository:'qa/repo',
   candidate:{analysis:'x',files:[],commit_message:'c',pr_title:'t',pr_body:'b'}});
  return {status:'published',pr_url:'https://github.com/qa/repo/pull/7',pr_number:7,files_changed:[],explanation:null};
 });
}
const noProfileRun={...run,group_id:'22222222-2222-4222-8222-222222222222'};

it('프로필 없는 실행이 PR 발행을 DB 에 «확정»한다 — 고아 PR 이 남지 않는다',async()=>{
 publishWithoutProfile();
 await expect(executeClaimedRun(noProfileRun,'token')).resolves.toMatchObject({status:'published'});
 expect(state.completes).toHaveLength(1);
 expect(state.completes[0]).toMatchObject({pr_url:'https://github.com/qa/repo/pull/7'});
 // PR 을 만들어 놓고 run 만 failed 로 남는 상태가 되어선 안 된다
 expect(state.writes).not.toContainEqual(expect.objectContaining({status:'failed'}));
});

it('완화 전 DB 규칙이면 같은 실행이 PR 을 만들고도 실패로 끝난다 (음성 대조)',async()=>{
 state.legacyGate=true;
 publishWithoutProfile();
 await expect(executeClaimedRun(noProfileRun,'token')).rejects.toThrow('publication persistence');
 expect(state.completes).toHaveLength(0);
 expect(state.writes).toContainEqual(expect.objectContaining({status:'failed'}));
});

it('증거를 지어낸 run 은 검증 없이 발행을 확정할 수 없다',async()=>{
 state.engine.mockImplementation(async(o:{runId:string;onPublicationIntent:(i:unknown)=>Promise<void>})=>{
  await o.onPublicationIntent({runId:o.runId,branch:`feedloop/run-${o.runId}`,baseSha:'a'.repeat(40),
   patchDigest:'b'.repeat(64),profileDigest:'c'.repeat(64),repository:'qa/repo',
   candidate:{analysis:'x',files:[],commit_message:'c',pr_title:'t',pr_body:'b'}});
  return {status:'published',pr_url:'https://github.com/qa/repo/pull/8',pr_number:8,files_changed:[],explanation:null};
 });
 await expect(executeClaimedRun(noProfileRun,'token')).rejects.toThrow('publication persistence');
 expect(state.completes).toHaveLength(0);
});

it('검증을 통과했던 증거는 프로필이 사라져도 «지우지 않는다» — 지우면 다음 클레임에 조용히 강등된다',async()=>{
 state.engine.mockResolvedValue({status:'stopped',reason:'validated_evidence_present',files_changed:[]});
 const withProof={...noProfileRun,validation_status:'validated',validation_evidence:{status:'validated'}};
 await expect(executeClaimedRun(withProof,'token')).rejects.toThrow();
 expect(state.writes.some(w=>w.validation_evidence===null)).toBe(false);
});

it('검증에 «떨어진» 잔여 증거는 비운다 — 남기면 DB 가 거절해 고아 PR 이 된다',async()=>{
 state.engine.mockResolvedValue({status:'stopped',reason:'no_change',files_changed:[]});
 const withFailed={...noProfileRun,validation_status:'failed',validation_evidence:{status:'failed'}};
 await expect(executeClaimedRun(withFailed,'token')).rejects.toThrow('no_change');
 expect(state.writes).toContainEqual(expect.objectContaining({validation_status:'unverifiable',validation_evidence:null}));
});

import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {AutoDevOptions} from '@/lib/auto-dev/ai-engine';
const state=vi.hoisted(()=>({writes:[] as {table:string;patch:Record<string,unknown>}[],failPublication:false,model:vi.fn(),claim:true,leaseValid:true}));
vi.mock('@/lib/auto-dev/ai-engine',()=>({callAutoDev:state.model}));
vi.mock('@/lib/auto-dev/validation-config',()=>({loadTrustedValidationConfig:async()=>({profile:{},runner:async()=>{}})}));
vi.mock('@/lib/insights/supplements',()=>({loadSupplementBodies:async()=>[],appendSupplements:(s:string)=>s}));
vi.mock('@/lib/supabase',()=>({getServiceRoleClient:()=>({
 rpc:async(name:string,args:Record<string,unknown>)=>{if(name==='claim_pipeline_run')return {data:state.claim?'lease-1':null,error:null};if(name==='assert_pipeline_run_lease')return {data:state.leaseValid,error:null};if(name==='save_pipeline_run'){state.writes.push({table:'auto_dev_runs',patch:args.p_values as Record<string,unknown>});return {data:true,error:state.failPublication&&(args.p_values as Record<string,unknown>).publication_status==='pending'?{message:'disk unavailable'}:null};}if(name==='complete_pipeline_run')state.writes.push({table:'completion_rpc',patch:args});if(name==='record_pipeline_attempt')state.writes.push({table:'auto_dev_attempts',patch:args});return {data:state.claim,error:null};},
 from:(table:string)=>{
  let patch:Record<string,unknown>|undefined;
  const q={select:()=>q,eq:()=>q,single:async()=>({data:{lease_token:'lease-1'},error:null}),
   update:(p:Record<string,unknown>)=>{patch=p;state.writes.push({table,patch:p});return q;},
   upsert:(p:Record<string,unknown>)=>{patch=p;state.writes.push({table,patch:p});return q;},
   then:(resolve:(r:unknown)=>unknown)=>resolve({data:[{id:'run-1'}],error:state.failPublication&&patch?.publication_status==='pending'?{message:'disk unavailable'}:null})};return q;
 }
})}));
import {executeClaimedRun,claimRun,type LoadedRun} from '@/lib/auto-dev/execute-run';
const run:LoadedRun={id:'run-1',bot_id:'bot-1',insight_id:'insight-1',group_id:null,status:'in_progress',pr_url:null,pr_number:null,files_changed:null,error_message:null,insights:{category:'bug',summary:'button broken',messages:{body:'click fails'}},insight_groups:null,bots:{github_repo_url:'https://github.com/qa/repo',user_id:'owner'}};
const evidence={status:'validated',reason:'passed',runId:'run-1',repository:'qa/repo',baseSha:'a'.repeat(40),snapshotDigest:'s',patchDigest:'p',profileDigest:'t',image:'sha256:'+ 'a'.repeat(64),checks:[],attempt:1} as const;
beforeEach(()=>{state.writes=[];state.failPublication=false;state.claim=true;state.leaseValid=true;state.model.mockReset();});
describe('lifecycle engine boundary',()=>{
 it('persists bounded spend, attempt and intent before returning publication',async()=>{
  state.model.mockImplementation(async(o:AutoDevOptions)=>{
   await o.onBudgetReserved!({model:'pinned',calls:1,inputTokens:10,outputTokens:20,reservedUsd:0.1,deadline:o.deadline!});
   await o.onAttempt!({...evidence,checks:[]});await o.onValidated!({...evidence,checks:[]});
   await o.onPublicationIntent!({runId:'run-1',branch:'stable',baseSha:evidence.baseSha,patchDigest:'p',profileDigest:'t',repository:'qa/repo',candidate:{analysis:'cause',files:[],commit_message:'fix',pr_title:'fix',pr_body:'evidence'}});
   expect(state.writes.at(-1)?.patch.publication_status).toBe('pending');
   return {status:'published',pr_url:'https://github.com/qa/repo/pull/1',pr_number:1,files_changed:[],validation:evidence};
  });
  await executeClaimedRun(run,'lease-1');
  expect(state.writes.some(w=>w.table==='auto_dev_attempts')).toBe(true);
  expect(state.writes.at(-1)?.table).toBe('completion_rpc');
  expect(state.writes.at(-1)?.patch.p_result).toMatchObject({pr_number:1});
 });
 it('intent persistence failure prevents publisher side effect',async()=>{
  state.failPublication=true;let published=false;
  state.model.mockImplementation(async(o:AutoDevOptions)=>{
   await o.onPublicationIntent!({} as never);published=true;
  });
  await expect(executeClaimedRun(run,'lease-1')).rejects.toThrow('disk unavailable');
  expect(published).toBe(false);
 });
 it('unverifiable result records explicit state rather than completed',async()=>{
  state.model.mockResolvedValue({status:'unverifiable',reason:'runner_profile_unavailable',files_changed:[]});
  await expect(executeClaimedRun(run,'lease-1')).rejects.toThrow('runner_profile_unavailable');
  expect(state.writes.some(w=>w.patch.status==='unverifiable')).toBe(true);
  expect(state.writes.some(w=>w.patch.status==='completed')).toBe(false);
 });
 it('merged symptom blocks engine entry',async()=>{
  await expect(executeClaimedRun({...run,group_id:'group',insight_groups:{category:'bug',title:'bug',summary:'bug',status:'merged',follow_up_pending:true}},'lease-1')).rejects.toThrow('group_follow_up_hold');
  expect(state.model).not.toHaveBeenCalled();
 });
 it('lost captured lease blocks model entry',async()=>{state.leaseValid=false;await expect(executeClaimedRun(run,'old-token')).rejects.toThrow('execution_lease_lost');expect(state.model).not.toHaveBeenCalled();expect(state.writes).toEqual([]);});
 it('run claim respects atomic RPC loss',async()=>{state.claim=false;expect(await claimRun('run')).toBe(null);});
});

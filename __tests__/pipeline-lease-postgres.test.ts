/** Opt-in application + real SQL lease race proof; no model/GitHub network calls. */
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import type {AutoDevOptions} from '@/lib/auto-dev/ai-engine';
const boundary=vi.hoisted(()=>({rpc:vi.fn(),engine:vi.fn(),publication:vi.fn()}));
vi.mock('@/lib/supabase',()=>({getServiceRoleClient:()=>({rpc:boundary.rpc})}));
vi.mock('@/lib/auto-dev/ai-engine',()=>({callAutoDev:boundary.engine}));
vi.mock('@/lib/auto-dev/validation-config',()=>({loadTrustedValidationConfig:async()=>({kind:'profile',profile:{},runner:async()=>{}})}));
vi.mock('@/lib/insights/supplements',()=>({loadSupplementBodies:async()=>[],appendSupplements:(s:string)=>s}));
import {claimRun,executeClaimedRun,type LoadedRun} from '@/lib/auto-dev/execute-run';
const suite=process.env.PIPELINE_LEASE_POSTGRES==='1'?describe:describe.skip;
suite('captured lease against real disposable PostgreSQL',()=>{
 const sql=postgres('postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa');
 const user=randomUUID(),bot=randomUUID(),group=randomUUID();let id:string;
 let loaded:LoadedRun;
 beforeAll(async()=>{
  await sql`insert into users(id,name) values(${user},'lease-race-local-QA')`;
  await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bot},${user},'test-only','lease race QA')`;
  await sql`insert into insight_groups(id,bot_id,title,summary,category,status) values(${group},${bot},'bug','bug','bug','open')`;
  id=(await sql`select create_pipeline_run(${bot}::uuid,${group}::uuid,null::uuid) id`)[0].id;
  loaded={id,bot_id:bot,insight_id:'fixture',group_id:null,status:'in_progress',pr_url:null,pr_number:null,files_changed:null,error_message:null,insights:{category:'bug',summary:'bug',messages:{body:'bug'}},insight_groups:null,bots:{github_repo_url:'https://github.com/qa/repo',user_id:user}};
  boundary.rpc.mockImplementation(async(name:string,a:Record<string,unknown>)=>{
   try{
    if(name==='save_pipeline_run'){const rows=await sql`select save_pipeline_run(${a.p_id as string}::uuid,${a.p_token as string}::uuid,${sql.json(a.p_values as postgres.JSONValue)}) value`;return {data:rows[0].value,error:null};}
    const p=[a.p_id];if('p_token' in a)p.push(a.p_token);if('p_values'in a)p.push(JSON.stringify(a.p_values));
    const casts=p.map((_,i)=>`$${i+1}::${i===2?'jsonb':'uuid'}`).join(',');
    if(!['claim_pipeline_run','assert_pipeline_run_lease','save_pipeline_run'].includes(name))throw new Error('unexpected RPC');
    const rows=await sql.unsafe(`select ${name}(${casts}) value`,p as string[]);return {data:rows[0].value,error:null};
   }catch(e){return {data:null,error:{message:(e as Error).message}};}
  });
 });
 afterAll(async()=>{await sql`delete from users where id=${user}`;await sql.end();});
 it('delayed A cannot acquire B token through execute and performs zero model/PR writes',async()=>{
  const a=(await claimRun(id))!;
  await sql`update auto_dev_runs set lease_until=now()-interval '1 second' where id=${id}`;
  const b=(await claimRun(id))!;expect(b).not.toBe(a);
  await expect(executeClaimedRun(loaded,a)).rejects.toThrow('execution_lease_lost');
  expect(boundary.engine).not.toHaveBeenCalled();expect(boundary.publication).not.toHaveBeenCalled();
  expect((await sql`select lease_token,status from auto_dev_runs where id=${id}`)[0]).toMatchObject({lease_token:b,status:'in_progress'});
 });
 it('owner replaced during engine work cannot persist intent or publish through callback',async()=>{
  await sql`update auto_dev_runs set lease_until=now()-interval '1 second' where id=${id}`;
  const a=(await claimRun(id))!;let b:string;
  boundary.engine.mockImplementationOnce(async(o:AutoDevOptions)=>{
   await sql`update auto_dev_runs set lease_until=now()-interval '1 second' where id=${id}`;
   b=(await claimRun(id))!;
   await o.onPublicationIntent!({} as never);boundary.publication();
  });
  await expect(executeClaimedRun(loaded,a)).rejects.toThrow('execution_lease_lost');
  expect(boundary.publication).not.toHaveBeenCalled();
  expect((await sql`select lease_token,status,publication_intent from auto_dev_runs where id=${id}`)[0]).toMatchObject({lease_token:b!,status:'in_progress',publication_intent:null});
 });
 it('unverifiable publication retries reuse the ID and preserve receipt and spend',async()=>{
  const receipt={status:'validated',runId:id,patchDigest:'a'.repeat(64)};
  const intent={runId:id,branch:`feedloop/run-${id}`};
  const budget={calls:4,reservedUsd:0.2};
  await sql`update auto_dev_runs set status='unverifiable',publication_status='pending',publication_intent=${sql.json(intent)},validation_status='validated',validation_evidence=${sql.json(receipt)},generation_budget=${sql.json(budget)} where id=${id}`;
  expect((await sql`select create_pipeline_run(${bot}::uuid,${group}::uuid,null::uuid) id`)[0].id).toBe(id);
  const token=(await claimRun(id))!;expect(token).toBeTruthy();
  boundary.engine.mockImplementationOnce(async(o:AutoDevOptions)=>{
   expect(o.publicationIntent).toEqual(intent);expect(o.previousValidation).toEqual(receipt);
   expect(o.budget).toMatchObject(budget);
   return {status:'unverifiable',reason:'github_transport_unavailable',files_changed:[]};
  });
  await expect(executeClaimedRun({...loaded,publication_status:'pending',publication_intent:intent,validation_evidence:receipt,generation_budget:budget},token)).rejects.toThrow('github_transport_unavailable');
  expect((await sql`select status,validation_evidence,generation_budget from auto_dev_runs where id=${id}`)[0]).toMatchObject({status:'unverifiable',validation_evidence:receipt,generation_budget:budget});
  expect(await claimRun(id)).toBeTruthy();
 });

});

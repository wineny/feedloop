/** Real grouping transport/DB evaluation. Preparation is offline; --live is explicit. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, appendFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import { buildGroupingPrompt, runGrouping, type GroupingResult } from '../src/lib/groups/grouping';

const ROOT = resolve('evals/grouping/live-v1');
const MODEL = 'claude-haiku-4-5-20251001';
const CAP = 0.50;
const MAX_CALLS = 4;
const OUTPUT = 4096;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Issue = { id: string; category: string; summary: string };
type Existing = Issue & { title: string; status: string };
type Contract = { id: string; kind: 'same'|'different'|'existing'|'merged'|'isolated-or-pending'|'pending'|'retained'; ids: string[]; target?: string };
type Batch = { id: string; insights: Issue[]; existing: Existing[]; cases: Contract[] };
type State = { issues: { id: string; group_id: string|null; category: string; source_intact?: boolean }[]; groups: { id: string; status: string; follow_up_pending: boolean; category: string }[]; runs: number };

export function reservationUsd(inputBytes: number) {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw Error('invalid_input_bound');
  return (inputBytes + 4096 + OUTPUT * 5) / 1_000_000;
}
export function scoreContract(c: Contract, state: State, id: (key:string)=>string, batchFailed: boolean) {
  const rows = c.ids.map(key => state.issues.find(i => i.id === id(key)));
  const groups = rows.map(row => row?.group_id);
  let correct = false;
  switch(c.kind) {
    case 'same': correct = !!groups[0] && groups.every(g => g === groups[0]); break;
    case 'different': correct = groups.every(Boolean) && new Set(groups).size === groups.length; break;
    case 'existing': correct = groups.every(g => g === id(c.target!)); break;
    case 'merged': {
      const group = state.groups.find(g => g.id === id(c.target!));
      correct = groups.every(g => g === group?.id) && group?.status === 'merged' && group.follow_up_pending && state.runs === 0; break;
    }
    case 'isolated-or-pending': correct = !!rows[0] && (!groups[0] || state.issues.filter(i => i.group_id === groups[0]).length === 1); break;
    case 'pending': correct = !!rows[0] && groups[0] === null; break;
    case 'retained': correct = rows.every(row => row?.source_intact === true); break;
  }
  // Retention can remain safe after failure; never count a failed semantic decision as success.
  const safety = c.kind === 'retained' || c.kind === 'pending';
  return { id:c.id, kind:c.kind, safety, correct: correct && (safety || !batchFailed), observed: groups, batchFailed };
}
function sourceHashes() {
  return Object.fromEntries([
    'scripts/eval-grouping-live-v1.ts','evals/grouping/live-v1/fixtures.json','evals/grouping/live-v1/PLAN.md',
    'src/lib/groups/grouping.ts','src/lib/classify/taxonomy.ts','src/lib/bot/core.ts','src/lib/bot/handler.ts',
    'src/lib/llm/provider.ts','src/lib/llm/models.ts','src/lib/supabase.ts','package-lock.json',
    'node_modules/ai/package.json','node_modules/@ai-sdk/anthropic/package.json',
    'supabase/migrations/20260913_10_pipeline_intake.sql',
  ].map(p => [p,sha(readFileSync(p))]));
}
function durableAppend(path:string, row:unknown) {
  const fd = openSync(path, 'a');
  try { appendFileSync(fd, JSON.stringify(row)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--freeze','--dry-run','--live'].includes(a)) || new Set(args).size !== args.length || (args.includes('--live') && args.length !== 1)) throw Error('invalid_flags');
  const fixture = JSON.parse(readFileSync(ROOT+'/fixtures.json','utf8')) as {batches:Batch[]};
  const sources=sourceHashes();
  const manifestFile=ROOT+'/manifest.json';
  if (args.includes('--freeze')) {
    mkdirSync(ROOT,{recursive:true});
    const namespace=randomUUID();
    const id=(key:string)=>{const h=sha(namespace+':'+key);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
    const batches=fixture.batches.map(b=>{
      const prompt=buildGroupingPrompt(b.insights.filter(i=>['bug','ux','feature_request'].includes(i.category)).map(i=>({...i,id:id(i.id)})),b.existing.map(g=>({id:id(g.id),title:g.title,status:g.status,summary:g.summary,category:g.category})));
      return {id:b.id,botId:id(b.id),promptHash:sha(prompt),maximumRequestBytes:Buffer.byteLength(prompt)+8192,reservation:reservationUsd(Buffer.byteLength(prompt)+8192)};
    });
    if(batches.length>MAX_CALLS || batches.reduce((n,b)=>n+b.reservation,0)>CAP) throw Error('preflight_budget_exceeded');
    writeFileSync(manifestFile,JSON.stringify({version:1,frozenAt:new Date().toISOString(),namespace,userId:id('user'),sources,batches,model:MODEL,outputCeiling:OUTPUT,maxCalls:MAX_CALLS,maxUsd:CAP,caseCount:fixture.batches.flatMap(b=>b.cases).length,codeCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},null,2)+'\n',{flag:'wx'});
  }
  if(!existsSync(manifestFile)) throw Error('freeze_required');
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  if(JSON.stringify(manifest.sources)!==JSON.stringify(sources)) throw Error('frozen_source_mismatch');
  const id=(key:string)=>{const h=sha(manifest.namespace+':'+key);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
  if(!args.includes('--live')) {
    console.log(JSON.stringify({prepared:true,model:MODEL,cases:manifest.caseCount,plannedCalls:manifest.batches.length,maximumReservedUsd:manifest.batches.reduce((n:number,b:{reservation:number})=>n+b.reservation,0),manifestHash:sha(readFileSync(manifestFile)),sources},null,2));return;
  }
  if(process.env.NODE_OPTIONS || process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0' || Object.keys(process.env).some(k=>/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ANTHROPIC_BASE_URL|FEEDLOOP_QA_)/i.test(k)&&process.env[k])) throw Error('custom_transport_refused');
  if(!process.env.PLATFORM_ANTHROPIC_API_KEY?.trim()&&!process.env.ANTHROPIC_API_KEY?.trim()) throw Error('anthropic_key_missing');
  const env=JSON.parse(readFileSync('.omx/qa/env.json','utf8'));
  if(env.NEXT_PUBLIC_SUPABASE_URL!=='http://127.0.0.1:55441'||!env.SUPABASE_SERVICE_ROLE_KEY) throw Error('owned_local_rest_required');
  process.env.NEXT_PUBLIC_SUPABASE_URL=env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY=env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.PLATFORM_LLM_PROVIDER='anthropic';process.env.PLATFORM_LLM_MODEL=MODEL;
  const ledger=ROOT+'/budget.jsonl',resultFile=ROOT+'/results.json',lock=ROOT+'/budget.lock';
  if(existsSync(resultFile)||existsSync(ledger)) throw Error('run_already_started_no_automatic_retry');
  const lockFd=openSync(lock,'wx');
  const sql=postgres('postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa',{max:2});
  const originalFetch=globalThis.fetch;
  const calls:Record<string,unknown>[]=[];
  const results:Record<string,unknown>[]=[];
  let reserved=0,active=-1,seeded=false,cleanup=false;
  let databaseEvidence: unknown = null;
  const aggregate=()=>{
    const scores=results.flatMap(r=>r.scores as ReturnType<typeof scoreContract>[]);
    const tally=(items:typeof scores)=>({correct:items.filter(s=>s.correct).length,total:items.length});
    return {all:{...tally(scores),total:manifest.caseCount},semantic:tally(scores.filter(s=>!s.safety)),safety:tally(scores.filter(s=>s.safety)),pairwise:tally(scores.filter(s=>s.kind==='same'||s.kind==='different')),existingIdentity:tally(scores.filter(s=>s.kind==='existing'||s.kind==='merged')),chargedUsd:calls.reduce((n,c)=>n+Number(c.chargedUsd??c.reservedUsd),0)};
  };
  const startedAt=new Date().toISOString();
  const checkpoint=()=>writeFileSync(resultFile,JSON.stringify({version:1,startedAt,databaseEvidence,aggregate:aggregate(),manifestHash:sha(readFileSync(manifestFile)),model:MODEL,calls,results,plannedCases:manifest.caseCount,completedCases:results.reduce((n,r)=>n+(r.scores as unknown[]).length,0),reservedUsd:reserved,cleanup,ownership:{userId:manifest.userId,botIds:manifest.batches.map((b:{botId:string})=>b.botId)}},null,2)+'\n');
  globalThis.fetch=async (input,init)=>{
    if(JSON.stringify(sourceHashes())!==JSON.stringify(manifest.sources)) throw Error('source_changed_during_run');
    const request=new Request(input,init);const url=new URL(request.url);
    if(url.origin==='http://127.0.0.1:55441'&&url.pathname.startsWith('/rest/v1/')) return originalFetch(request,{redirect:'error'});
    if(url.href!=='https://api.anthropic.com/v1/messages'||request.method!=='POST') throw Error('unexpected_remote_transport');
    const body=JSON.parse(await request.text());
    if(body.model!==MODEL||body.stream||body.tools||body.thinking) throw Error('unexpected_model_request');
    if(active<0||calls.some(c=>c.batch===fixture.batches[active].id)) throw Error('unexpected_retry');
    body.max_tokens=OUTPUT;
    const encoded=JSON.stringify(body),job=manifest.batches[active];
    if(Buffer.byteLength(encoded)>job.maximumRequestBytes) throw Error('request_exceeds_preflight_bound');
    const user=body.messages?.[0]?.content;
    const text=typeof user==='string'?user:Array.isArray(user)?user.filter((p:{type:string})=>p.type==='text').map((p:{text:string})=>p.text).join(''):'';
    if(sha(text)!==job.promptHash) throw Error('production_prompt_differs_from_frozen');
    const amount=reservationUsd(Buffer.byteLength(encoded));
    if(calls.length>=MAX_CALLS||reserved+amount>CAP) throw Error('budget_exhausted');
    const call:Record<string,unknown>={batch:fixture.batches[active].id,request:body,requestHash:sha(encoded),reservedUsd:amount,startedAt:new Date().toISOString(),status:'reserved'};
    durableAppend(ledger,{type:'reserve',index:calls.length,manifestHash:sha(readFileSync(manifestFile)),amountUsd:amount,requestHash:call.requestHash});
    reserved+=amount;calls.push(call);checkpoint();const start=Date.now();
    try {
      const response=await originalFetch(new Request(request,{body:encoded}),{redirect:'error'});
      const raw=await response.clone().text();
      call.httpStatus=response.status;call.raw=raw;call.latencyMs=Date.now()-start;
      const parsed=JSON.parse(raw);call.usage=parsed.usage??null;
      const u=parsed.usage;
      const actual=u&&Number.isInteger(u.input_tokens)&&Number.isInteger(u.output_tokens)&&u.input_tokens>=0&&u.output_tokens>=0&&!u.cache_creation_input_tokens&&!u.cache_read_input_tokens?(u.input_tokens+u.output_tokens*5)/1_000_000:null;
      call.actualUsd=actual;call.chargedUsd=actual!=null&&actual<=amount?actual:amount;
      call.status=response.ok?'response':'provider_failure';
      durableAppend(ledger,{type:'settle',index:calls.length-1,status:call.status,chargedUsd:call.chargedUsd,latencyMs:call.latencyMs});checkpoint();return response;
    } catch {
      call.status='transport_or_receipt_unknown';call.chargedUsd=amount;call.latencyMs=Date.now()-start;
      durableAppend(ledger,{type:'settle',index:calls.length-1,status:call.status,chargedUsd:amount,latencyMs:call.latencyMs});checkpoint();throw Error('provider_transport_failed');
    }
  };
  try {
    databaseEvidence={version:(await sql`select version() v`)[0].v,functions:(await sql`select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('pipeline_group_snapshot','pipeline_commit_groups') order by proname`).map(row=>({name:row.proname,sha256:sha(row.definition)}))};
    await sql`insert into users(id,name) values(${manifest.userId},'grouping-live-v1-owned-fixture')`;seeded=true;
    for(const b of fixture.batches) {
      await sql`insert into bots(id,user_id,bot_token_encrypted,service_name,pr_mode) values(${id(b.id)},${manifest.userId},'test-only-no-channel','Grouping live fixture','approval')`;
      for(const g of b.existing) await sql`insert into insight_groups(id,bot_id,title,summary,category,status) values(${id(g.id)},${id(b.id)},${g.title},${g.summary},${g.category},${g.status})`;
      for(const i of b.insights) {
        await sql`insert into messages(id,bot_id,source,author_name,body,detected_at) values(${id('message:'+i.id)},${id(b.id)},'web','Synthetic QA',${i.summary},now())`;
        await sql`insert into insights(id,bot_id,message_id,category,summary,sentiment,created_at) values(${id(i.id)},${id(b.id)},${id('message:'+i.id)},${i.category},${i.summary},'neutral',${new Date(1700000000000+b.insights.indexOf(i)*1000)})`;
      }
    }
    for(let n=0;n<fixture.batches.length;n++) {
      active=n;const b=fixture.batches[n];let run:GroupingResult;
      try {run=await runGrouping([id(b.id)],Date.now()+75_000);} catch {run={grouped:0,groups:[],failures:[{botId:id(b.id),reason:'unhandled_execution_failure'}]};}
      const persisted=await sql`select i.id,i.group_id,i.category,m.id message_id,m.body,s.insight_id source_insight_id from insights i left join messages m on m.id=i.message_id left join insight_message_sources s on s.message_id=m.id where i.bot_id=${id(b.id)}`;
      const state:State={issues:persisted.map(row=>{
        const expected=b.insights.find(i=>id(i.id)===row.id);
        return {id:row.id,group_id:row.group_id,category:row.category,source_intact:!!expected && row.body===expected.summary && row.category===expected.category && row.message_id===id('message:'+expected.id) && row.source_insight_id===row.id};
      }),groups:await sql`select id,status,follow_up_pending,category from insight_groups where bot_id=${id(b.id)}`,runs:(await sql`select count(*)::int n from auto_dev_runs where bot_id=${id(b.id)}`)[0].n};
      const failed=Boolean(run.failures?.length||run.deferred);
      const scores=b.cases.map(c=>scoreContract(c,state,id,failed));
      const crossPolicy=state.groups.every(g=>state.issues.filter(i=>i.group_id===g.id).every(i=>(i.category==='feature_request')===(g.category==='feature_request')));
      results.push({batch:b.id,run,state,scores,policySafety:{crossCategorySeparated:crossPolicy,noAutoRuns:state.runs===0},omittedIds:state.issues.filter(i=>!i.group_id&&['bug','ux','feature_request'].includes(i.category)).map(i=>i.id)});checkpoint();
    }
  } finally {
    globalThis.fetch=originalFetch;
    for(const b of fixture.batches) if(!results.some(r=>r.batch===b.id)) {
      const state:State={issues:[],groups:[],runs:0};
      results.push({batch:b.id,status:'not_executed',scores:b.cases.map(c=>scoreContract(c,state,id,true))});
    }
    try {if(seeded) await sql`delete from users where id=${manifest.userId} and name='grouping-live-v1-owned-fixture'`;cleanup=true;} finally {await sql.end();checkpoint();closeSync(lockFd);unlinkSync(lock);}
  }
  const all=results.flatMap(r=>r.scores as ReturnType<typeof scoreContract>[]);
  const accepted=all.length===manifest.caseCount&&all.every(s=>s.correct)&&results.every(r=>r.policySafety && Object.values(r.policySafety as object).every(Boolean));
  if(!accepted) process.exitCode=1;
  console.log(JSON.stringify({accepted,cases:manifest.caseCount,correct:all.filter(s=>s.correct).length,semantic:{correct:all.filter(s=>!s.safety&&s.correct).length,total:all.filter(s=>!s.safety).length},safety:{correct:all.filter(s=>s.safety&&s.correct).length,total:all.filter(s=>s.safety).length},calls:calls.length,reservedUsd:reserved,cleanup,resultFile},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error(JSON.stringify({error:'grouping_live_eval_failed',stage:existsSync(ROOT+'/results.json')?'inspect_existing_execution_receipt':'preflight_no_dispatch',automaticRetry:false}));process.exitCode=1;});

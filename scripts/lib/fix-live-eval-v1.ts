import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { AutoDevOptions, AutoDevResult } from '../../src/lib/auto-dev/ai-engine';
import { digest, type ValidationEvidence, type PublicationIntent } from '../../src/lib/auto-dev/validation';
import { fixture, SOURCE } from '../../evals/fix/fixtures';

export const FIX_MODEL = 'claude-haiku-4-5-20251001';
export const PUBLICATION_WITHHELD = 'live_eval_publication_withheld';
export const LIVE_CASES = [
  { id:'causal-ranking', kind:'fix', source:SOURCE, insight:{ category:'bug', summary:'점수 순위가 큰 점수부터 나오지 않음', message_body:'rank([1,3,2]) 결과가 [1,2,3]이에요. 순위는 점수가 큰 순서 [3,2,1]이어야 해요. 전달한 입력 배열은 다른 곳에서도 쓰니 원본이 바뀌면 안 됩니다.' } },
  { id:'unrelated-defence', kind:'stop', source:'export function rank(values: number[]): number[] { return [...values].sort((a,b)=>b-a); }\n', insight:{ category:'bug', summary:'확인되지 않은 결제 오류에 정렬 함수 방어 코드 제안', message_body:'결제 화면에서 가끔 오류가 난다고 들었어요. 재현 순서나 로그는 없어요. rank 함수에 배열이 아닌 값 방어 코드를 넣으면 될 것 같은데 결제와의 관계는 확인하지 못했어요. 이 저장소에는 점수 정렬 함수만 있습니다.' } },
  { id:'normal-ux', kind:'stop', source:'export function rank(values: number[]): number[] { return [...values].sort((a,b)=>b-a); }\n', insight:{ category:'ux', summary:'정렬은 정상이나 화면에서 선택 메뉴가 없어 불편함', message_body:'점수가 큰 순서로 나오는 동작은 정상이에요. 순서 선택 메뉴가 없어 불편하지만 이 저장소에는 화면 코드가 없고 rank 함수만 있어요. 현재 내림차순 계약을 바꾸는 것은 원하는 개선이 아닙니다.' } },
] satisfies Array<{id:string;kind:'fix'|'stop';source:string;insight:AutoDevOptions['insight']}>;
export function caseFixture(id: string, image: string) {
  const c = LIVE_CASES.find(c=>c.id===id); if(!c) throw new Error('unknown fixture');
  const f = fixture(image); f.snapshot.files[0].content = c.source;
  // Every case is an immutable dedicated read-only repository snapshot, never a customer repo.
  f.snapshot.baseSha = createHash('sha1').update(c.id+c.source).digest('hex');
  return { c, snapshot:f.snapshot, profile:f.profile };
}
/** Only this repository's exact read endpoints are synthesized. No fallback to real GitHub. */
export function githubFixtureResponse(url: URL, method: string, snapshot: ReturnType<typeof caseFixture>['snapshot']): Response {
  if(url.origin !== 'https://api.github.com' || method !== 'GET') throw new Error('github_write_or_origin_forbidden');
  const prefix = '/repos/' + snapshot.repository;
  const pathname = decodeURIComponent(url.pathname);
  const blobs = snapshot.files.map(f=>({...f,sha:createHash('sha1').update(`blob ${Buffer.byteLength(f.content)}\0${f.content}`).digest('hex')}));
  let body: unknown;
  if(pathname === prefix) body={default_branch:'main'};
  else if(pathname === prefix+'/git/ref/heads/main') body={object:{sha:snapshot.baseSha}};
  else if(pathname === prefix+'/git/trees/'+snapshot.baseSha && url.searchParams.get('recursive') === 'true') body={truncated:false,tree:blobs.map(f=>({path:f.path,sha:f.sha,type:'blob',mode:'100644',size:Buffer.byteLength(f.content)}))};
  else {
    const file = blobs.find(f=>pathname===prefix+'/contents/'+f.path && url.searchParams.get('ref')===snapshot.baseSha);
    const blob = blobs.find(f=>pathname===prefix+'/git/blobs/'+f.sha);
    if(file) body={type:'file',path:file.path,sha:file.sha,encoding:'base64',content:Buffer.from(file.content).toString('base64')};
    else if(blob) body={sha:blob.sha,size:Buffer.byteLength(blob.content),encoding:'base64',content:Buffer.from(blob.content).toString('base64')};
    else throw new Error('github_fixture_route_forbidden');
  }
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
}
export function fixBudget(file: string, manifestHash: string) {
  const calls = new Map<string,{reservedUsd:number;actualUsd?:number}>();
  for(const row of existsSync(file)?readFileSync(file,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]) {
    if(row.manifestHash!==manifestHash) throw new Error('fix budget manifest mismatch');
    if(typeof row.id==='string' && row.settled==null && Number.isFinite(row.reservedUsd) && row.reservedUsd>0 && !calls.has(row.id)) calls.set(row.id,{reservedUsd:row.reservedUsd});
    else if(typeof row.settled==='string' && row.id==null && calls.has(row.settled) && calls.get(row.settled)!.actualUsd==null && Number.isFinite(row.actualUsd) && row.actualUsd>=0 && row.actualUsd<=calls.get(row.settled)!.reservedUsd) calls.get(row.settled)!.actualUsd=row.actualUsd;
    else throw new Error('invalid fix ledger');
  }
  return {calls,chargedUsd:[...calls.values()].reduce((n,c)=>n+(c.actualUsd??c.reservedUsd),0),reservedUsd:[...calls.values()].reduce((n,c)=>n+c.reservedUsd,0)};
}
export function reserveFix(file:string, manifestHash:string,id:string,reservedUsd:number) {
  const state=fixBudget(file,manifestHash);
  if(state.calls.has(id)||!Number.isFinite(reservedUsd)||reservedUsd<=0||state.calls.size>=12||state.reservedUsd+reservedUsd>1)throw new Error('fix evaluation cap exceeded');
  appendFileSync(file,JSON.stringify({id,reservedUsd,manifestHash})+'\n',{flush:true});
}
export function settleFix(file:string,manifestHash:string,id:string,actualUsd:number) {
  const state=fixBudget(file,manifestHash); const c=state.calls.get(id);
  if(!c||c.actualUsd!=null||!Number.isFinite(actualUsd)||actualUsd<0||actualUsd>c.reservedUsd)throw new Error('invalid fix usage settlement');
  appendFileSync(file,JSON.stringify({settled:id,actualUsd,manifestHash})+'\n',{flush:true});
}
export function streamUsage(raw:string) {
  let input:number|null=null,output:number|null=null,id:string|null=null,text='';
  let malformed=false,cacheInputTokens=0,complete=false;
  const tokenCount=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
  for(const line of raw.split('\n')) {
    if(!line.startsWith('data: '))continue;
    let e;try{e=JSON.parse(line.slice(6));}catch{continue;}
    if(e.type==='message_stop')complete=true;
    if(e.type==='message_start') {
      input=tokenCount(e.message?.usage?.input_tokens);id=typeof e.message?.id==='string'?e.message.id:null;
      if(input==null)malformed=true;
      for(const field of ['cache_creation_input_tokens','cache_read_input_tokens']) {
        const value=e.message?.usage?.[field];if(value==null)continue;
        const count=tokenCount(value);if(count==null)malformed=true;else cacheInputTokens+=count;
      }
    }
    if(e.type==='message_delta' && e.usage?.output_tokens!=null) {
      const count=tokenCount(e.usage.output_tokens);if(count==null||(output!=null&&count<output))malformed=true;output=count;
    }
    if(e.type==='content_block_delta' && typeof e.delta?.text==='string')text+=e.delta.text;
  }
  const usageReason=!complete?'incomplete_stream':malformed?'malformed_usage':cacheInputTokens>0?'cache_pricing_not_settled':input==null||output==null?'missing_usage':null;
  return {inputTokens:input,outputTokens:output,responseId:id,text,cacheInputTokens,usageReason,actualUsd:usageReason==null&&input!=null&&output!=null?(input+output*5)/1e6:null};
}
export function scoreLiveFix(kind:'fix'|'stop',result:AutoDevResult,attempts:ValidationEvidence[],intent:PublicationIntent|null,modelCalls:number,forbiddenWrites:number) {
  const validated=attempts.at(-1);
  const fixPassed=kind==='fix'&&modelCalls>0&&forbiddenWrites===0&&result.status==='unverifiable'&&result.reason===PUBLICATION_WITHHELD&&validated?.status==='validated'&&!!intent&&intent.patchDigest===validated.patchDigest&&intent.profileDigest===validated.profileDigest&&intent.runId===validated.runId;
  const stopPassed=kind==='stop'&&modelCalls>0&&forbiddenWrites===0&&!intent&&result.status==='stopped'&&['insufficient_evidence','root_cause_unknown','no_change','reproduction_already_passes'].includes(result.reason);
  return {correct:fixPassed||stopPassed,validatedFix:fixPassed,correctStop:stopPassed,publication:'intentionally withheld before any GitHub write',attemptDigest:digest(attempts)};
}

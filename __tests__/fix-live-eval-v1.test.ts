import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Octokit } from '@octokit/rest';
import { caseFixture, githubFixtureResponse, reserveFix, settleFix, fixBudget, streamUsage, scoreLiveFix } from '../scripts/lib/fix-live-eval-v1';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const f=caseFixture('causal-ranking','sha256:'+'a'.repeat(64));
describe('live fix evaluation boundaries',()=>{
 it('permits only exact dedicated snapshot GET endpoints',async()=>{
  const prefix='https://api.github.com/repos/'+f.snapshot.repository;
  expect(await githubFixtureResponse(new URL(prefix),'GET',f.snapshot).json()).toEqual({default_branch:'main'});
  const tree=await githubFixtureResponse(new URL(prefix+'/git/trees/'+f.snapshot.baseSha+'?recursive=true'),'GET',f.snapshot).json();
  expect(tree.tree).toHaveLength(1);
  const blob=await githubFixtureResponse(new URL(prefix+'/git/blobs/'+tree.tree[0].sha),'GET',f.snapshot).json();
  expect(Buffer.from(blob.content,'base64').toString()).toBe(f.c.source);
  expect(()=>githubFixtureResponse(new URL(prefix+'/git/refs'),'POST',f.snapshot)).toThrow();
  expect(()=>githubFixtureResponse(new URL('https://api.github.com/repos/customer/repo'),'GET',f.snapshot)).toThrow();
  expect(()=>githubFixtureResponse(new URL(prefix+'/contents/ranking.ts?ref=main'),'GET',f.snapshot)).toThrow();
 });
 it('matches actual installed Octokit read URL contracts without a network fallback',async()=>{
  const client=new Octokit({auth:'fixture-only',request:{fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{const r=new Request(input,init);return githubFixtureResponse(new URL(r.url),r.method,f.snapshot);}}});
  const [owner,repo]=f.snapshot.repository.split('/');
  expect((await client.repos.get({owner,repo})).data.default_branch).toBe('main');
  expect((await client.git.getRef({owner,repo,ref:'heads/main'})).data.object.sha).toBe(f.snapshot.baseSha);
  const tree=(await client.git.getTree({owner,repo,tree_sha:f.snapshot.baseSha,recursive:'true'})).data.tree;
  expect(tree[0].path).toBe('ranking.ts');
  const file=(await client.repos.getContent({owner,repo,path:'ranking.ts',ref:f.snapshot.baseSha})).data;
  expect(file).toMatchObject({type:'file'});
  expect((await client.git.getBlob({owner,repo,file_sha:tree[0].sha!})).data.encoding).toBe('base64');
 });
 it('preserves usage from actual SSE and keeps absent usage unknown',()=>{
  const raw='data: '+JSON.stringify({type:'message_start',message:{id:'actual-id',usage:{input_tokens:100}}})+'\n'+'data: '+JSON.stringify({type:'content_block_delta',delta:{text:'actual candidate'}})+'\n'+'data: '+JSON.stringify({type:'message_delta',usage:{output_tokens:20}})+'\n'+'data: '+JSON.stringify({type:'message_stop'})+'\n';
  expect(streamUsage(raw.replace('data: {"type":"message_stop"}\n','')).actualUsd).toBeNull();
  expect(streamUsage(raw)).toMatchObject({responseId:'actual-id',text:'actual candidate',actualUsd:.0002});
  expect(streamUsage('data: {}\n').actualUsd).toBeNull();
  for(const input of [-1,1.5,'100'])expect(streamUsage(raw.replace('"input_tokens":100','"input_tokens":'+JSON.stringify(input))).actualUsd).toBeNull();
  expect(streamUsage(raw.replace('"input_tokens":100','"input_tokens":100,"cache_read_input_tokens":5'))).toMatchObject({actualUsd:null,usageReason:'cache_pricing_not_settled'});
 });
 it('enforces persistent12call/$1reservation caps and settlement integrity',()=>{
  const dir=mkdtempSync(join(tmpdir(),'fix-live-budget-'));dirs.push(dir);const file=join(dir,'ledger');
  reserveFix(file,'hash','case:1',.1);settleFix(file,'hash','case:1',.01);
  expect(()=>reserveFix(file,'hash','case:1',.1)).toThrow();
  expect(()=>settleFix(file,'hash','case:1',.01)).toThrow();
  expect(()=>reserveFix(file,'hash','case:2',1)).toThrow();
  expect(()=>reserveFix(file,'foreign','case:2',.01)).toThrow();
  for(let i=2;i<=12;i++)reserveFix(file,'hash','case:'+i,.01);
  expect(()=>reserveFix(file,'hash','case:13',.01)).toThrow();
  expect(fixBudget(file,'hash').calls.size).toBe(12);
 });
 it('never counts model-free or budget/time/unverifiable stops as correct',()=>{
  for(const reason of ['budget_exhausted','deadline_exceeded','unknown'])expect(scoreLiveFix('stop',{status:'stopped',reason,files_changed:[]},[],null,1,0).correct).toBe(false);
  expect(scoreLiveFix('stop',{status:'stopped',reason:'insufficient_evidence',files_changed:[]},[],null,0,0).correct).toBe(false);
  expect(scoreLiveFix('stop',{status:'stopped',reason:'insufficient_evidence',files_changed:[]},[],null,1,0).correctStop).toBe(true);
  expect(scoreLiveFix('fix',{status:'stopped',reason:'insufficient_evidence',files_changed:[]},[],null,1,0).correct).toBe(false);
 });
});

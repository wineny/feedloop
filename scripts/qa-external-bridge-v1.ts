/** One-shot manual bridge of observed real Preview evidence into GitHub Deployment records. */
import { readFileSync, writeFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Octokit } from '@octokit/rest';
import { createClient } from '@supabase/supabase-js';
import { checkDeployment, closeLoopForRun } from '../src/lib/auto-dev/loop-closed';
const root=resolve('evals/pipeline/20260913/external-v1');
const expectedManifest='7fba13042cacf2b021caaa4af496a748c16527f98aa075cd81134c1e11f2f79f';
const mergeSha='8bacc77c3ea0edbb86c70e448d3e966a076c745b';
const vercelId='dpl_AqeXxskMbToRoHxNRaC3RjBkw2rV';
const environment='feedloop-pipeline-qa';
const owner='wineny',repo='nullnul-tour',repoUrl='https://github.com/wineny/nullnul-tour';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const read=(p:string)=>JSON.parse(readFileSync(root+'/'+p,'utf8'));
function githubToken(){const lines=readFileSync(resolve('../app/.env.local'),'utf8').split(/\r?\n/).filter(l=>/^GITHUB_TOKEN=/.test(l));if(lines.length!==1)throw new Error('github_key_missing');const value=lines[0].slice('GITHUB_TOKEN='.length).trim().replace(/^(['"])(.*)\1$/,'$2');if(!value||/[\s`$\\]/.test(value))throw new Error('github_key_format');return value;}
async function main(){
 if(process.argv.length!==3||!['--dry-run','--execute'].includes(process.argv[2]))throw new Error('one_phase_required');
 const m=read('manifest.json');if(hash(readFileSync(root+'/manifest.json','utf8'))!==expectedManifest)throw new Error('manifest_mismatch');
 const observationName=readdirSync(root).filter(p=>/^deployment-observation-\d+\.json$/.test(p)).sort().at(-1);if(!observationName)throw new Error('observation_missing');
 const merge=read('merge.json'),prepare=read('deployment-prepare.json'),submit=read('deployment-submit.json'),observation=read(observationName),marker=read('marker-authenticated.json');
 const markerFile=prepare.files.find((f:{path:string})=>f.path===prepare.markerPath);
 for(const receipt of [merge,prepare,submit,observation,marker])if(receipt.manifestHash!==expectedManifest)throw new Error('receipt_manifest_mismatch');
 if(merge.state!=='completed'||merge.result.merge.sha!==mergeSha||merge.result.review.number!==3||prepare.mergeSha!==mergeSha||submit.mergeSha!==mergeSha||observation.mergeSha!==mergeSha||marker.mergeSha!==mergeSha)throw new Error('merge_identity_mismatch');
 for(const receipt of [submit,observation,marker])if(receipt.deploymentId!==vercelId||receipt.projectId!=='prj_T1N3YA81Mj4xlrPROyZ5ZkShrHUT'||receipt.target!=='preview'||receipt.checkoutHash!==prepare.checkoutHash)throw new Error('preview_identity_mismatch');
 if(prepare.state!=='completed'||prepare.project.projectId!==submit.projectId||prepare.project.target!=='preview'||submit.state!=='submitted'||observation.readyState!=='READY'||marker.httpStatus!==200||hash(marker.body)!==marker.sha256||marker.sha256!==prepare.markerHash||marker.sha256!==markerFile?.sha256||marker.sha256!=='f0d76cc603bad2a5764e4cf32b3d71418e5e7bf7bdbc4c2e7cc5b21157cda736')throw new Error('observed_marker_or_ready_mismatch');
 const previewUrl='https://'+submit.url;
 if(new URL(marker.url).origin!==previewUrl||new URL(marker.url).pathname!=='/'+prepare.markerPath.replace(/^public\//,''))throw new Error('marker_url_mismatch');
 const inputs=['manifest.json','merge.json','deployment-prepare.json','deployment-submit.json',observationName,'marker-authenticated.json'];
 const proof={manifestHash:expectedManifest,mergeSha,vercelId,previewUrl,environment,markerHash:marker.sha256,inputHashes:Object.fromEntries(inputs.map(p=>[p,hash(readFileSync(root+'/'+p,'utf8'))])),sourceHash:hash(readFileSync('scripts/qa-external-bridge-v1.ts','utf8')),productionSourceHashes:Object.fromEntries(['src/lib/auto-dev/loop-closed.ts','src/lib/email/notify.ts','src/lib/email/postmark.ts'].map(p=>[p,hash(readFileSync(p,'utf8'))])),scope:'Manual evidence bridge after real Preview upload/READY/authenticated marker200; not native Vercel Git integration, not an AI fix, not user-resolution confirmation',command:'npx tsx scripts/qa-external-bridge-v1.ts --execute'};
 if(process.argv[2]==='--dry-run'){console.log(JSON.stringify({...proof,externalWrites:0},null,2));return;}
 if(process.env.NODE_OPTIONS||Object.keys(process.env).some(k=>/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FEEDLOOP_QA_)/i.test(k)&&process.env[k]))throw new Error('custom_transport_forbidden');
 delete process.env.POSTMARK_SERVER_TOKEN;
 process.env.GITHUB_TOKEN=githubToken();process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT=environment;
 const local=JSON.parse(readFileSync('.omx/qa/env.json','utf8'));if(local.NEXT_PUBLIC_SUPABASE_URL!=='http://127.0.0.1:55441')throw new Error('production_database_forbidden');
 for(const k of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']){if(typeof local[k]!=='string'||!local[k])throw new Error('local_configuration_missing');process.env[k]=local[k];}
 const db=createClient(local.NEXT_PUBLIC_SUPABASE_URL,local.SUPABASE_SERVICE_ROLE_KEY);
 const gh=new Octokit({auth:process.env.GITHUB_TOKEN,request:{timeout:30000},log:{debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}}});
 const checkGit=async()=>{const [project,pr,main,base]=await Promise.all([gh.repos.get({owner,repo}),gh.pulls.get({owner,repo,pull_number:3}),gh.git.getRef({owner,repo,ref:'heads/main'}),gh.git.getRef({owner,repo,ref:'heads/'+m.baseBranch})]);if(project.data.default_branch!=='main'||main.data.object.sha!==m.defaultSha||base.data.object.sha!==mergeSha||!pr.data.merged||pr.data.merge_commit_sha!==mergeSha||pr.data.base.ref!==m.baseBranch||pr.data.base.repo.full_name!==m.repository||pr.data.head.ref!==m.headBranch||pr.data.head.repo?.full_name!==m.repository||pr.data.head.sha!==read('create-pr.json').result.headSha)throw new Error('live_git_identity_changed');return {mainSha:main.data.object.sha,baseSha:base.data.object.sha,pr:3,mergeSha:pr.data.merge_commit_sha};};
 const runState=async()=>{const r=await db.from('auto_dev_runs').select('id,bot_id,group_id,insight_id,pr_url,pr_number,merged_at,merge_commit_sha,validation_status,deployment_status,deployment_reason').eq('id',m.ids.run).single();if(r.error||r.data.bot_id!==m.ids.bot||r.data.group_id!==m.ids.group||r.data.pr_number!==3||r.data.pr_url!==repoUrl+'/pull/3'||r.data.merge_commit_sha!==mergeSha||r.data.validation_status!=='unknown')throw new Error('local_run_identity_mismatch');const b=await db.from('bots').select('user_id,github_repo_url').eq('id',m.ids.bot).single();if(b.error||b.data.user_id!==m.ids.user||b.data.github_repo_url!==repoUrl)throw new Error('local_bot_identity_mismatch');return r.data;};
 const responseState=async()=>{const r=await db.from('responses').select('id,bot_id,conversation_id,response_type,user_confirmation,email_message_id,email_sent_at').eq('auto_dev_run_id',m.ids.run);if(r.error||r.data.length!==1||r.data[0].bot_id!==m.ids.bot||r.data[0].conversation_id!==m.ids.conversation||r.data[0].response_type!=='loop_closed'||r.data[0].user_confirmation!==null)throw new Error('local_response_identity_mismatch');return r.data[0];};
 const lock=root+'/bridge-lock';const fd=openSync(lock,'wx');
 try {
  if(existsSync(root+'/bridge-intent.json')||existsSync(root+'/bridge-result.json'))throw new Error('bridge_reserved_no_blind_retry');
  const gitBefore=await checkGit(),before=await runState(),responseBefore=await responseState();
  const prior=(await gh.repos.listDeployments({owner,repo,sha:mergeSha,environment,per_page:100})).data;if(prior.length!==0)throw new Error('prior_bridge_exists');
  writeFileSync(root+'/bridge-intent.json',JSON.stringify({...proof,at:new Date().toISOString(),state:'reserved',gitBefore,before,responseBefore,priorDeployments:0},null,2)+'\n',{flag:'wx',flush:true});
  const deployment=(await gh.repos.createDeployment({owner,repo,ref:mergeSha,environment,auto_merge:false,required_contexts:[],transient_environment:true,production_environment:false,description:'Manual bridge: observed real Vercel Preview READY and exact marker200',payload:{manual_bridge:true,attribution:'Feedloop QA operator evidence bridge; not native Vercel Git integration',manifestHash:expectedManifest,vercelDeploymentId:vercelId,previewUrl,markerHash:marker.sha256,checkoutHash:prepare.checkoutHash}})).data;
  if(!('id' in deployment)||deployment.sha!==mergeSha||deployment.environment!==environment)throw new Error('created_deployment_identity_mismatch');
  writeFileSync(root+'/bridge-deployment.json',JSON.stringify({...proof,deployment},null,2)+'\n',{flag:'wx',flush:true});
  const status=(await gh.repos.createDeploymentStatus({owner,repo,deployment_id:deployment.id,state:'success',environment,environment_url:previewUrl,auto_inactive:false,description:'Observed real Preview READY; authenticated marker SHA256 matched exact merge checkout'})).data;
  writeFileSync(root+'/bridge-status.json',JSON.stringify({...proof,deploymentId:deployment.id,status},null,2)+'\n',{flag:'wx',flush:true});
  const actual=(await gh.repos.listDeployments({owner,repo,sha:mergeSha,environment,per_page:100})).data;
  const statuses=(await gh.repos.listDeploymentStatuses({owner,repo,deployment_id:deployment.id,per_page:100})).data;
  if(actual.length!==1||actual[0].id!==deployment.id||statuses.length!==1||statuses[0].state!=='success'||statuses[0].environment_url!==previewUrl)throw new Error('bridge_readback_mismatch');
  const checked=await checkDeployment(repoUrl,mergeSha);if(checked.status!=='success')throw new Error('production_deployment_check_not_success');
  const followed=await closeLoopForRun({...before,title:read('seed-local.json').result.title});
  const after=await runState(),responseAfter=await responseState(),gitAfter=await checkGit();
  if(followed.delivered!==0||followed.skipped!==1||followed.emailed!==0||after.deployment_status!=='success'||JSON.stringify(responseAfter)!==JSON.stringify(responseBefore))throw new Error('follow_up_state_or_no_email_invariant_failed');
  writeFileSync(root+'/bridge-result.json',JSON.stringify({...proof,state:'completed',at:new Date().toISOString(),deploymentId:deployment.id,statuses,checked,followed,before,after,responseBefore,responseAfter,gitAfter,validation:'unknown',userConfirmation:null,mailSent:0},null,2)+'\n',{flag:'wx',flush:true});
  console.log(JSON.stringify({state:'completed',deploymentId:deployment.id,checked,followed,validation:after.validation_status,userConfirmation:responseAfter.user_confirmation,mailSent:0},null,2));
 } finally {closeSync(fd);unlinkSync(lock);delete process.env.POSTMARK_SERVER_TOKEN;}
}
main().catch(()=>{console.error('Bridge stopped; inspect bridge intent and exact provider records before any recovery. No blind retry or credential logging.');process.exitCode=1;});

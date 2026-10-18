/** UUID-owned local PostgreSQL proof; never uses production databases. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { planInsightWrite } from '../src/lib/bot/db';
async function main() {
 const url=process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
 const endpoint=new URL(url);
 if(!['localhost','127.0.0.1'].includes(endpoint.hostname)||endpoint.pathname!='/feedloop_qa') throw Error('local QA database required');
 const sql=postgres(url,{max:6}); const uid=randomUUID(),bid=randomUUID(),other=randomUUID(); let checks=0;
 const pass=(name:string)=>{checks++;console.log(`PASS ${name}`);};
 try {
  await sql`insert into users(id,name) values(${uid},'source-context-QA')`;
  await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bid},${uid},'test','source QA'),(${other},${uid},'test','other QA')`;
  const conversation=async(bot=bid)=>(await sql`insert into conversations(bot_id,source,external_user_id) values(${bot},'web',${randomUUID()}) returning id`)[0].id as string;
  const cid=await conversation(),cid2=await conversation(),otherCid=await conversation(other);
  const message=async(c:string|null=cid,b=bid)=>(await sql`insert into messages(bot_id,conversation_id,source,author_name,body,detected_at) values(${b},${c},'web','QA','추가 증상',now()) returning id`)[0].id as string;
  const original=await message();
  const iid=(await sql`select pipeline_settle_insight(${bid}::uuid,${original}::uuid,'{"category":"ux","summary":"원래 요약","sentiment":"negative","follow_up_needed":true}'::jsonb) r`)[0].r.id;
  const before=(await sql`select category,summary,sentiment,follow_up_needed,updated_at from insights where id=${iid}`)[0];
  const attach=async(mid:string,target=iid,b=bid,lease:string|null=null)=>(await sql`select pipeline_settle_insight(${b}::uuid,${mid}::uuid,null::jsonb,${target}::uuid,${lease}::uuid) r`)[0].r;
  const supplement=await message(); await Promise.all([attach(supplement),attach(supplement)]);
  assert.deepEqual((await sql`select category,summary,sentiment,follow_up_needed,updated_at from insights where id=${iid}`)[0],before);
  assert.equal((await sql`select count(*)::int n from insight_message_sources where message_id=${supplement}`)[0].n,1);
  assert.equal((await sql`select cardinality(source_message_ids) n from insights where id=${iid}`)[0].n,1);
  pass('concurrent duplicate source-only receipt preserves all classification metadata');
  const courtesy=await message();
  const courtesyPlan=planInsightWrite({insight:null,extends:'ab12cd34',refMap:new Map([['ab12cd34',{id:iid}]]),text:'네 고마워요'});
  assert.equal(courtesyPlan.action,'skip');
  await sql`select pipeline_settle_insight(${bid}::uuid,${courtesy}::uuid,null::jsonb,null::uuid)`;
  assert.equal((await sql`select count(*)::int n from insight_message_sources where message_id=${courtesy}`)[0].n,0);
  assert.equal((await sql`select classification_state from messages where id=${courtesy}`)[0].classification_state,'done');
  assert.deepEqual((await sql`select category,summary,sentiment,follow_up_needed,updated_at from insights where id=${iid}`)[0],before);
  pass('courtesy skip completes without source membership or classification changes');

  for(const mid of [await message(cid2),await message(null),await message(otherCid,other)]) {
   await assert.rejects(attach(mid,iid,bid));
   assert.equal((await sql`select classification_state from messages where id=${mid}`)[0].classification_state,'pending');
  }
  await assert.rejects(attach(await message(otherCid,other),iid,other));
  pass('different/null conversation and cross-bot targets rejected without completion');
  const invalid=await message();await assert.rejects(attach(invalid,randomUUID()));
  assert.equal((await sql`select classification_state from messages where id=${invalid}`)[0].classification_state,'pending');
  pass('missing source target remains recoverable');
  const leased=await message(),lease=randomUUID();
  await sql`update messages set classification_state='processing',classification_lease=${lease} where id=${leased}`;
  await assert.rejects(attach(leased,iid,bid,randomUUID()));await attach(leased,iid,bid,lease);
  pass('source-only settlement enforces recovery lease');
  const group=(await sql`insert into insight_groups(bot_id,title,summary,category) values(${bid},'QA','QA','ux') returning id`)[0].id;
  await sql`update insights set group_id=${group} where id=${iid}`;
  const grouped=await message();await assert.rejects(attach(grouped));
  assert.equal((await sql`select classification_state from messages where id=${grouped}`)[0].classification_state,'pending');
  await sql`update insights set group_id=null where id=${iid}`;
  await sql`insert into auto_dev_runs(bot_id,insight_id,status) values(${bid},${iid},'failed')`;
  await assert.rejects(attach(await message()));
  pass('grouped and previously attempted evidence cannot gain hidden supplements');
  console.log(JSON.stringify({suite:'source-context-postgres',checks,passed:true}));
 } finally {await sql`delete from users where id=${uid}`;await sql.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

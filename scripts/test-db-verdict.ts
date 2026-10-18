import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
async function main() {
 const url=process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
 const target=new URL(url);if(!['127.0.0.1','localhost'].includes(target.hostname)||target.pathname!='/feedloop_qa')throw new Error('Local QA database required');
 const sql=postgres(url,{max:4});const user=randomUUID(),bot=randomUUID(),run=randomUUID();
 const items=[{text:'one',verdict:null},{text:'two',verdict:null}];const verdict={status:'fix_holds',text:'advisory'};
 try {
 await sql`insert into users(id,name) values(${user},'verdict QA')`;
 await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bot},${user},'test-only','verdict QA')`;
 await sql`insert into auto_dev_runs(id,bot_id,status,validation_status,explanation) values(${run},${bot},'completed','unverifiable',${sql.json({unverified:items})})`;
 const results=await Promise.all(items.map((item,index)=>sql`select save_run_verdict(${run},${index},${sql.json(item)},${sql.json(verdict)}) result`));
 assert.ok(results.every(r=>r[0].result));
 const stored=(await sql`select explanation,validation_status from auto_dev_runs where id=${run}`)[0];
 assert.ok(stored.explanation.unverified.every((i:{verdict:unknown})=>i.verdict));assert.equal(stored.validation_status,'unverifiable');
 assert.equal((await sql`select save_run_verdict(${run},0,${sql.json(items[0])},${sql.json(verdict)}) result`)[0].result,null);
 await sql`update auto_dev_runs set explanation=${sql.json({unverified:items})} where id=${run}`;
 const twins=await Promise.all([0,1].map(()=>sql`select save_run_verdict(${run},0,${sql.json(items[0])},${sql.json(verdict)}) result`));
 assert.equal(twins.filter(r=>r[0].result).length,1);
 assert.equal((await sql`select save_run_verdict(${run},1,${sql.json({text:'changed',verdict:null})},${sql.json(verdict)}) result`)[0].result,null);
 console.log('PASS 5: parallel distinct preservation, validation unchanged, duplicate rejected, concurrent same-item one winner, changed identity rejected');
 } finally { await sql`delete from users where id=${user}`;await sql.end(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

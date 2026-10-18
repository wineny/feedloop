/** Local PostgreSQL concurrency proof; deletes only its own UUID-scoped fixtures. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
async function main() {
  const url = process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
  const target = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/feedloop_qa') throw new Error('Local feedloop_qa database required');
  const sql = postgres(url, { max: 15, onnotice: () => {} });
  const operator = randomUUID(); const bot = randomUUID();
  try {
    await sql`insert into users(id,name) values(${operator},'handoff-isolated-qa')`;
    await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bot},${operator},'test-only','Handoff QA')`;
    const conversations = await Promise.all(Array.from({length:12}, async () => (await sql`insert into conversations(bot_id,source,external_user_id) values(${bot},'web',${randomUUID()}) returning id`)[0].id as string));
    const results = await Promise.all(conversations.map(async id => (await sql`select claim_handoff_email(${bot},${id}) result`)[0].result));
    assert.equal(results.filter(r => r.id).length,10);
    assert.equal(results.filter(r => r.reason === 'bot_rate_limited').length,2);
    const selected = conversations[results.findIndex(r => r.id)];
    const attempt = results.find(r => r.id).id;
    await sql`update conversations set owner_notified_at=now()-interval '2 hours' where id=${selected}`;
    assert.equal((await sql`select claim_handoff_email(${bot},${selected}) result`)[0].result.reason,'delivery_unknown');
    assert.equal((await sql`select owner_email_status from conversations where id=${selected}`)[0].owner_email_status,'delivery_unknown');
    await sql`update handoff_email_deliveries set status='sent',provider_message_id='test-only-accepted' where id=${attempt}`;
    assert.equal((await sql`select owner_email_status from conversations where id=${selected}`)[0].owner_email_status,'sent');
    assert.equal((await sql`select claim_handoff_email(${randomUUID()},${selected}) result`)[0].result.reason,'lookup_failed');
    const legacyBot = randomUUID();
    await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${legacyBot},${operator},'test-only','Legacy cap QA')`;
    await Promise.all(Array.from({length:10}, () => sql`insert into conversations(bot_id,source,external_user_id,owner_notified_at) values(${legacyBot},'web',${randomUUID()},now())`));
    const legacyTarget = (await sql`insert into conversations(bot_id,source,external_user_id) values(${legacyBot},'web',${randomUUID()}) returning id`)[0].id;
    assert.equal((await sql`select claim_handoff_email(${legacyBot},${legacyTarget}) result`)[0].result.reason,'bot_rate_limited');
    console.log(JSON.stringify({ checks:7, passed:7, proof:['concurrent 12 claims limited to 10','two rejected by bot cap','unknown blocks resend after an hour','unknown visible in inbox source','provider acceptance updates inbox status','cross-bot rejected','pre-migration sends count toward hourly cap'] },null,2));
  } finally { await sql`delete from users where id=${operator}`; await sql.end(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });

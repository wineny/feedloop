/** Local PostgreSQL proof; owns a UUID-scoped user and cascade fixtures only. Never accepts remote URLs. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

async function main() {
  const url = process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
  const target = new URL(url);
  if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/feedloop_qa') throw new Error('local disposable feedloop_qa database required');
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  const user = randomUUID(); const bot = randomUUID(); const other = randomUUID();
  const checks: string[] = [];
  const report = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    await sql`insert into users(id,name) values(${user},'pipeline-intake-local-qa')`;
    await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bot},${user},'test-only','QA A'),(${other},${user},'test-only','QA B')`;
    const msg = async (body = '쿠폰 버튼 무반응', botId = bot) => (await sql`insert into messages(bot_id,source,author_name,body,detected_at,classification_next_at) values(${botId},'web','QA',${body},now(),now()-interval '1 second') returning id`)[0].id as string;
    const settle = async (mid: string, extend: string | null = null) => (await sql`select pipeline_settle_insight(${bot}::uuid,${mid}::uuid,${sql.json({category:'bug',summary:'쿠폰 버튼 무반응',sentiment:'negative'})}::jsonb,${extend}::uuid) receipt`)[0].receipt;
    const failedWrite = await msg('saved message; failed classification persistence');
    await assert.rejects(sql`select pipeline_settle_insight(${bot}::uuid,${failedWrite}::uuid,'{"category":"bug"}'::jsonb)`);
    assert.equal((await sql`select classification_state from messages where id=${failedWrite}`)[0].classification_state,'pending');
    assert.equal((await sql`select count(*)::int n from insights where message_id=${failedWrite}`)[0].n,0);
    await sql`select pipeline_settle_insight(${bot}::uuid,${failedWrite}::uuid,null::jsonb)`;
    report('post-ack classification write failure leaves saved message pending for retry');
    const first = await msg(); const original = (await settle(first)).id;
    const supplement = await msg('모바일에서도 그래요');
    const race = await Promise.all([settle(supplement,original),settle(supplement)]);
    assert.equal(race[0].id,race[1].id);
    assert.equal((await sql`select count(*)::int n from insight_message_sources where message_id=${supplement}`)[0].n,1);
    report('realtime extension / recovery insert race has one source owner');
    await assert.rejects(sql`select pipeline_settle_insight(${other}::uuid,${first}::uuid,null::jsonb)`);
    report('cross-bot intake rejected');
    const second = await msg('별도 문제'); const secondInsight = (await settle(second)).id;
    const snap = (await sql`select pipeline_group_snapshot(${bot}::uuid) s`)[0].s;
    const proposal = (id: string) => [{title:'쿠폰 버튼',summary:'쿠폰 버튼 무반응',category:'bug',insight_ids:[id]}];
    const commits = await Promise.allSettled([
      sql`select pipeline_commit_groups(${bot}::uuid,${snap.revision}::bigint,${sql.json(proposal(original))}::jsonb) r`,
      sql`select pipeline_commit_groups(${bot}::uuid,${snap.revision}::bigint,${sql.json(proposal(secondInsight))}::jsonb) r`,
    ]);
    assert.equal(commits.filter((r) => r.status==='fulfilled').length,1);
    assert.equal((await sql`select count(*)::int n from insight_groups where bot_id=${bot}`)[0].n,1);
    report('same empty-group revision / distinct reports: only one commit; stale retry required');
    const group = (await sql`select id from insight_groups where bot_id=${bot}`)[0].id;
    const pending = (await sql`select id from insights where bot_id=${bot} and group_id is null`)[0].id;
    await sql`update insight_groups set status='merged' where id=${group}`;
    const fresh = (await sql`select pipeline_group_snapshot(${bot}::uuid) s`)[0].s;
    assert.equal(fresh.existing[0].status,'merged');
    const reused = [{...proposal(pending)[0],existing_group_id:group}];
    const attach = (await sql`select pipeline_commit_groups(${bot}::uuid,${fresh.revision}::bigint,${sql.json(reused)}::jsonb) r`)[0].r;
    assert.equal(attach.grouped,1);
    assert.equal((await sql`select follow_up_pending,status from insight_groups where id=${group}`)[0].follow_up_pending,true);
    assert.equal((await sql`select count(*)::int n from insight_groups where bot_id=${bot}`)[0].n,1);
    report('merged symptom attaches existing group and marks follow-up; no new group');
    const third = (await settle(await msg())).id;
    const rollbackSnap = (await sql`select pipeline_group_snapshot(${bot}::uuid) s`)[0].s;
    await assert.rejects(sql`select pipeline_commit_groups(${bot}::uuid,${rollbackSnap.revision}::bigint,${sql.json([...proposal(third),...proposal(randomUUID())])}::jsonb)`);
    assert.equal((await sql`select group_id from insights where id=${third}`)[0].group_id,null);
    assert.equal((await sql`select count(*)::int n from insight_groups where bot_id=${bot}`)[0].n,1);
    report('partial invalid commit rolls back group and links without orphan');
    // Preserve omitted reports and make their presence explicit in pending count.
    assert.equal(rollbackSnap.pending,1);
    report('omitted proposal remains ungrouped and retryable');
    const oldest = await msg('old stranded message');
    await sql`update messages set detected_at=now()-interval '10 days' where id=${oldest}`;
    await sql`insert into messages(bot_id,source,author_name,body,detected_at,classification_next_at) select ${bot},'web','QA','newer',now(),now()-interval '1 second' from generate_series(1,305)`;
    const claimed = (await sql`select * from pipeline_claim_message(array[${bot}::uuid])`)[0];
    assert.equal(claimed.id,oldest);
    await assert.rejects(sql`select pipeline_settle_insight(${bot}::uuid,${oldest}::uuid,null::jsonb,null::uuid,${randomUUID()}::uuid)`);
    await sql`select pipeline_settle_insight(${bot}::uuid,${oldest}::uuid,null::jsonb,null::uuid,${claimed.classification_lease}::uuid)`;
    assert.equal((await sql`select classification_state from messages where id=${oldest}`)[0].classification_state,'done');
    report('oldest pending survives >300 newer messages; no-insight done; stale lease rejected');
    const retry = (await sql`select * from pipeline_claim_message(array[${bot}::uuid])`)[0];
    await sql`select pipeline_fail_message(${bot}::uuid,${retry.id}::uuid,${retry.classification_lease}::uuid,'model_failed')`;
    assert.equal((await sql`select classification_state,classification_next_at>now() deferred from messages where id=${retry.id}`)[0].deferred,true);
    await sql`update messages set classification_attempts=3,classification_next_at=now()-interval '1 second' where id=${retry.id}`;
    await sql`select * from pipeline_claim_message(array[${bot}::uuid])`;
    assert.equal((await sql`select classification_state from messages where id=${retry.id}`)[0].classification_state,'exhausted');
    report('retry backoff and bounded exhaustion persisted');
    await sql`update messages set classification_state='done' where bot_id=${bot}`;
    const conversation = (await sql`insert into conversations(bot_id,source,external_user_id) values(${bot},'web',${randomUUID()}) returning id`)[0].id;
    const one = await msg(); const two = await msg();
    await sql`update messages set conversation_id=${conversation} where id in (${one},${two})`;
    const concurrentClaims = await Promise.all([sql`select * from pipeline_claim_message(array[${bot}::uuid])`,sql`select * from pipeline_claim_message(array[${bot}::uuid])`]);
    assert.equal(concurrentClaims.reduce((n,r)=>n+r.length,0),1);
    report('concurrent recovery claims serialize conversation turns');
    console.log(JSON.stringify({suite:'pipeline-intake-postgres',checks:checks.length,passed:true}));
  } finally {
    await sql`delete from users where id=${user}`;
    await sql.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode=1; });

/** Real local PostgreSQL proof. Owns only UUID-scoped test records. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
async function main() {
  const url = process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
  const target = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/feedloop_qa') throw new Error('Local feedloop_qa database required');
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  const operator = randomUUID();
  const bot = randomUUID();
  try {
    await sql.unsafe(readFileSync('supabase/migrations/20260913_12_pipeline_recovery.sql', 'utf8'));
    await sql`insert into users(id,name) values(${operator},'recovery-isolated-qa')`;
    await sql`insert into bots(id,user_id,bot_token_encrypted,service_name) values(${bot},${operator},'test-only','Recovery QA')`;
    const message = (await sql`insert into messages(bot_id,source,author_name,body,detected_at,classification_state,classification_attempts,classification_error) values(${bot},'web','QA','retry fixture',now(),'exhausted',3,'model_failed') returning id`)[0].id;
    assert.equal((await sql`select retry_exhausted_classification(${message},${randomUUID()}) result`)[0].result, false);
    const attempts = await Promise.all([sql`select retry_exhausted_classification(${message},${operator}) result`, sql`select retry_exhausted_classification(${message},${operator}) result`]);
    assert.equal(attempts.filter(rows => rows[0].result).length, 1);
    const state = (await sql`select classification_state,classification_attempts from messages where id=${message}`)[0];
    assert.equal(state.classification_state, 'pending');
    assert.equal(state.classification_attempts, 0);
    const cycles = await sql`select previous_attempts,previous_error from classification_recovery_cycles where message_id=${message}`;
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].previous_attempts, 3);
    assert.equal(cycles[0].previous_error, 'model_failed');
    assert.equal((await sql`select retry_exhausted_classification(${message},${operator}) result`)[0].result, false);
    console.log(JSON.stringify({ checks: 5, passed: 5, proof: ['cross-owner rejected', 'concurrent retry creates one cycle', 'attempts reset only exhausted', 'previous failure retained', 'active cycle cannot reset'] }, null, 2));
  } finally { await sql`delete from users where id=${operator}`; await sql.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

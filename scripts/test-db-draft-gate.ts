/** Real local PostgreSQL proof; never connects to a remote database. */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function main() {
  const url = process.env.PIPELINE_TEST_DATABASE_URL ?? 'postgres://postgres:feedloop-local-qa-only@127.0.0.1:55439/feedloop_qa';
  const target = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/feedloop_qa') {
    throw new Error('Local feedloop_qa database required');
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  // Separate pools prove independent connection contention, not mocked promises.
  const peers = Array.from({ length: 4 }, () => postgres(url, { max: 1, onnotice: () => {} }));
  const key = `draft-gate-qa:${randomUUID()}`;
  const owners = peers.map(() => randomUUID());
  const proof: string[] = [];
  let applied = false;
  try {
    await sql.unsafe(readFileSync('supabase/migrations/20261009_02_draft_pr_gate_lock.sql', 'utf8'));
    applied = true;
    const pids = await Promise.all(peers.map(peer => peer`select pg_backend_pid() pid`));
    assert.equal(new Set(pids.map(rows => rows[0].pid)).size, peers.length);
    await Promise.all(peers.map(peer => peer`set role service_role`));
    const claimed = await Promise.all(peers.map((peer, i) => peer`select claim_draft_pr_gate(${key},${owners[i]}) ok`));
    assert.equal(claimed.filter(rows => rows[0].ok).length, 1);
    const winner = owners[claimed.findIndex(rows => rows[0].ok)];
    const other = randomUUID();
    proof.push('four independent service_role connections: one claim winner');
    assert.equal((await sql`select owns_draft_pr_gate(${key},${winner}) ok`)[0].ok, true);
    assert.equal((await sql`select owns_draft_pr_gate(${key},${other}) ok`)[0].ok, false);
    assert.equal((await sql`select claim_draft_pr_gate(${key},${winner}) ok`)[0].ok, false);
    proof.push('only winning owner owns; active lease cannot be reclaimed');
    assert.equal((await sql`select release_draft_pr_gate(${key},${other}) ok`)[0].ok, false);
    assert.equal((await sql`select owns_draft_pr_gate(${key},${winner}) ok`)[0].ok, true);
    proof.push('foreign owner cannot release lease');
    await sql`update draft_pr_gate_locks set expires_at=clock_timestamp()+interval '29 seconds' where key=${key}`;
    assert.equal((await sql`select owns_draft_pr_gate(${key},${winner}) ok`)[0].ok, false);
    assert.equal((await sql`select claim_draft_pr_gate(${key},${other}) ok`)[0].ok, false);
    proof.push('ownership requires 30 seconds remaining; near-expiry lease still blocks claim');
    await sql`update draft_pr_gate_locks set expires_at=clock_timestamp()-interval '1 second' where key=${key}`;
    assert.equal((await sql`select claim_draft_pr_gate(${key},${other}) ok`)[0].ok, true);
    assert.equal((await sql`select owns_draft_pr_gate(${key},${other}) ok`)[0].ok, true);
    assert.equal((await sql`select release_draft_pr_gate(${key},${winner}) ok`)[0].ok, false);
    proof.push('expired lease recovers; stale owner cannot delete successor');
    assert.equal((await sql`select release_draft_pr_gate(${key},${other}) ok`)[0].ok, true);
    assert.equal((await sql`select owns_draft_pr_gate(${key},${other}) ok`)[0].ok, false);
    assert.equal((await sql`select release_draft_pr_gate(${key},${other}) ok`)[0].ok, false);
    proof.push('owner release removes lease exactly once');
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['claim_draft_pr_gate(text,uuid,integer)', 'owns_draft_pr_gate(text,uuid)', 'release_draft_pr_gate(text,uuid)']) {
        assert.equal((await sql`select has_function_privilege(${role},${signature},'EXECUTE') ok`)[0].ok, false);
      }
      assert.equal((await sql`select has_table_privilege(${role},'draft_pr_gate_locks','SELECT,INSERT,UPDATE,DELETE') ok`)[0].ok, false);
    }
    assert.equal((await sql`select relrowsecurity from pg_class where oid='public.draft_pr_gate_locks'::regclass`)[0].relrowsecurity, true);
    proof.push('RLS enabled and anon/authenticated lack table/RPC privileges');
    console.log(JSON.stringify({ checks: proof.length, passed: proof.length, proof }, null, 2));
  } finally {
    if (applied) await sql`delete from draft_pr_gate_locks where key=${key}`;
    await Promise.all([sql.end(), ...peers.map(peer => peer.end())]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('local DB proof references the renamed gate migration without colliding with priority JEV', () => {
  const script = readFileSync('scripts/test-db-draft-gate.ts', 'utf8');
  const path = script.match(/readFileSync\('([^']+)'/)?.[1];
  expect(path).toBe('supabase/migrations/20261009_02_draft_pr_gate_lock.sql');
  expect(existsSync(path!)).toBe(true);
  expect(readFileSync(path!, 'utf8')).toContain('claim_draft_pr_gate');
  const migrations = readdirSync('supabase/migrations').filter(name => name.startsWith('20261009_'));
  expect(migrations).toContain('20261009_01_priority_jev.sql');
  expect(migrations).not.toContain('20261009_01_draft_pr_gate_lock.sql');
  const versions = migrations.map(name => name.match(/^\d{8}_\d+/)![0]);
  expect(new Set(versions).size).toBe(versions.length);
});

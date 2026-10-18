// supabase/schema.sql is generated from supabase/migrations by scripts/build-schema.sh.
// Judges and self-hosters apply the generated file, so a migration that lands without a rebuild
// silently ships a stale schema. This test fails the moment the two drift apart.
//
// Mirrors the script's ordering rule exactly: the three undated files first, in the order
// production applied them, then every dated file in byte order.

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');

function expectedOrder(): string[] {
  const dated = readdirSync(MIG)
    .filter((f) => /^\d{8}_/.test(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ['init_schema.sql', 'add_auto_dev.sql', 'add_kakao_support.sql', ...dated];
}

describe('supabase/schema.sql', () => {
  const schema = readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

  it('lists every migration file, in apply order', () => {
    const order = expectedOrder();
    // Every migration must be present…
    for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql'))) {
      expect(order, `${f} is not covered by the ordering rule — update scripts/build-schema.sh`).toContain(f);
    }
    // …and the banner must match the generator's idea of the order.
    const banner = schema
      .split('\n')
      .map((l) => /^--\s{3}(\S+\.sql)$/.exec(l)?.[1])
      .filter((f): f is string => Boolean(f));
    expect(banner).toEqual(order);
  });

  it('contains each migration body verbatim', () => {
    for (const f of expectedOrder()) {
      const body = readFileSync(path.join(MIG, f), 'utf8').trimEnd();
      expect(schema.includes(body), `${f} body differs from schema.sql — re-run scripts/build-schema.sh`).toBe(true);
    }
  });

  it('puts the undated base files before any dated migration', () => {
    const idx = (f: string) => schema.indexOf(`═ ${f} ═`);
    expect(idx('init_schema.sql')).toBeGreaterThan(-1);
    expect(idx('init_schema.sql')).toBeLessThan(idx('add_auto_dev.sql'));
    expect(idx('add_kakao_support.sql')).toBeLessThan(idx('20260905_01_enable_rls_users.sql'));
  });
});

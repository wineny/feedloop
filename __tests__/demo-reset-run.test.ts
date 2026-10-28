// runReset(데모 봇 비우기 실행부)를 가짜 Supabase 클라이언트로 돌려 호출을 기록·검사한다.
// 진짜 DB 는 프로덕션 데모 DB 라 --yes 를 돌려 볼 수 없다 — 지우는 경로는 여기서만 검증된다.

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runReset, type ResetOptions } from '@/lib/demo/reset';
import { DEMO_RESET_DELETE } from '@/lib/demo/reset-plan';

const DEMO = 'demo-bot-id';
const OTHER = 'customer-bot-id';

type Call = { table: string; op: 'select' | 'delete'; cols?: unknown; filters: unknown[][] };
type Result = { data?: unknown; count?: number | null; error?: { message: string } | null };

/** 체이닝되는 가짜 쿼리 빌더. 모든 호출을 `events` 에 순서대로 남긴다. */
function fakeDb(opts: { inFlight?: () => { runs: number; payments: number }; prUrls?: string[] } = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const inFlight = opts.inFlight ?? (() => ({ runs: 0, payments: 0 }));

  const respond = (c: Call): Result => {
    const has = (op: string) => c.filters.some((f) => f[0] === op);
    if (c.table === 'bots') {
      const byId = c.filters.find((f) => f[0] === 'eq' && f[1] === 'id');
      if (!byId) return { data: { id: DEMO, service_name: 'Feedloop', is_demo: true } };
      if (byId[2] === DEMO) return { data: { id: DEMO, service_name: 'Feedloop', is_demo: true } };
      if (byId[2] === OTHER) return { data: { id: OTHER, service_name: 'Customer', is_demo: false } };
      return { data: null };
    }
    if (c.op === 'delete') return { count: 2 };
    if (c.table === 'auto_dev_runs' && has('or')) return { count: inFlight().runs };
    if (c.table === 'payment_actions' && has('in')) return { count: inFlight().payments };
    if (c.table === 'auto_dev_runs' && has('not')) return { data: (opts.prUrls ?? []).map((pr_url) => ({ pr_url })) };
    return { count: 3 };
  };

  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] };
    calls.push(call);
    const builder = {
      select: (cols: unknown) => ((call.cols = cols), builder),
      delete: () => {
        call.op = 'delete';
        events.push(`delete:${table}`);
        return builder;
      },
      eq: (...a: unknown[]) => (call.filters.push(['eq', ...a]), builder),
      in: (...a: unknown[]) => (call.filters.push(['in', ...a]), builder),
      or: (...a: unknown[]) => (call.filters.push(['or', ...a]), builder),
      not: (...a: unknown[]) => (call.filters.push(['not', ...a]), builder),
      maybeSingle: () => Promise.resolve({ error: null, ...respond(call) }),
      then: (ok: (r: Result) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null, ...respond(call) }).then(ok, fail),
    };
    return builder;
  };

  return { db: { from } as unknown as SupabaseClient, calls, events };
}

function options(events: string[], over: Partial<ResetOptions> = {}): ResetOptions {
  return {
    confirmed: false,
    removeShots: vi.fn(async () => (events.push('removeShots'), true)),
    sweepShots: vi.fn(async () => void events.push('sweepShots')),
    log: () => undefined,
    ...over,
  };
}

const deletes = (calls: Call[]) => calls.filter((c) => c.op === 'delete');

describe('runReset', () => {
  it('dry run: no delete, no storage removal, no sweep', async () => {
    const { db, calls, events } = fakeDb();
    const opts = options(events);
    await runReset(db, opts);
    expect(deletes(calls)).toEqual([]);
    expect(opts.removeShots).not.toHaveBeenCalled();
    expect(opts.sweepShots).not.toHaveBeenCalled();
  });

  it('dry run lists the PR urls of auto-dev runs', async () => {
    const { db, events } = fakeDb({ prUrls: ['https://github.com/o/r/pull/7'] });
    const lines: string[] = [];
    await runReset(db, options(events, { log: (l) => lines.push(l) }));
    expect(lines).toContain('  https://github.com/o/r/pull/7');
  });

  it('--yes: removes shots, deletes every planned table scoped to the demo bot in order, then sweeps', async () => {
    const { db, calls, events } = fakeDb();
    await runReset(db, options(events, { confirmed: true }));

    const del = deletes(calls);
    expect(del.map((c) => c.table)).toEqual(DEMO_RESET_DELETE.map((s) => s.table));
    for (const c of del) {
      expect(c.filters, c.table).toEqual([['eq', 'bot_id', DEMO]]);
    }
    expect(events[0]).toBe('removeShots');
    expect(events.at(-1)).toBe('sweepShots');
  });

  it('refuses a --bot that is not the demo bot, before touching anything', async () => {
    const { db, calls, events } = fakeDb();
    const opts = options(events, { confirmed: true, botArg: OTHER });
    await expect(runReset(db, opts)).rejects.toThrow(/not the demo bot/);
    expect(deletes(calls)).toEqual([]);
    expect(opts.removeShots).not.toHaveBeenCalled();
  });

  it('refuses an unknown --bot', async () => {
    const { db, calls, events } = fakeDb();
    await expect(runReset(db, options(events, { confirmed: true, botArg: 'nope' }))).rejects.toThrow(/not found/);
    expect(deletes(calls)).toEqual([]);
  });

  it('in-flight work + --yes throws before any deletion or storage removal', async () => {
    for (const f of [{ runs: 1, payments: 0 }, { runs: 0, payments: 1 }]) {
      const { db, calls, events } = fakeDb({ inFlight: () => f });
      const opts = options(events, { confirmed: true });
      await expect(runReset(db, opts)).rejects.toThrow(/refused/);
      expect(deletes(calls)).toEqual([]);
      expect(opts.removeShots).not.toHaveBeenCalled();
    }
  });

  it('in-flight work that starts during storage removal still blocks the deletes', async () => {
    let checks = 0;
    // 한 번의 확인 = runs 질의 + payments 질의. 두 번째 확인부터 진행 중인 환불이 보인다.
    const { db, calls, events } = fakeDb({ inFlight: () => ({ runs: 0, payments: checks++ >= 2 ? 1 : 0 }) });
    const opts = options(events, { confirmed: true });
    await expect(runReset(db, opts)).rejects.toThrow(/refused/);
    expect(opts.removeShots).toHaveBeenCalled();
    expect(deletes(calls)).toEqual([]);
    expect(opts.sweepShots).not.toHaveBeenCalled();
  });

  it('dry run with in-flight work only warns', async () => {
    const { db, calls, events } = fakeDb({ inFlight: () => ({ runs: 1, payments: 1 }) });
    const lines: string[] = [];
    await runReset(db, options(events, { log: (l) => lines.push(l) }));
    expect(lines.some((l) => l.startsWith('In flight:'))).toBe(true);
    expect(deletes(calls)).toEqual([]);
  });
});

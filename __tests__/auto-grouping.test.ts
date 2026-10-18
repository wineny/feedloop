import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 자동 묶기 (I-10) — «언제 묶고, 언제 안 묶나»를 DB 함수 호출 순서로 고정한다.
//
// 가짜 Supabase 는 RPC 이름과 인자를 그대로 기록하고 응답은 테스트가 정한다.
// from() 체인은 **필터를 실제로 적용한다** — 이 레포에서 「흉내만 낸 필터」가 죽은 기능을
// 초록으로 덮은 사고가 네 번이라, `.lte`·`.in`·`.is`·`.or` 를 기록해 행에 건다.
// `runGrouping` 은 통째로 모킹한다 — 관심사는 «묶기를 부르는 조건»이지 묶기 자체가 아니다.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: {} as Record<string, { data: unknown; error: { message: string } | null } | ((args: Record<string, unknown>) => { data: unknown; error: { message: string } | null })>,
  runGrouping: vi.fn(),
  /** 테이블별 행. 필터는 실제로 적용된다. */
  tables: {} as Record<string, Row[]>,
  fromError: null as { message: string } | null,
}));

function applyFilters(rows: Row[], filters: [string, string, unknown][]): Row[] {
  return rows.filter((r) =>
    filters.every(([op, col, val]) => {
      const v = r[col];
      if (op === 'eq') return v === val;
      if (op === 'is') return val === null ? v == null : v === val;
      if (op === 'in') return (val as unknown[]).includes(v);
      if (op === 'lte') return typeof v === 'string' && v <= (val as string);
      if (op === 'or') {
        // "a.lte.X,b.lte.Y" — 한 갈래라도 참이면 통과. 절은 콤마로 갈린다(값에 콤마가 없다는 전제).
        return (val as string).split(',').some((clause) => {
          const [c, o, ...rest] = clause.split('.');
          const x = rest.join('.');
          const cv = r[c];
          if (o === 'lte') return typeof cv === 'string' && cv <= x;
          if (o === 'is') return x === 'null' ? cv == null : false;
          return false;
        });
      }
      return true;
    }),
  );
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc(fn: string, args: Record<string, unknown>) {
      h.rpc.push({ fn, args });
      const r = h.rpcResult[fn];
      return Promise.resolve(typeof r === 'function' ? r(args) : (r ?? { data: null, error: null }));
    },
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      let head = false;
      let single = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      chain.select = (_cols: string, opts?: { head?: boolean }) => { head = opts?.head === true; return chain; };
      for (const m of ['in', 'is', 'lte', 'eq']) chain[m] = (col: string, val: unknown) => { filters.push([m, col, val]); return chain; };
      chain.or = (expr: string) => { filters.push(['or', '', expr]); return chain; };
      chain.maybeSingle = () => { single = true; return chain; };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chain.then = (resolve: any, reject: any) => {
        if (h.fromError) return Promise.resolve({ data: null, count: null, error: h.fromError }).then(resolve, reject);
        const rows = applyFilters(h.tables[table] ?? [], filters);
        const value = head
          ? { data: null, count: rows.length, error: null }
          : single
            ? { data: rows[0] ?? null, error: null }
            : { data: rows, error: null };
        return Promise.resolve(value).then(resolve, reject);
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/groups/grouping', () => ({ runGrouping: h.runGrouping }));

type Mod = typeof import('@/lib/groups/auto-grouping');
let mod: Mod;

const BOT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noWait = async () => {};
const calls = (fn: string) => h.rpc.filter((c) => c.fn === fn);
const okResult = { grouped: 2, groups: [], pending: 0, deferred: 0, failures: [], dismissed: 0 };

beforeEach(async () => {
  vi.resetModules();
  h.rpc.length = 0;
  h.rpcResult = {
    auto_grouping_request: { data: { due: '2026-09-16T00:01:30Z', waiter: true, waiter_until: '2026-09-16T00:05:00Z' }, error: null },
    auto_grouping_claim: { data: TOKEN, error: null },
    auto_grouping_release: { data: true, error: null },
    auto_grouping_waiter_release: { data: true, error: null },
  };
  h.runGrouping.mockReset();
  h.runGrouping.mockResolvedValue(okResult);
  h.tables = {};
  h.fromError = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mod = await import('@/lib/groups/auto-grouping');
});

describe('scheduleAutoGrouping — settle 뒤 조용해지면 «대기자 하나만» 묶는다', () => {
  it('요청 → 대기 → 클레임 → 묶기 → 해제 → 대기자 반납 순서로 한 번 돈다', async () => {
    const out = await mod.scheduleAutoGrouping(BOT, { quietMs: 90_000, wait: noWait });

    expect(out).toMatchObject({ ran: true, ok: true });
    expect(h.rpc.map((c) => c.fn)).toEqual([
      'auto_grouping_request', 'auto_grouping_claim', 'auto_grouping_release', 'auto_grouping_waiter_release',
    ]);
    // quiet·상한·슬롯 수명은 초 단위로 DB 에 간다 — DB 시계가 due 를 정한다.
    expect(calls('auto_grouping_request')[0].args).toEqual({ p_bot_id: BOT, p_quiet_seconds: 90, p_max_wait_seconds: 600, p_waiter_seconds: 300 });
    expect(calls('auto_grouping_claim')[0].args).toMatchObject({ p_bot_id: BOT, p_require_due: true });
    // 해제는 «자기 토큰»으로, 성공이면 ok:true (펜싱 — 보안 리뷰 M2)
    expect(calls('auto_grouping_release')[0].args).toMatchObject({ p_bot_id: BOT, p_token: TOKEN, p_ok: true });
    // 대기자 반납은 자기 슬롯 값으로
    expect(calls('auto_grouping_waiter_release')[0].args).toEqual({ p_bot_id: BOT, p_waiter_until: '2026-09-16T00:05:00Z' });
    expect(h.runGrouping).toHaveBeenCalledTimes(1);
    expect(h.runGrouping.mock.calls[0][0]).toEqual([BOT]);
  });

  it('대기자가 아니면 RPC 한 번으로 끝난다 — 요청마다 90초를 자지 않는다(보안 리뷰 H2)', async () => {
    h.rpcResult.auto_grouping_request = { data: { due: 'x', waiter: false, waiter_until: 'y' }, error: null };
    const wait = vi.fn(async () => {});

    const out = await mod.scheduleAutoGrouping(BOT, { wait });

    expect(out).toEqual({ ran: false, reason: 'not_waiter' });
    expect(wait).not.toHaveBeenCalled();
    expect(h.rpc.map((c) => c.fn)).toEqual(['auto_grouping_request']);
    expect(h.runGrouping).not.toHaveBeenCalled();
  });

  it('뒤이은 제보가 due 를 밀면 그 시각까지 더 자고 다시 시도한다', async () => {
    let t = 0;
    const now = () => t;
    const wait = vi.fn(async (ms: number) => { t += ms; });
    // 첫 클레임은 실패(due 가 밀렸다), 두 번째는 성공
    let claims = 0;
    h.rpcResult.auto_grouping_claim = () => ({ data: ++claims === 1 ? null : TOKEN, error: null });
    // 두 번째 제보가 due 를 30초 뒤로 밀어 둔 상태
    h.tables.grouping_revisions = [{ bot_id: BOT, auto_group_due_at: new Date(120_000).toISOString(), auto_group_lock_until: null }];

    const out = await mod.scheduleAutoGrouping(BOT, { quietMs: 90_000, wait, now });

    expect(out).toMatchObject({ ran: true });
    expect(wait.mock.calls.map((c) => c[0])).toEqual([90_000, 30_000]);
    expect(calls('auto_grouping_claim')).toHaveLength(2);
    expect(h.runGrouping).toHaveBeenCalledTimes(1);
  });

  it('상한(MAX_WAIT)을 넘기면 due 와 무관하게 한 번 묶는다 — 제보가 끝없이 이어져도 언젠가는 묶인다', async () => {
    let t = 0;
    const now = () => t;
    const wait = vi.fn(async (ms: number) => { t += ms; });
    // due 는 계속 미래로 밀려 있고, require_due 클레임은 늘 실패
    h.rpcResult.auto_grouping_claim = (args) => ({ data: args.p_require_due ? null : TOKEN, error: null });
    h.tables.grouping_revisions = [{ bot_id: BOT, auto_group_due_at: new Date(9_999_999).toISOString(), auto_group_lock_until: null }];

    const out = await mod.scheduleAutoGrouping(BOT, { quietMs: 90_000, maxWaitMs: 180_000, wait, now });

    expect(out).toMatchObject({ ran: true });
    const last = calls('auto_grouping_claim').at(-1)!;
    expect(last.args).toMatchObject({ p_require_due: false });
    expect(t).toBe(180_000);
  });

  it('마감(deadlineMs)이 짧으면 대기 상한이 그만큼 줄어 «대기 + 묶기 예산»이 마감 안에 든다', async () => {
    let t = 0;
    const now = () => t;
    const wait = vi.fn(async (ms: number) => { t += ms; });
    h.rpcResult.auto_grouping_claim = (args) => ({ data: args.p_require_due ? null : TOKEN, error: null });
    h.tables.grouping_revisions = [{ bot_id: BOT, auto_group_due_at: new Date(9_999_999).toISOString(), auto_group_lock_until: null }];

    // 마감 150초 → 대기는 150 - 100(묶기 예산) = 50초까지만
    const out = await mod.scheduleAutoGrouping(BOT, { quietMs: 90_000, deadlineMs: 150_000, wait, now });

    expect(out).toMatchObject({ ran: true });
    expect(t).toBeLessThanOrEqual(90_000); // 첫 낮잠(quiet) 뒤 곧장 상한 → 강제 묶기
    expect(calls('auto_grouping_claim').at(-1)!.args).toMatchObject({ p_require_due: false });
  });

  it('due 가 비었으면(누가 이미 묶었다) 물러난다', async () => {
    h.rpcResult.auto_grouping_claim = { data: null, error: null };
    h.tables.grouping_revisions = [{ bot_id: BOT, auto_group_due_at: null, auto_group_lock_until: null }];

    const out = await mod.scheduleAutoGrouping(BOT, { wait: noWait });

    expect(out).toEqual({ ran: false, reason: 'not_due_or_locked' });
    expect(h.runGrouping).not.toHaveBeenCalled();
    // 클레임 못 한 채 나가므로 슬롯을 반납한다
    expect(calls('auto_grouping_waiter_release')).toHaveLength(1);
  });

  it('요청 RPC 가 실패하면(마이그레이션 누락 등) 클레임까지 가지 않는다', async () => {
    h.rpcResult.auto_grouping_request = { data: null, error: { message: 'function auto_grouping_request does not exist' } };
    const out = await mod.scheduleAutoGrouping(BOT, { wait: noWait });
    expect(out).toEqual({ ran: false, reason: 'request_failed' });
    expect(calls('auto_grouping_claim')).toHaveLength(0);
  });

  it('대기 시간·상한·잠금·예산 상수의 관계', () => {
    expect(mod.AUTO_GROUPING_QUIET_MS).toBe(90_000);
    // 대기 상한 + 묶기 예산 < 라우트 maxDuration(300초)
    expect(mod.AUTO_GROUPING_MAX_WAIT_MS + mod.AUTO_GROUPING_BUDGET_MS).toBeLessThan(300_000);
    // 잠금은 묶기 예산보다 길어야 정상 실행 중에 남이 다시 잡지 않는다.
    expect(mod.AUTO_GROUPING_LOCK_MS).toBeGreaterThan(mod.AUTO_GROUPING_BUDGET_MS);
    // 대기자 슬롯 수명 = maxDuration. 그 뒤 남은 슬롯은 죽은 대기자다.
    expect(mod.AUTO_GROUPING_WAITER_MS).toBe(300_000);
  });
});

describe('runAutoGrouping — 클레임·해제', () => {
  it('묶기가 실패(failures)하면 해제에 ok:false 를 보낸다 — 해제가 due 를 재무장한다', async () => {
    h.runGrouping.mockResolvedValue({ ...okResult, failures: [{ botId: BOT, reason: 'invalid_or_omitted_proposals' }] });
    const out = await mod.runAutoGrouping(BOT, { requireDue: false });
    expect(out).toMatchObject({ ran: true, ok: false });
    expect(calls('auto_grouping_release')[0].args).toMatchObject({ p_token: TOKEN, p_ok: false, p_retry_seconds: 600 });
  });

  it('묶기가 던져도 자기 토큰으로 잠금을 푼다(ok:false) — 안 풀면 150초 동안 그 봇은 아무도 못 묶는다', async () => {
    h.runGrouping.mockRejectedValue(new Error('boom'));
    await expect(mod.runAutoGrouping(BOT)).rejects.toThrow('boom');
    expect(calls('auto_grouping_release')[0].args).toMatchObject({ p_token: TOKEN, p_ok: false });
  });

  it('클레임이 null 이면(잠김·due 전) 묶지도 풀지도 않는다 — 남의 잠금을 풀면 안 된다', async () => {
    h.rpcResult.auto_grouping_claim = { data: null, error: null };
    const out = await mod.runAutoGrouping(BOT);
    expect(out).toEqual({ ran: false, reason: 'not_due_or_locked' });
    expect(h.runGrouping).not.toHaveBeenCalled();
    expect(calls('auto_grouping_release')).toHaveLength(0);
  });

  it('클레임 RPC 오류는 claim_failed', async () => {
    h.rpcResult.auto_grouping_claim = { data: null, error: { message: 'permission denied' } };
    expect(await mod.runAutoGrouping(BOT)).toEqual({ ran: false, reason: 'claim_failed' });
  });
});

describe('catchUpAutoGrouping — 죽은 대기·죽은 실행을 운영자 화면이 따라잡는다', () => {
  const past = '2000-01-01T00:00:00.000Z';
  const future = '2999-01-01T00:00:00.000Z';

  it('due 가 지난 봇은 due 기준으로, 만료된 잠금만 남은 봇(클레임 뒤 죽음)은 due 무관으로 줍는다', async () => {
    h.tables.grouping_revisions = [
      { bot_id: 'due-passed', auto_group_due_at: past, auto_group_lock_until: null },
      { bot_id: 'orphan-lock', auto_group_due_at: null, auto_group_lock_until: past },
      { bot_id: 'due-future', auto_group_due_at: future, auto_group_lock_until: null },
      { bot_id: 'quiet', auto_group_due_at: null, auto_group_lock_until: null },
      { bot_id: 'not-mine', auto_group_due_at: past, auto_group_lock_until: null },
    ];
    await mod.catchUpAutoGrouping(['due-passed', 'orphan-lock', 'due-future', 'quiet']);
    const claims = calls('auto_grouping_claim').map((c) => [c.args.p_bot_id, c.args.p_require_due]);
    expect(claims).toEqual([['due-passed', true], ['orphan-lock', false]]);
  });

  it('밀린 것이 없으면 읽기 한 번으로 끝난다(RPC 0)', async () => {
    h.tables.grouping_revisions = [{ bot_id: BOT, auto_group_due_at: future, auto_group_lock_until: null }];
    await mod.catchUpAutoGrouping([BOT]);
    expect(h.rpc).toHaveLength(0);
  });

  it('봇이 없으면 아무것도 안 읽는다', async () => {
    await mod.catchUpAutoGrouping([]);
    expect(h.rpc).toHaveLength(0);
  });
});

describe('runGroupingNow — [지금 묶기]·배치 뒤. 잠금을 공유하고 결과를 합친다', () => {
  it('자동 실행이 도는 봇은 busy 로 세고 나머지는 묶는다', async () => {
    h.rpcResult.auto_grouping_claim = (args) => ({ data: args.p_bot_id === 'busy-bot' ? null : TOKEN, error: null });
    const out = await mod.runGroupingNow(['busy-bot', BOT], Date.now() + 60_000);
    expect(out.busy).toBe(1);
    expect(out.grouped).toBe(2);
    expect(h.runGrouping).toHaveBeenCalledTimes(1);
  });

  it('마감이 지나면 남은 봇은 deferred 로 센다 — 봇마다 예산을 새로 주지 않는다', async () => {
    const out = await mod.runGroupingNow(['a', 'b'], Date.now() - 1);
    expect(out.deferred).toBe(2);
    expect(h.runGrouping).not.toHaveBeenCalled();
  });
});

describe('readGroupingStatus — 화면이 그리는 상태 (필터가 실제로 적용된다)', () => {
  it('미묶음 수는 group_id NULL + 묶기 대상 분류만 센다 — cs·praise 가 섞이면 영원히 「안 묶였어요」가 된다', async () => {
    h.tables.insights = [
      { bot_id: 'a', group_id: null, category: 'bug' },
      { bot_id: 'a', group_id: null, category: 'ux' },
      { bot_id: 'a', group_id: null, category: 'cs' },
      { bot_id: 'a', group_id: 'g1', category: 'bug' },
      { bot_id: 'other', group_id: null, category: 'bug' },
    ];
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    h.tables.grouping_revisions = [
      { bot_id: 'a', auto_group_due_at: future, auto_group_lock_until: null, auto_grouped_at: past },
      { bot_id: 'b', auto_group_due_at: null, auto_group_lock_until: future, auto_grouped_at: null },
      { bot_id: 'other', auto_group_due_at: past, auto_group_lock_until: null, auto_grouped_at: null },
    ];
    const s = await mod.readGroupingStatus(['a', 'b']);
    expect(s).toEqual({ pending: 2, dueAt: future, running: true, lastGroupedAt: past });
  });

  it('만료된 잠금은 「진행 중」이 아니다', async () => {
    h.tables.grouping_revisions = [{ bot_id: 'a', auto_group_due_at: null, auto_group_lock_until: new Date(Date.now() - 1_000).toISOString(), auto_grouped_at: null }];
    expect((await mod.readGroupingStatus(['a'])).running).toBe(false);
  });

  it('조회 실패는 throw — 「모름」을 0 으로 그리지 않는다', async () => {
    h.fromError = { message: 'column auto_group_due_at does not exist' };
    await expect(mod.readGroupingStatus(['a'])).rejects.toThrow('grouping_status_failed');
  });
});

describe('shouldScheduleAutoGrouping — 대기자 슬롯을 잡을 가치가 있는 settle 인가', () => {
  it('인사이트가 없으면 안 건다', () => {
    expect(mod.shouldScheduleAutoGrouping({ insightId: null, category: 'bug', source: 'web' })).toBe(false);
  });
  it('묶기 대상 분류(bug·ux·feature_request)는 건다, cs·praise·other 는 안 건다', () => {
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: 'bug', source: 'web' })).toBe(true);
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: 'feature_request', source: 'kakao' })).toBe(true);
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: 'cs', source: 'web' })).toBe(false);
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: 'praise', source: 'telegram' })).toBe(false);
  });
  it('보충 턴(insight 없이 기존 제보에 붙음)은 사람이 아직 말하는 중이다 — due 를 민다', () => {
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: null, source: 'web' })).toBe(true);
  });
  it('채널톡은 문의·칭찬도 «자동 닫힘» 대상이라 늘 건다', () => {
    expect(mod.shouldScheduleAutoGrouping({ insightId: 'i', category: 'cs', source: 'channel' })).toBe(true);
  });
});

// 자동 묶기 (I-10) — 인사이트가 생기면 사람이 [지금 묶기]를 누르지 않아도 묶인다.
//
// 왜 크론이 아닌가: Vercel Hobby 는 하루 1회 크론 2개(check-merged·auto-pr)가 끝이다.
// 그래서 인사이트를 settle 한 «그 요청»의 `after()` 안에서 돈다.
//
// 왜 바로 묶지 않고 기다리는가(quiet): I-05 의 보충 턴(꼬리질문 답)은 `extend_insight` 가
// **`group_id IS NULL` 일 때만** 기존 인사이트에 붙는다. 제보 직후에 묶어 버리면 30초 뒤에
// 온 「PC 크롬이에요」가 새 조각이 된다 — 자동 묶기가 조각을 «만드는» 쪽이 된다.
// 그래서 마지막 settle 로부터 QUIET 만큼 조용해진 뒤에 묶는다(trailing debounce).
// 「최근 N분 내 묶기 완료면 건너뜀」이 아닌 이유: 그 창 안에 온 2·3번째 제보가 다음 트리거가
// 올 때까지 안 묶인다. 시연(비슷한 제보 2~3건 → 묶음 하나)이 바로 그 경우다.
//
// 누가 기다리는가: **봇당 한 요청만.** 요청마다 90초를 자면 무인증 위젯 POST 하나가 서버리스
// 함수를 90초씩 붙잡아, 하루 상한 2,000건인 봇은 50 함수-시간을 태운다(보안 리뷰 H2 — 심사
// 기간 가용성). `auto_grouping_request` 가 대기자 슬롯을 선점한 호출에만 waiter=true 를 주고,
// 나머지는 due 만 앞으로 밀고 즉시 돌아간다. 대기자는 due 가 밀리면 그만큼 더 자되
// MAX_WAIT 를 넘지 않는다(80초마다 제보가 오는 봇도 언젠가는 묶인다).
//
// 동시성: 판정은 전부 DB 함수가 DB 시계로 한다. 실행 잠금은 토큰으로 펜싱돼 만료 뒤 남이
// 잡은 잠금을 옛 실행이 풀지 못한다. 묶기 자체는 `runGrouping` 의 revision 낙관적 잠금이
// 지키므로 여기 잠금은 «비용» 문제만 막는다. 실패하면 해제가 due 를 다시 심고(재무장),
// 클레임 뒤 함수가 죽어 잠금만 남은 봇은 catch-up 이 줍는다.

import { getServiceRoleClient } from '@/lib/supabase';
import { GROUPABLE_CATEGORIES, isGroupable } from '@/lib/classify/taxonomy';
import { runGrouping, type GroupingResult } from '@/lib/groups/grouping';
import type { GroupingStatus } from '@/lib/groups/grouping-status';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** 마지막 인사이트 뒤 이만큼 조용하면 묶는다. 보충 턴(I-05)이 붙을 시간. */
export const AUTO_GROUPING_QUIET_MS = 90_000;
/** 대기자가 due 가 밀리는 것을 따라가며 자는 시간의 상한. 이 뒤엔 due 와 무관하게 묶는다. */
export const AUTO_GROUPING_MAX_WAIT_MS = 180_000;
/** DB 쪽 due 천장(첫 요청 뒤). 대기자가 죽어도 catch-up 이 이 시각 뒤엔 잡는다. */
export const AUTO_GROUPING_MAX_DUE_MS = 600_000;
/** 대기자 슬롯 수명 = 라우트 maxDuration. 이 뒤에도 슬롯이 남아 있으면 그 대기자는 죽은 것이다. */
export const AUTO_GROUPING_WAITER_MS = 300_000;
/** 클레임 잠금 수명. 묶기 예산(100초)보다 길어야 정상 실행 중에 남이 다시 잡지 않는다. */
export const AUTO_GROUPING_LOCK_MS = 150_000;
/** 한 번의 자동 묶기에 주는 예산. 모델 60초 + RPC. 대기 상한과 합쳐 maxDuration(300) 안. */
export const AUTO_GROUPING_BUDGET_MS = 100_000;
/** 실패한 실행의 재무장 간격. 못 묶는 묶음이 화면 폴링마다 모델을 태우지 않게 넉넉히. */
export const AUTO_GROUPING_RETRY_MS = 600_000;

export type AutoGroupingOutcome =
  | { ran: false; reason: 'not_due_or_locked' | 'request_failed' | 'claim_failed' | 'not_waiter' | 'gave_up' }
  | { ran: true; ok: boolean; result: GroupingResult };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RequestReceipt {
  due: string;
  waiter: boolean;
  waiterUntil: string;
}

/**
 * 「이 봇은 quiet 뒤에 묶어야 한다」 + 대기자 선출. 실패는 로그만 — 제보 저장은 이미 끝났다.
 * @returns null 이면 RPC 실패(마이그레이션 누락 등).
 */
export async function requestAutoGrouping(botId: string, quietMs = AUTO_GROUPING_QUIET_MS): Promise<RequestReceipt | null> {
  const { data, error } = await db().rpc('auto_grouping_request', {
    p_bot_id: botId,
    p_quiet_seconds: Math.ceil(quietMs / 1000),
    p_max_wait_seconds: Math.ceil(AUTO_GROUPING_MAX_DUE_MS / 1000),
    p_waiter_seconds: Math.ceil(AUTO_GROUPING_WAITER_MS / 1000),
  });
  if (error) {
    console.error(`[auto-grouping] request failed bot=${botId}: ${error.message}`);
    return null;
  }
  const row = (data ?? null) as { due?: unknown; waiter?: unknown; waiter_until?: unknown } | null;
  return {
    due: typeof row?.due === 'string' ? row.due : '',
    waiter: row?.waiter === true,
    waiterUntil: typeof row?.waiter_until === 'string' ? row.waiter_until : '',
  };
}

/**
 * 클레임이 되면 묶고 해제한다. `requireDue` 가 false 면 예정 시각과 무관하게 «지금» 묶는다
 * (배치 분류 직후·[지금 묶기]처럼 사람이 원할 때). 잠금은 두 경우 다 존중한다.
 *
 * `ok` = 묶기가 실패 없이 끝났는가. `runGrouping` 은 봇 단위 실패를 throw 하지 않고
 * `failures` 에 접으므로 그걸 봐야 한다 — 실패면 해제가 due 를 재무장한다.
 */
export async function runAutoGrouping(
  botId: string,
  opts: { requireDue?: boolean; deadlineMs?: number } = {},
): Promise<AutoGroupingOutcome> {
  const requireDue = opts.requireDue ?? true;
  const { data: token, error } = await db().rpc('auto_grouping_claim', {
    p_bot_id: botId,
    p_require_due: requireDue,
    p_lock_seconds: Math.ceil(AUTO_GROUPING_LOCK_MS / 1000),
  });
  if (error) {
    console.error(`[auto-grouping] claim failed bot=${botId}: ${error.message}`);
    return { ran: false, reason: 'claim_failed' };
  }
  if (typeof token !== 'string' || !token) return { ran: false, reason: 'not_due_or_locked' };

  let ok = false;
  try {
    const result = await runGrouping([botId], opts.deadlineMs ?? Date.now() + AUTO_GROUPING_BUDGET_MS);
    // ⚠️ `loopFailures` 는 «보지 않는다». 되돌림이 실패했다고 묶기를 재무장하면, 재실행은
    // 이미 묶인 인사이트를 다시 안 보므로 되돌림은 재시도되지 않고 모델 호출만 다시 돈다.
    // 그래도 조용히 넘기지는 않는다 — 아래 로그에 함께 찍는다.
    ok = !(result.failures?.length) && !result.deferred;
    if (result.loopFailures?.length) {
      console.warn(`[auto-grouping] bot=${botId} loop_closed_failures=${JSON.stringify(result.loopFailures)}`);
    }
    // 실패는 조용히 접지 않는다 — [지금 묶기]가 같은 실패를 보여주듯 로그에 이유를 남긴다.
    if (!ok) {
      console.warn(`[auto-grouping] bot=${botId} failures=${JSON.stringify(result.failures)} deferred=${result.deferred ?? 0}`);
    } else {
      console.log(`[auto-grouping] bot=${botId} grouped=${result.grouped} dismissed=${result.dismissed ?? 0} loopClosed=${result.loopClosed ?? 0} pending=${result.pending ?? 0}`);
    }
    return { ran: true, ok, result };
  } finally {
    const { error: releaseError } = await db().rpc('auto_grouping_release', {
      p_bot_id: botId,
      p_token: token,
      p_ok: ok,
      p_retry_seconds: Math.ceil(AUTO_GROUPING_RETRY_MS / 1000),
    });
    if (releaseError) console.error(`[auto-grouping] release failed bot=${botId}: ${releaseError.message}`);
  }
}

/** 대기자가 자는 사이 due 가 어디로 갔는지 본다. 못 읽으면 null. */
async function peekDue(botId: string): Promise<{ dueAt: string | null; locked: boolean } | null> {
  const { data, error } = await db()
    .from('grouping_revisions')
    .select('auto_group_due_at, auto_group_lock_until')
    .eq('bot_id', botId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { auto_group_due_at: string | null; auto_group_lock_until: string | null };
  return {
    dueAt: row.auto_group_due_at,
    locked: !!row.auto_group_lock_until && new Date(row.auto_group_lock_until).getTime() > Date.now(),
  };
}

/**
 * settle 직후 부르는 진입점. 요청(+대기자 선출) → 대기자만 quiet 동안 잔다 → due 면 클레임·실행.
 * `after()` 안에서 await 된다. 대기자가 아니면 RPC 한 번으로 끝난다.
 *
 * 대기자 루프: 자고 일어나 클레임을 시도한다. 뒤이은 제보가 due 를 밀었으면 그만큼 더 자고
 * 다시 시도한다. MAX_WAIT 를 넘기면 due 와 무관하게 한 번 묶고 끝낸다 — 제보가 끝없이
 * 이어지는 봇이 영영 안 묶이는 것을 막는다. 남이 잠갔으면(배치 분류·버튼) 물러난다.
 */
export async function scheduleAutoGrouping(
  botId: string,
  opts: { quietMs?: number; maxWaitMs?: number; deadlineMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<AutoGroupingOutcome> {
  const quietMs = opts.quietMs ?? AUTO_GROUPING_QUIET_MS;
  const wait = opts.wait ?? sleep;
  const now = opts.now ?? Date.now;

  const receipt = await requestAutoGrouping(botId, quietMs);
  if (!receipt) return { ran: false, reason: 'request_failed' };
  if (!receipt.waiter) return { ran: false, reason: 'not_waiter' };

  const started = now();
  // 대기 + 묶기가 마감 하나 안에 든다. 라우트가 남은 시간을 넘기면 그걸 쓰고, 아니면 maxDuration(300초)에서
  // 20초를 뺀 값 — 앞단(즉답 10초·분류 30초)이 먹은 시간을 대강 뺀 것이다. 넘기면 release 가 안 돌아 잠금이 고아가 된다.
  const deadlineMs = opts.deadlineMs ?? started + 280_000;
  const maxWaitMs = Math.max(0, Math.min(opts.maxWaitMs ?? AUTO_GROUPING_MAX_WAIT_MS, deadlineMs - AUTO_GROUPING_BUDGET_MS - started));
  try {
    let napMs = quietMs;
    let minNapMs = 500;
    for (;;) {
      await wait(napMs);
      const claimed = await runAutoGrouping(botId, { requireDue: true, deadlineMs: Math.min(deadlineMs, now() + AUTO_GROUPING_BUDGET_MS) });
      if (claimed.ran || claimed.reason === 'claim_failed') return claimed;

      const elapsed = now() - started;
      const peek = await peekDue(botId);
      // due 가 비었다 = 누가 이미 묶었다(배치·버튼·다른 실행). 할 일이 없다.
      if (!peek || !peek.dueAt) return { ran: false, reason: 'not_due_or_locked' };
      if (elapsed >= maxWaitMs) {
        // 상한. 남이 잠갔으면 물러나고(그쪽이 묶는다), 아니면 지금 묶는다.
        if (peek.locked) return { ran: false, reason: 'gave_up' };
        return runAutoGrouping(botId, { requireDue: false, deadlineMs: Math.min(deadlineMs, now() + AUTO_GROUPING_BUDGET_MS) });
      }
      // 뒤이은 제보가 due 를 밀었다. 그 시각까지(상한 안에서) 더 잔다. 잠겨 있으면 잠깐 뒤 다시 —
      // 최소 낮잠은 회차마다 늘린다(1→2→4…초). 경합이 반복돼도 DB 왕복이 수백 번 쌓이지 않게.
      const untilDue = new Date(peek.dueAt).getTime() - now();
      minNapMs = Math.min(minNapMs * 2, 30_000);
      napMs = peek.locked ? Math.min(Math.max(5_000, minNapMs), maxWaitMs - elapsed) : Math.max(minNapMs, Math.min(untilDue, maxWaitMs - elapsed));
    }
  } finally {
    // 클레임이 슬롯을 비웠으면 이건 0행이다. 클레임 못 하고 나갈 때만 실제로 푼다.
    const { error } = await db().rpc('auto_grouping_waiter_release', { p_bot_id: botId, p_waiter_until: receipt.waiterUntil });
    if (error) console.error(`[auto-grouping] waiter release failed bot=${botId}: ${error.message}`);
  }
}

/**
 * settle 결과로 자동 묶기를 걸어야 하는가. 묶기 대상이 아닌 분류(cs·praise·other)는 어차피
 * 스냅샷에 안 오므로 대기자 슬롯을 잡을 이유가 없다 — 단 채널톡은 그 분류를 «자동 닫힘»으로
 * 처리하므로 걸어야 한다. 보충 턴(insight 없이 기존 제보에 붙음)은 그 제보가 아직 안 묶였다는
 * 뜻이라 due 를 밀어야 한다(사람이 아직 말하는 중이다).
 */
export function shouldScheduleAutoGrouping(p: {
  insightId: string | null;
  category?: string | null;
  source?: 'web' | 'kakao' | 'telegram' | 'channel';
}): boolean {
  if (!p.insightId) return false;
  if (p.source === 'channel') return true;
  if (p.category == null) return true;
  return isGroupable(p.category);
}

export type { GroupingStatus } from '@/lib/groups/grouping-status';

/** 봇들의 자동 묶기 상태를 한 번에 읽는다. 조회 실패는 「모름」으로 접지 않고 throw. */
export async function readGroupingStatus(botIds: string[]): Promise<GroupingStatus> {
  if (botIds.length === 0) return { pending: 0, dueAt: null, running: false, lastGroupedAt: null };
  const [pendingRes, revRes] = await Promise.all([
    db()
      .from('insights')
      .select('id', { count: 'exact', head: true })
      .in('bot_id', botIds)
      .is('group_id', null)
      .in('category', [...GROUPABLE_CATEGORIES]),
    db()
      .from('grouping_revisions')
      .select('bot_id, auto_group_due_at, auto_group_lock_until, auto_grouped_at')
      .in('bot_id', botIds),
  ]);
  if (pendingRes.error) throw new Error(`grouping_status_failed: ${pendingRes.error.message}`);
  if (revRes.error) throw new Error(`grouping_status_failed: ${revRes.error.message}`);

  const now = Date.now();
  let dueAt: string | null = null;
  let running = false;
  let lastGroupedAt: string | null = null;
  for (const row of (revRes.data ?? []) as {
    auto_group_due_at: string | null;
    auto_group_lock_until: string | null;
    auto_grouped_at: string | null;
  }[]) {
    if (row.auto_group_due_at && (!dueAt || Date.parse(row.auto_group_due_at) < Date.parse(dueAt))) dueAt = row.auto_group_due_at;
    if (row.auto_group_lock_until && Date.parse(row.auto_group_lock_until) > now) running = true;
    if (row.auto_grouped_at && (!lastGroupedAt || Date.parse(row.auto_grouped_at) > Date.parse(lastGroupedAt))) lastGroupedAt = row.auto_grouped_at;
  }
  return { pending: pendingRes.count ?? 0, dueAt, running, lastGroupedAt };
}

/**
 * 밀린 자동 묶기 따라잡기 — 운영자 화면(GET /api/groups)의 `after()` 에서.
 * 두 종류를 줍는다: ① due 가 지났는데 대기자가 없거나 죽은 봇 ② 클레임 뒤 함수가 죽어
 * 만료된 잠금만 남은 봇(해제가 안 돌았으니 due 도 비어 있다). 정상 상태에선 읽기 한 번으로 끝난다.
 */
export async function catchUpAutoGrouping(botIds: string[], deadlineMs = Date.now() + AUTO_GROUPING_BUDGET_MS): Promise<void> {
  if (botIds.length === 0) return;
  const nowIso = new Date().toISOString();
  const { data, error } = await db()
    .from('grouping_revisions')
    .select('bot_id, auto_group_due_at, auto_group_lock_until')
    .in('bot_id', botIds)
    .or(`auto_group_due_at.lte.${nowIso},auto_group_lock_until.lte.${nowIso}`);
  if (error) {
    console.error(`[auto-grouping] catch-up lookup failed: ${error.message}`);
    return;
  }
  for (const row of (data ?? []) as { bot_id: string; auto_group_due_at: string | null; auto_group_lock_until: string | null }[]) {
    if (Date.now() >= deadlineMs) return;
    // due 가 살아 있으면 due 로, 만료된 잠금만 남았으면(죽은 실행) due 와 무관하게 줍는다.
    const orphanLock = !row.auto_group_due_at && !!row.auto_group_lock_until;
    try {
      await runAutoGrouping(row.bot_id, { requireDue: !orphanLock, deadlineMs });
    } catch (err) {
      console.error(`[auto-grouping] catch-up failed bot=${row.bot_id}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * 사람이 «지금» 묶기 — [지금 묶기] 버튼·배치 분류 뒤. 봇마다 잠금을 존중하며 돈다.
 * 자동 실행이 도는 봇은 건너뛰고 `busy` 로 센다(같은 봇에 둘이 겹치면 한쪽이 revision 충돌로 실패해
 * 운영자가 503 을 본다 — 보안 리뷰 L3). 결과는 `runGrouping` 의 모양으로 합친다.
 */
export async function runGroupingNow(botIds: string[], deadlineMs: number): Promise<GroupingResult & { busy: number }> {
  const merged: GroupingResult & { busy: number } = { grouped: 0, groups: [], pending: 0, deferred: 0, failures: [], dismissed: 0, loopClosed: 0, loopFailures: [], busy: 0 };
  for (const botId of [...new Set(botIds)]) {
    if (Date.now() >= deadlineMs) { merged.deferred!++; continue; }
    const out = await runAutoGrouping(botId, { requireDue: false, deadlineMs });
    if (!out.ran) {
      if (out.reason === 'claim_failed') merged.failures!.push({ botId, reason: 'claim_failed' });
      else merged.busy++;
      continue;
    }
    merged.grouped += out.result.grouped;
    merged.groups.push(...out.result.groups);
    merged.pending! += out.result.pending ?? 0;
    merged.deferred! += out.result.deferred ?? 0;
    merged.dismissed! += out.result.dismissed ?? 0;
    merged.loopClosed! += out.result.loopClosed ?? 0;
    merged.failures!.push(...(out.result.failures ?? []));
    merged.loopFailures!.push(...(out.result.loopFailures ?? []));
  }
  return merged;
}

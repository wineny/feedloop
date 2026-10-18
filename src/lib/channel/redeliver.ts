// 못 보낸 되돌림을 다시 보낸다.
//
// 크론을 새로 만들 수 없다 — Vercel Hobby 는 2개가 상한이고 check-merged·auto-pr 로 꽉 찼다.
// 셋째를 넣으면 빌드 실패가 아니라 **배포 자체가 거부**되고, 그 커밋이 origin 에 있는 한
// 이후 모든 배포가 막힌다. 그래서 회수 경로를 스케줄러 없이 둘로 나눴다.
//
//  - `retryUndelivered`       그 유저가 다음에 말을 걸 때 (웹훅 수신 시점)
//  - `retryUndeliveredForRun` 운영자가 「수정 PR」 상세에서 누를 때
//
// 어느 쪽도 조용한 유저를 영원히 회수하지는 못한다. 그건 정직하게 남는 한계이고,
// 시연의 주 경로는 수동 버튼이다.

import { getServiceRoleClient } from '@/lib/supabase';
import { markResponsesDelivered } from '@/lib/bot/conversations';
import { sendBotMessage } from './client';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** 웹훅 응답 예산을 잡아먹지 않게 짧게 건다. 못 보내면 다음 발화나 버튼이 회수한다. */
export const WEBHOOK_RETRY_TIMEOUT_MS = 1500;
/** 한 발화에 얹는 최대 건수. 밀린 게 많아도 웹훅을 오래 붙들지 않는다. */
export const WEBHOOK_RETRY_MAX = 2;

/** 수동 버튼은 사람이 기다리므로 조금 더 준다. */
export const MANUAL_RETRY_TIMEOUT_MS = 3000;
export const MANUAL_RETRY_MAX = 5;

/**
 * 이 횟수만큼 실패한 행은 더 시도하지 않는다. 채널이 계속 거부하는 건(닫힌 챗·삭제된 유저)
 * 재시도로 풀리지 않는데, 그걸 매번 다시 태우면 유저가 말 걸 때마다 지연만 는다.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface RetryOutcome {
  sent: number;
  failed: number;
  /** 보낼 것이 있었는지. 0 이면 대기열이 비어 있었다는 뜻이다. */
  considered: number;
}

const EMPTY: RetryOutcome = { sent: 0, failed: 0, considered: 0 };

/**
 * 수동 재전송 버튼이 화면에 돌려주는 것.
 *
 * 성격이 다른 다섯 가지를 한 숫자로 접지 않는다 — 접으면 운영자가 「고쳐야 할 것」과
 * 「그냥 기다리면 되는 것」을 구분하지 못한다.
 */
export interface RunRetryOutcome {
  /** 방금 채널톡으로 실제로 나간 건수 */
  sent: number;
  /** 이번에 시도했으나 채널톡이 거부한 건수. `delivery_attempts` 가 올라갔다 */
  failed: number;
  /**
   * 채널톡인데 아직 못 나갔고 **다시 시도할 수 있는** 건수.
   * 한 번에 최대 `MANUAL_RETRY_MAX` 건만 보내므로 다 소진되지 않으면 여기 남는다.
   */
  remaining: number;
  /**
   * 5회를 다 쓴 건수. **버튼을 더 눌러도 안 나간다** — 사람이 봐야 한다
   * (닫힌 챗·삭제된 유저·죽은 키). `remaining` 에 섞으면 운영자가 영원히 버튼을 누른다.
   */
  exhausted: number;
  /**
   * 웹·카카오라 여기서 보내지 않은 미전달 건. **실패가 아니다** —
   * 카카오는 선톡이 안 되니 그 유저의 다음 발화에 얹혀 나가는 것이 정상 동작이다.
   */
  skippedNonChannel: number;
}

interface PendingRow {
  id: string;
  response_body: string;
  delivery_attempts: number | null;
}

/**
 * 그 대화의 못 보낸 되돌림.
 *
 * `response_type = 'loop_closed'` 로 좁히는 것이 중요하다. 운영자 답장(`operator`)도
 * `delivered_at IS NULL` 로 쌓이는데(카카오 대기열), 그건 채널톡에서 우리가 보낼 것이
 * 아니다 — 상담원이 데스크에서 직접 답한다(원칙 2).
 */
async function loadPending(conversationId: string, limit: number): Promise<PendingRow[]> {
  const { data, error } = await db()
    .from('responses')
    .select('id, response_body, delivery_attempts')
    .eq('conversation_id', conversationId)
    .eq('response_type', 'loop_closed')
    .is('delivered_at', null)
    .lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
    .order('sent_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[channel] pending lookup error:', error.message);
    return [];
  }
  return (data ?? []) as PendingRow[];
}

/**
 * 실패를 세고 사유를 남긴다. 사유는 이미 `client.ts` 가 시크릿을 지운 문자열이지만
 * 200자로 한 번 더 자른다 — 이 값은 화면까지 나간다.
 *
 * `loop-closed.ts` 의 최초 전송도 이 함수를 쓴다. 세는 방식이 두 벌이 되면
 * `delivery_attempts >= 5` 제외 규칙이 경로마다 다르게 동작한다.
 */
export async function recordDeliveryFailure(
  responseId: string,
  currentAttempts: number | null,
  message: string,
): Promise<void> {
  const { error } = await db()
    .from('responses')
    .update({
      delivery_attempts: (currentAttempts ?? 0) + 1,
      delivery_error: message.slice(0, 200),
    })
    .eq('id', responseId);
  if (error) console.error('[channel] delivery failure record error:', error.message);
}

interface ChannelTarget {
  botId: string;
  userChatId: string;
}

/** 채널톡 대화만 대상이다. 웹·카카오 대화가 들어오면 아무것도 하지 않는다(원칙 1). */
async function resolveTarget(conversationId: string): Promise<ChannelTarget | null> {
  const { data, error } = await db()
    .from('conversations')
    .select('bot_id, source, external_user_id')
    .eq('id', conversationId)
    .single();

  if (error || !data) return null;
  if (data.source !== 'channel') return null;
  return { botId: data.bot_id, userChatId: data.external_user_id };
}

async function deliver(
  target: ChannelTarget,
  rows: PendingRow[],
  timeoutMs: number,
): Promise<RetryOutcome> {
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await sendBotMessage(target.botId, target.userChatId, row.response_body, {
      timeoutMs,
    });

    if (result.ok) {
      // CAS 다 — `delivered_at IS NULL` 조건이 걸려 있어 동시 경로 중 하나만 확정된다.
      await markResponsesDelivered([row.id]);
      sent += 1;
    } else {
      await recordDeliveryFailure(row.id, row.delivery_attempts, result.message);
      failed += 1;
    }
  }

  return { sent, failed, considered: rows.length };
}

/**
 * 그 유저가 다시 말을 걸었다 — 밀려 있던 되돌림을 지금 얹는다.
 *
 * 웹훅 `after()` 안에서 돈다. 실패해도 이미 200 을 준 뒤라 채널톡은 재전송하지 않는다.
 */
export async function retryUndelivered(
  conversationId: string,
  limit: number = WEBHOOK_RETRY_MAX,
): Promise<RetryOutcome> {
  const target = await resolveTarget(conversationId);
  if (!target) return EMPTY;

  const rows = await loadPending(conversationId, limit);
  if (rows.length === 0) return EMPTY;

  return deliver(target, rows, WEBHOOK_RETRY_TIMEOUT_MS);
}

/**
 * 운영자가 「수정 PR」 상세에서 「되돌림 재전송」을 눌렀다.
 *
 * 시연의 **주 회복 경로**다. 조용한 유저는 웹훅 경로로 회수되지 않는데, 크론을 새로
 * 만들 수 없으니 사람이 누르는 것 말고는 방법이 없다.
 *
 * 웹훅 경로와 달리 **그 사람의 가장 최근 대화를 다시 고른다.** 되돌림을 만든 시점과
 * 지금 사이에 그 사람이 새 유저챗을 열었을 수 있고, 옛 챗이 닫혀 있으면 보내도 유저에게
 * 푸시가 가는지 확인되지 않았다(브리프 25행). 열려 있을 가능성이 높은 쪽을 고른다.
 */
export async function retryUndeliveredForRun(
  runId: string,
  limit: number = MANUAL_RETRY_MAX,
): Promise<RunRetryOutcome> {
  const pending = await loadRunPending(runId);

  // ⚠️ **채널을 거른 «뒤에» 자른다.** 예전에는 DB 쿼리에서 바로 `.limit(5)` 를 걸었는데,
  //    한 run 에 카카오 미전달이 5건 이상이면(카카오는 유저가 말을 걸 때까지 영구히
  //    `delivered_at IS NULL` 이고 `sent_at` 도 앞선다) 채널톡 행이 조회에 들어오지도
  //    못했다. 버튼을 눌러도 `sent: 0` 만 나오고 「다시 누르면 나갑니다」가 거짓말이 된다.
  const sendable = pending
    .filter((r) => r.source === 'channel' && (r.delivery_attempts ?? 0) < MAX_DELIVERY_ATTEMPTS)
    .slice(0, limit);

  let sent = 0;
  let failed = 0;

  for (const row of sendable) {
    const target = await latestChannelChatOf(row.conversation_id);
    // 대화가 사라졌거나 채널이 바뀐 경우. 아래 요약이 성격에 맞게 다시 센다.
    if (!target) continue;

    const result = await sendBotMessage(target.botId, target.userChatId, row.response_body, {
      timeoutMs: MANUAL_RETRY_TIMEOUT_MS,
    });

    if (result.ok) {
      await markResponsesDelivered([row.id]);
      sent += 1;
    } else {
      await recordDeliveryFailure(row.id, row.delivery_attempts, result.message);
      failed += 1;
    }
  }

  // 전송을 마친 «뒤» 에 센다. 화면이 「아직 몇 건 남았나」를 정확히 말해야 하고,
  // 그건 방금 나간 것을 빼고 방금 실패해 횟수가 오른 것을 반영한 값이어야 한다.
  const summary = summarize(await loadRunPending(runId));
  return { sent, failed, ...summary };
}

interface RunPendingRow extends PendingRow {
  conversation_id: string;
  /** 그 대화의 채널. 대화가 사라졌으면 null */
  source: string | null;
}

/**
 * 이 run 에서 아직 유저에게 닿지 않은 되돌림 전량 — **자르지 않고** 가져온다.
 *
 * 자르는 일은 채널을 가른 뒤에 한다(위 주석). 건수는 그 run 이 건드린 대화 수에
 * 묶여 있어 자르지 않아도 유한하다.
 */
async function loadRunPending(runId: string): Promise<RunPendingRow[]> {
  const { data, error } = await db()
    .from('responses')
    .select('id, response_body, delivery_attempts, conversation_id')
    .eq('auto_dev_run_id', runId)
    .eq('response_type', 'loop_closed')
    .is('delivered_at', null)
    .order('sent_at', { ascending: true });

  if (error) {
    console.error('[channel] run pending lookup error:', error.message);
    return [];
  }

  const rows = (data ?? []) as Array<PendingRow & { conversation_id: string }>;
  if (rows.length === 0) return [];

  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const { data: convs } = await db().from('conversations').select('id, source').in('id', convIds);
  const sourceById = new Map(
    ((convs ?? []) as Array<{ id: string; source: string }>).map((c) => [c.id, c.source]),
  );

  return rows.map((r) => ({ ...r, source: sourceById.get(r.conversation_id) ?? null }));
}

/**
 * 아직 닿지 않은 되돌림을 성격별로 나눈다.
 *
 * 「남았다」 한 덩어리로 보여주면 운영자가 무엇을 해야 하는지 알 수 없다 —
 * 다시 누르면 되는 것 · 사람이 봐야 하는 것 · 그냥 기다리면 되는 것이 섞이기 때문이다.
 */
function summarize(
  rows: RunPendingRow[],
): Pick<RunRetryOutcome, 'remaining' | 'exhausted' | 'skippedNonChannel'> {
  const out = { remaining: 0, exhausted: 0, skippedNonChannel: 0 };
  for (const r of rows) {
    if (r.source !== 'channel') out.skippedNonChannel += 1;
    else if ((r.delivery_attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS) out.exhausted += 1;
    else out.remaining += 1;
  }
  return out;
}

/**
 * 그 대화가 속한 «사람» 의 가장 최근 채널톡 대화.
 *
 * person 키는 `channel_person_id` 다. 웹훅이 `'chat:'+chatId` 폴백으로 늘 채우므로
 * NULL 이 나오는 건 이 대화가 채널톡이 아니라는 뜻이고, 그때는 대상이 없다.
 */
async function latestChannelChatOf(conversationId: string): Promise<ChannelTarget | null> {
  const { data: conv } = await db()
    .from('conversations')
    .select('bot_id, source, external_user_id, channel_person_id')
    .eq('id', conversationId)
    .single();

  if (!conv || conv.source !== 'channel') return null;
  if (!conv.channel_person_id) {
    return { botId: conv.bot_id, userChatId: conv.external_user_id };
  }

  const { data: latest } = await db()
    .from('conversations')
    .select('external_user_id')
    .eq('bot_id', conv.bot_id)
    .eq('channel_person_id', conv.channel_person_id)
    // 시각 없는 행(연락처·메시지 저장이 안 된 상담 개시)은 맨 뒤로 — DESC 기본은 NULL 이 먼저다
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1);

  const pick = (latest ?? [])[0];
  return {
    botId: conv.bot_id,
    userChatId: (pick?.external_user_id as string) ?? conv.external_user_id,
  };
}

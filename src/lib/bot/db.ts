// Supabase DB 연산 — messages, insights, responses, cooldown

import type { Context } from 'grammy';
import { getServiceRoleClient } from '@/lib/supabase';
import { normalizeCategory, normalizeSentiment } from '@/lib/classify/taxonomy';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

// ── 메시지 저장 ─────────────────────────────────────

export async function saveMessage(botId: string, ctx: Context): Promise<string | null> {
  const msg = ctx.message!;
  const { data, error } = await db().from('messages').upsert({
    bot_id: botId,
    telegram_message_id: msg.message_id,
    chat_id: msg.chat.id,
    author_name: msg.from?.first_name || 'Unknown',
    author_id: msg.from?.id,
    body: msg.text || '',
    detected_at: new Date(msg.date * 1000).toISOString(),
  }, { onConflict: 'bot_id,telegram_message_id' }).select('id').single();

  if (error) console.error('[bot] saveMessage error:', error.message);
  return data?.id || null;
}

// ── 카카오 메시지 저장 (오픈빌더 스킬 서버) ─────────

export async function saveKakaoMessage(
  botId: string,
  params: { userId: string; userName?: string; utterance: string; conversationId?: string | null },
): Promise<string | null> {
  const { data, error } = await db().from('messages').insert({
    bot_id: botId,
    conversation_id: params.conversationId ?? null,
    source: 'kakao',
    external_user_id: params.userId,
    author_name: params.userName || null,
    body: params.utterance,
    detected_at: new Date().toISOString(),
  }).select('id').single();

  if (error) console.error('[bot] saveKakaoMessage error:', error.message);
  return data?.id || null;
}

// ── 카카오 최근 메시지 조회 (1:1 컨텍스트용) ────────

export async function getRecentKakaoMessages(botId: string, userId: string, limit = 10) {
  const { data } = await db()
    .from('messages')
    .select('author_name, body')
    .eq('bot_id', botId)
    .eq('external_user_id', userId)
    .order('detected_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

// ── 인사이트 저장 ───────────────────────────────────

/**
 * @param followUpNeeded 사람이 이어받아야 하는가. 호출부의 `escalate` 를 그대로 넘긴다.
 *
 * 왜 `escalate` 를 재사용하나 — `follow_up_needed` 컬럼은 스키마에 있는데 실시간
 * 경로가 한 번도 채운 적이 없어 **프로덕션 23건이 전부 false** 였다(죽은 컬럼).
 * 새 개념을 만들어 또 하나의 안 읽는 값을 쌓기보다, 이미 모델이 판단하고 있는
 * 같은 뜻의 값(`escalate`)을 여기 적는다. 대화 단위 `conversations.escalated_at`
 * 과 달리 이건 **제보 한 건 단위**라, 어떤 인사이트가 사람 손을 탔는지가 남는다.
 *
 * ⚠️ `needsEscalation()` 을 쓰지 않는 것은 실수가 아니다. 둘은 다른 것을 가리킨다:
 *   - `conversations.escalated_at` = 「이 **대화**는 사람이 봐야 한다」.
 *     호출 실패·파싱 깨짐·할 말 없음까지 포함한다 — 방문자가 답을 못 받았으면 참이다.
 *   - `insights.follow_up_needed` = 「이 **제보**에 후속 조치가 필요하다」.
 *     제보의 성질이지 우리 응답이 성공했는지가 아니다.
 * 텔레그램 keyword 분기는 «침묵이 정답»인 경우가 있는데(답할 필요 없는 칭찬),
 * `needsEscalation` 은 `response === null` 을 참으로 보므로 그걸 후속 조치로 오인한다.
 */
export async function saveInsight(
  botId: string,
  messageId: string | null,
  insight: { category: string; summary: string; sentiment: string } | null,
  followUpNeeded = false,
): Promise<InsightWriteReceipt> {
  if (!messageId) throw new Error('message_not_saved');
  const { data, error } = await db().rpc('pipeline_settle_insight', {
    p_bot_id: botId, p_message_id: messageId,
    p_insight: insight ? { ...insight, category: normalizeCategory(insight.category),
      sentiment: normalizeSentiment(insight.sentiment), follow_up_needed: followUpNeeded } : null,
  });
  if (error) throw new Error(`insight_persistence_failed: ${error.message}`);
  return toReceipt(data);
}

/**
 * `pipeline_settle_insight` 가 돌려주는 것. `id` 가 있으면 인사이트가 «생겼거나 갱신됐다» —
 * 자동 묶기(I-10)를 요청할 근거다. null 이면 이 턴은 인사이트를 안 만들었다(칭찬·칩만 누름 등).
 */
export interface InsightWriteReceipt {
  id: string | null;
  created: boolean;
}

function toReceipt(data: unknown): InsightWriteReceipt {
  const row = (data ?? null) as { id?: unknown; created?: unknown } | null;
  return {
    id: typeof row?.id === 'string' ? row.id : null,
    created: row?.created === true,
  };
}

// ── 인사이트 쓰기 계획 (위젯 즉답) ──────────────────
//
// 위젯만 이 경로를 탄다. 카카오·텔레그램은 위 `saveInsight` 를 그대로 쓴다 —
// 그쪽은 「이 대화의 기존 제보」 목록을 프롬프트에 싣지 않아서 `extends` 가 늘 비어 있다.

export type InsightWritePlan =
  | { action: 'skip' }
  /** `reason` 은 관측용이다. 호출부가 로그로 남기고 동작은 바꾸지 않는다. */
  | { action: 'insert'; reason?: 'unknown_ref' }
  | { action: 'update'; id: string; sourceOnly?: true };

/**
 * 이 턴의 인사이트를 «새로 만들지, 앞 제보에 합칠지, 아무것도 안 할지» 정한다.
 *
 * 순수 함수로 떼어 둔 이유: 네 갈래가 전부 사고 이력이 있는 자리다. DB 를 붙들지 않고
 * 표로 시험할 수 있어야 「없는 ref 를 냈을 때 조용히 버려진다」 같은 회귀를 잡는다.
 *
 * @param chipOnly 칩 라벨만 보낸 첫 턴. **모델 판단보다 우선한다** — 프롬프트로
 *        「insight 는 null」 이라 시켜도 저가 모델은 종종 어긴다. 내용 없는 제보가
 *        저장되면 그게 묶음이 되고 자동 PR 후보가 된다.
 */
export function planInsightWrite(p: {
  insight: { category: string; summary: string; sentiment: string } | null;
  extends?: string | null;
  refMap: Map<string, { id: string }>;
  chipOnly?: boolean;
  /** Original utterance; used only to exclude courtesy-only source attachments. */
  text?: string;
}): InsightWritePlan {
  if (p.chipOnly) return { action: 'skip' };

  // 16진수라 대소문자는 뜻이 같다(배치 분류의 ref 대조와 같은 규칙).
  const ref = typeof p.extends === 'string' ? p.extends.trim().toLowerCase() : '';
  if (!ref) return { action: p.insight ? 'insert' : 'skip' };

  const target = p.refMap.get(ref);
  // 목록에 없는 ref 는 모델이 지어낸 것이다. 버리지 않고 **새 행으로 남긴다** —
  // 제보 자체는 진짜이고, 잘못 짚은 갱신은 남의 summary 를 덮어 회복이 어렵다.
  // 다만 «얼마나 자주 지어내는지»는 알아야 프롬프트를 고칠지 판단할 수 있다.
  if (!target) return p.insight ? { action: 'insert', reason: 'unknown_ref' } : { action: 'skip' };
  // A supplement may identify its source without reclassifying the original report.
  if (!p.insight) {
    // Match the entire utterance: substantive replies such as '네, PC 크롬이에요'
    // must remain evidence. Do not apply this guard to actual classified praise.
    const text = (p.text ?? '').normalize('NFKC').replace(/[\s.,!?。！？~…]/gu, '');
    if (/^(?:(?:네|넵|예|알겠습니다|알겠어요|맞아요)|(?:네|넵|예)?(?:고마워요|고맙습니다|감사해요|감사합니다))$/u.test(text)) {
      return { action: 'skip' };
    }
    return { action: 'update', id: target.id, sourceOnly: true };
  }

  return { action: 'update', id: target.id };
}

/**
 * Source membership, optional extension/fallback, and completion commit together.
 * DB errors leave the saved message pending for durable recovery; never bypass membership checks.
 */
export async function applyInsightWrite(
  botId: string,
  messageId: string | null,
  insight: { category: string; summary: string; sentiment: string } | null,
  followUpNeeded: boolean,
  plan: InsightWritePlan,
): Promise<InsightWriteReceipt> {
  if (!messageId) throw new Error('message_not_saved');
  const { data, error } = await db().rpc('pipeline_settle_insight', {
    p_bot_id: botId, p_message_id: messageId,
    p_insight: plan.action !== 'skip' && insight ? { ...insight,
      category: normalizeCategory(insight.category), sentiment: normalizeSentiment(insight.sentiment),
      follow_up_needed: followUpNeeded } : null,
    p_extend_id: plan.action === 'update' ? plan.id : null,
  });
  if (error) throw new Error(`insight_persistence_failed: ${error.message}`);
  return toReceipt(data);
}

// ── 응답 저장 ───────────────────────────────────────

export async function saveResponse(
  botId: string,
  messageId: string | null,
  responseType: string,
  responseBody: string,
  conversationId?: string | null,
) {
  const { error } = await db().from('responses').insert({
    bot_id: botId,
    conversation_id: conversationId ?? null,
    trigger_message_id: messageId,
    response_type: responseType,
    response_body: responseBody,
    // 채널로 곧바로 나가는 응답이다. 대기열(delivered_at IS NULL)에 남기지 않는다.
    delivered_at: new Date().toISOString(),
  });
  if (error) console.error('[bot] saveResponse error:', error.message);
}

// ── 최근 메시지 조회 (컨텍스트용) ───────────────────

export async function getRecentMessages(botId: string, chatId: number, limit = 10) {
  const { data } = await db()
    .from('messages')
    .select('author_name, body')
    .eq('bot_id', botId)
    .eq('chat_id', chatId)
    .order('detected_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

// ── 쿨다운 체크 ────────────────────────────────────

export async function checkCooldown(
  botId: string,
  intervalSec: number,
  maxDaily: number,
): Promise<boolean> {
  const { data } = await db()
    .from('cooldown_state')
    .select('*')
    .eq('bot_id', botId)
    .single();

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (!data) {
    await db().from('cooldown_state').insert({ bot_id: botId, daily_count_date: today });
    return true;
  }

  if (data.daily_count_date !== today) {
    await db().from('cooldown_state').update({
      daily_response_count: 0,
      daily_count_date: today,
    }).eq('bot_id', botId);
    data.daily_response_count = 0;
  }

  if (data.daily_response_count >= maxDaily) return false;

  if (data.last_response_at) {
    const elapsed = (now.getTime() - new Date(data.last_response_at).getTime()) / 1000;
    if (elapsed < intervalSec) return false;
  }

  return true;
}

// ── 쿨다운 업데이트 ────────────────────────────────

export async function updateCooldown(botId: string) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const { data } = await db()
    .from('cooldown_state')
    .select('daily_response_count, daily_count_date')
    .eq('bot_id', botId)
    .single();

  const currentCount = (data?.daily_count_date === today) ? (data?.daily_response_count || 0) : 0;

  await db().from('cooldown_state').upsert({
    bot_id: botId,
    last_response_at: now.toISOString(),
    daily_response_count: currentCount + 1,
    daily_count_date: today,
  }, { onConflict: 'bot_id' });
}

// ── 연결 확인 ───────────────────────────────────────
//
// 채널에서 그 봇 앞으로 요청이 처음 도달하면 "연결됨"으로 마킹한다.
// 온보딩 페이지(/bots/[id]/connect)가 이 값을 폴링해서 "연결됐어요"로 바꾼다.

export async function markBotConnected(botId: string) {
  const { error } = await db()
    .from('bots')
    .update({
      status: 'active',
      status_message: null,
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', botId);

  if (error) console.error('[bot] markBotConnected error:', error.message);
}

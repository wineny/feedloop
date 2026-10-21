import type { WidgetHint } from '@/lib/widget/chips';
// 대화 계층 — 웹 위젯·카카오·받은편지함이 공유한다.
//
// messages = 유저가 보낸 것, responses = 우리가 보낸 것 이라는 기존 구분을 그대로 두고
// conversation_id 로 묶어 타임라인을 만든다. (설계 문서 §4)

import { getServiceRoleClient } from '@/lib/supabase';
import type { WidgetContext } from '@/lib/widget/context';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

// 'system' 은 되돌림(loop_closed) 카드다 — 이름이 먼저 그쪽에 쓰였다.
// 'notice' 는 그 뒤에 생긴 «가운데 안내 칩»(방문자가 담당자를 부른 기록 등, response_type='system').
/** `payment` = a server-fixed sentence about money (PayPal stage 3); the widget draws it as a card. */
export type TimelineKind = 'user' | 'ai' | 'operator' | 'system' | 'notice' | 'payment';

/** 되돌림을 받은 방문자가 「그래서 고쳐졌나」에 답한 값. */
export type ResolutionConfirmation = 'fixed' | 'not_fixed';

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  body: string;
  at: string;
  /**
   * 되돌림(`kind === 'system'`)에만 실린다. 아직 안 물어본 상태면 `null`.
   *
   * 위젯이 이 값을 봐야 «이미 답한 카드»에 버튼을 다시 그리지 않는다. 저장은 멱등이라
   * 두 번 눌러도 사고는 안 나지만, 답한 사람에게 같은 질문을 또 하는 화면은 답을 안 받은 것과 같다.
   */
  confirmation?: ResolutionConfirmation | null;
  /**
   * The raw `responses.response_type` of our replies. Only `getRecentTurns` sets it (prompt
   * context), never `getTimeline` (the widget payload stays as it was). The payment router reads
   * it to tell a payment-agent reply from an ordinary AI one — both collapse to kind 'ai'.
   */
  responseType?: string;
}

export interface Conversation {
  id: string;
  bot_id: string;
  source: string;
  external_user_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** 사람이 이어받아야 하는 대화인가(AI 물러남 포함). 받은편지함 배지가 본다. */
  escalated_at: string | null;
  /**
   * 방문자가 «직접» 상담원을 부른 시각 — 「상담원 연결」·대기 문구 밑 제안 칩·「아직 그대로예요」.
   * 위젯 하단 「상담원에게 전달됐어요」는 이 칸만 본다. AI 가 escalate 를 켠 것만으로는 안 찍힌다
   * (2026-09-16 ny 결정 — 버그 제보에 AI 가 되묻는 중인데 하단이 「전달됐어요」로 바뀌던 문제).
   * 언제나 escalated_at 과 같이 찍히고 같이 지워진다(부분집합).
   */
  handoff_requested_at: string | null;
  /** 채널톡 전용. 웹·카카오는 NULL 이다 — 호출부가 「비어 있으면 채운다」를 판단하려면 읽혀야 한다. */
  channel_person_id: string | null;
}

/** 우리가 보낸 것의 종류를 말풍선 6종으로 접는다. */
function responseKind(responseType: string): TimelineKind {
  if (responseType === 'operator') return 'operator';
  if (responseType === 'loop_closed') return 'system';
  if (responseType === 'system') return 'notice';
  if (responseType === 'payment') return 'payment';
  return 'ai'; // ai · mention · keyword · question · kakao · payment_agent
}

/**
 * (봇, 채널, 외부유저) 로 대화를 찾거나 만든다.
 * 위젯은 visitorId, 카카오는 botUserKey 가 외부유저 식별자다.
 *
 * 선택 필드 두 개는 채널톡 전용이다. **값이 `undefined` 면 payload 에 키를 넣지 않으므로
 * 웹·카카오 호출은 오늘과 한 글자도 다르지 않다**(원칙 5 — 기본 호출의 동작이 바뀌면
 * 「추가만」이 아니다).
 *
 * 왜 «같은 upsert 에» 싣는가: 뒤이어 UPDATE 로 채우면 그 갱신이 실패했을 때
 * `channel_person_id` 가 NULL 로 남는다. 그러면 같은 사람의 챗 2개가 서로 다른 키를
 * 갖고 되돌림이 두 번 나간다 — person 접기가 없애려던 바로 그 실패다(설계 §3-(a)).
 *
 * ⚠️ **`last_message_at` 은 여기서 찍지 않는다**(I-29 근본 원인, 2026-09-17). 예전엔 upsert 가
 * 시각을 먼저 찍고 메시지를 뒤에 저장해서, 저장이 실패하면(I-23 경로) 시각만 있는 «유령 대화»가
 * 받은편지함에 빈 미읽음 줄로 떴다. 이제 시각은 **저장이 성공한 뒤** 호출부가 `touchConversation`
 * 으로 찍는다 — 메시지든 연락처든, 운영자가 볼 «것»이 DB 에 실제로 남은 다음에만 줄이 올라온다.
 * 새로 만든 행은 `last_message_at` 이 NULL 이고, 목록은 NULL 을 맨 뒤로 보낸다.
 */
export async function upsertConversation(params: {
  botId: string;
  source: string;
  externalUserId: string;
  /** 되돌림을 사람당 1건으로 접는 키. 채널톡만 채운다 */
  channelPersonId?: string;
  /** userChat | group. 채널톡만 채운다 */
  channelChatType?: string;
  /**
   * 방문자가 위젯에서 쓴 언어(en|ko). 위젯 라우트만 채운다 — 요청마다 덮어써서 «가장 최근에 쓴 언어»가 남는다
   * (처음 값을 고정하면, 페이지 언어를 바꾼 방문자가 반영 알림을 옛 언어로 받는다). 카카오·채널톡은 보내지 않아 건드리지 않는다.
   * 칼럼은 20261021_12_conversation_locale.sql — 코드보다 먼저 적용할 것.
   */
  locale?: 'en' | 'ko';
}): Promise<Conversation | null> {
  const { data, error } = await db()
    .from('conversations')
    .upsert(
      {
        bot_id: params.botId,
        source: params.source,
        external_user_id: params.externalUserId,
        ...(params.channelPersonId !== undefined
          ? { channel_person_id: params.channelPersonId }
          : {}),
        ...(params.channelChatType !== undefined
          ? { channel_chat_type: params.channelChatType }
          : {}),
        ...(params.locale !== undefined ? { locale: params.locale } : {}),
      },
      { onConflict: 'bot_id,source,external_user_id' },
    )
    .select('id, bot_id, source, external_user_id, contact_name, contact_email, contact_phone, escalated_at, handoff_requested_at, channel_person_id')
    .single();

  if (error) {
    console.error('[conversations] upsert error:', error.message);
    return null;
  }
  return data;
}

// ── AI 가 못 답한 대화 ──────────────────────────────
//
// ⚠️ "미읽음"으로는 이걸 구별할 수 없다. 메시지가 저장되면 호출부가 touchConversation 으로
//    last_message_at 을 갱신하고 미읽음 판정이 `last_message_at > operator_read_at` 이라,
//    AI 가 답했든 못 답했든 새 메시지가 온 대화는 전부 미읽음이다. 그래서 별도 컬럼을 둔다.

/**
 * 이 결과를 사람이 이어받아야 하는가. 위젯·카카오가 같은 규칙을 쓴다.
 *
 * 인자를 구조적 타입으로 받는다 — handler.ts 를 import 하면 대화 계층이 텔레그램
 * 핸들러에 묶인다. 판정에 필요한 건 세 필드뿐이다.
 *
 * - `null`        LLM 호출 자체가 실패했다
 * - `parsed:false` 출력이 깨졌다. 방문자에겐 아무 말도 못 한다
 * - `escalate`     모델이 스스로 "지식에 없다"고 했다
 * - `response:null` 정상 파싱인데 할 말이 없다 — 결국 방문자는 답을 못 받는다
 */
export function needsEscalation(
  result: { response: string | null; escalate?: boolean; parsed?: boolean } | null | undefined,
): boolean {
  if (!result) return true;
  if (result.parsed === false) return true;
  if (result.escalate === true) return true;
  return result.response === null;
}

/**
 * 사람이 봐야 하는 대화로 표시한다. 이미 표시돼 있으면 시각만 새로 찍는다.
 * 실패를 돌려준다 — 위젯 escalate 라우트는 이 결과로 방문자에게 «성공»이라고 말할지 정한다.
 */
export async function markConversationEscalated(conversationId: string): Promise<boolean> {
  const { error } = await db()
    .from('conversations')
    .update({ escalated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) {
    console.error('[conversations] markEscalated error:', error.message);
    return false;
  }
  return true;
}

/**
 * 위젯 방문자의 대화를 «만들지 않고» 찾는다. 「담당자에게 물어보기」가 쓴다 — 아직 한 마디도
 * 안 한 방문자가 부르면 본문 없는 대화에 지울 수 없는 배지만 남으므로, 그 경로는 대화를 만들면 안 된다.
 */
export async function findWebConversation(
  botId: string,
  visitorId: string,
): Promise<(Conversation & { messageCount: number }) | null> {
  const { data, error } = await db()
    .from('conversations')
    .select(
      'id, bot_id, source, external_user_id, contact_name, contact_email, contact_phone, escalated_at, handoff_requested_at, messages(count)',
    )
    .eq('bot_id', botId)
    .eq('source', 'web')
    .eq('external_user_id', visitorId)
    .maybeSingle();
  if (error) {
    console.error('[conversations] findWeb error:', error.message);
    return null;
  }
  if (!data) return null;
  const { messages, ...conversation } = data as Conversation & { messages: { count: number }[] };
  return { ...conversation, messageCount: messages?.[0]?.count ?? 0 };
}

/**
 * 담당자 안내 칩이 «아직 유효한지» — 가장 최근에 보낸 것이 안내 칩이고 그 뒤로 방문자 발화가 없으면 true.
 * 연타 멱등 판정에 쓴다. 타임라인(200건 상한)의 마지막 항목으로 보면 긴 대화에서 새 칩이 결과 밖으로
 * 밀려 매번 또 쌓이고, responses 만 보면 칩 뒤에 방문자가 새로 말한 뒤 다시 눌렀을 때 칩이 안 붙는다.
 */
export async function hasFreshEscalationNotice(conversationId: string): Promise<boolean> {
  const [resp, msg] = await Promise.all([
    db()
      .from('responses')
      .select('response_type, sent_at')
      .eq('conversation_id', conversationId)
      .not('delivered_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db()
      .from('messages')
      .select('detected_at')
      .eq('conversation_id', conversationId)
      .order('detected_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (resp.error) console.error('[conversations] latestResponse error:', resp.error.message);
  if (msg.error) console.error('[conversations] latestMessage error:', msg.error.message);
  if (!resp.data || resp.data.response_type !== 'system') return false;
  return !msg.data || msg.data.detected_at < resp.data.sent_at;
}

/**
 * 방문자가 «직접» 상담원을 불렀다. escalated_at(배지)과 handoff_requested_at(위젯 상태 줄)을 같이 찍는다.
 * AI 가 물러난 경로는 markConversationEscalated 만 쓴다 — 그쪽은 위젯 상태 줄을 안 켠다.
 */
export async function markHandoffRequested(conversationId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db()
    .from('conversations')
    .update({ escalated_at: now, handoff_requested_at: now })
    .eq('id', conversationId);
  if (error) {
    console.error('[conversations] markHandoffRequested error:', error.message);
    return false;
  }
  return true;
}

/** 사람이 답했으니 해소다. 운영자 답장이 성공한 뒤에만 부른다. 배지와 위젯 상태 줄을 같이 끈다. */
export async function clearConversationEscalated(conversationId: string): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ escalated_at: null, handoff_requested_at: null })
    .eq('id', conversationId);
  if (error) console.error('[conversations] clearEscalated error:', error.message);
}

/**
 * 대화를 목록 맨 위로 끌어올리고 미읽음을 켠다(`last_message_at = now`).
 *
 * **저장이 성공한 뒤에만 부른다** — 방문자 메시지(위젯·채널톡·카카오), 연락처(위젯 「연락처 남기기」·
 * 채널톡 userChat), 말 없는 「상담원 연결」. 우리 쪽 말(운영자·상담원 답장, AI 즉답)은 안 올린다 —
 * 받은편지함 답장이 미읽음을 켜면 안 되기 때문이고, 채널톡 상담원 답장도 같은 규칙이다(2026-09-17 ny).
 * 실패는 로그만 남긴다 — 이미 저장된 메시지를 시각 하나 때문에 되돌리진 않는다.
 */
export async function touchConversation(conversationId: string): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) console.error('[conversations] touch error:', error.message);
}

/** 웹 위젯 방문자가 보낸 메시지를 저장한다. */
export async function saveWebMessage(params: {
  botId: string;
  conversationId: string;
  visitorId: string;
  text: string;
  authorName?: string;
  /** 위젯이 함께 보낸 기술 맥락. 이미 마스킹·상한을 통과한 값만 들어온다. */
  context?: WidgetContext | null;
  /**
   * 요청의 Origin 헤더(200자 상한). **차단하지 않는다 — 사후 판별용이다**(계획 §B-7).
   * 운영자가 여러 도메인(스테이징·커스텀 도메인)을 쓰는 오탐이 커서 막지는 않지만,
   * 남의 사이트가 우리 botId 를 심어 운영자 키를 태우면 어디서 왔는지는 남아야 한다.
   */
  origin?: string | null;
  /** 「상담원 연결」로 남긴 메시지. AI 가 답하지 않고 사람에게 간다(handoff_at). */
  handoff?: boolean;
  widgetHint?: WidgetHint | null;
}): Promise<string | null> {
  // 실패는 «반드시 null» 로 나가야 한다 — 위젯 라우트가 이 값으로 503 을 갈라 방문자에게
  // 재전송을 안내한다(I-23). Gateway Timeout 은 `{error}` 로 왔지만, 던지는 실패(네트워크
  // 예외)도 같은 길로 보낸다. 안 그러면 500 이 나가고 위젯은 일반 실패 문구를 띄운다.
  try {
    const now = new Date().toISOString();
    const { data, error } = await db()
      .from('messages')
      .insert({
        bot_id: params.botId,
        conversation_id: params.conversationId,
        source: 'web',
        external_user_id: params.visitorId,
        author_name: params.authorName || null,
        body: params.text,
        context: params.context ?? null,
        origin: params.origin ?? null,
        detected_at: now,
        handoff_at: params.handoff ? now : null,
        widget_hint: params.widgetHint ?? null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[conversations] saveWebMessage error:', error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error('[conversations] saveWebMessage threw:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 우리가 보내는 것을 저장한다.
 *
 * deliveredAt 이 null 이면 아직 유저에게 못 준 것 = 대기열.
 * 웹은 즉시 화면에 뜨므로 now(), 카카오는 선톡이 안 되니 null 로 두고
 * 그 유저가 다음에 말 걸 때 전달한다.
 */
export async function saveConversationResponse(params: {
  botId: string;
  conversationId: string;
  triggerMessageId?: string | null;
  responseType: string;
  body: string;
  delivered: boolean;
  autoDevRunId?: string | null;
}): Promise<string | null> {
  const { data, error } = await db()
    .from('responses')
    .insert({
      bot_id: params.botId,
      conversation_id: params.conversationId,
      trigger_message_id: params.triggerMessageId ?? null,
      response_type: params.responseType,
      response_body: params.body,
      delivered_at: params.delivered ? new Date().toISOString() : null,
      auto_dev_run_id: params.autoDevRunId ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[conversations] saveResponse error:', error.message);
    return null;
  }
  return data.id;
}

/**
 * 대화의 타임라인 = messages ∪ responses 를 시각순으로.
 *
 * `after` 는 ISO 시각이다. 설계 문서는 "마지막 id" 라고 썼지만 두 테이블을 합치는
 * 구조라 단일 id 커서가 성립하지 않는다.
 *
 * ⚠️ 경계는 **배타(>)** 다(`.gt`). 주석은 오래 「같은 밀리초를 놓치지 않도록 포함(>=)으로
 * 읽는다」고 적혀 있었지만 코드는 그런 적이 없다 — 2026-09-16 에 코드를 정본으로 보고 맞췄다.
 * 남는 성질 둘: 같은 밀리초에 메시지와 응답이 둘 다 생기면 뒤엣것을 놓칠 수 있고(실측된 적 없음),
 * 대신 **이미 받은 항목은 다시 오지 않는다** — 위젯이 되돌림 확인을 로컬에 새겨도 덮이지 않는
 * 근거가 이것이다(`markConfirmed`).
 */
export async function getTimeline(
  conversationId: string,
  after?: string | null,
): Promise<TimelineItem[]> {
  let msgQuery = db()
    .from('messages')
    .select('id, body, detected_at')
    .eq('conversation_id', conversationId);

  let respQuery = db()
    .from('responses')
    // user_confirmation 은 되돌림 카드가 「이미 답했나」를 그리는 데 쓴다. 짧은 열거형이라
    // 5초 폴링에 얹혀도 부담이 없다(FAQ 12KB 를 끌어오던 것과는 다른 종류다).
    .select('id, response_type, response_body, sent_at, delivered_at, user_confirmation')
    .eq('conversation_id', conversationId);

  if (after) {
    msgQuery = msgQuery.gt('detected_at', after);
    respQuery = respQuery.gt('sent_at', after);
  }

  const [msgs, resps] = await Promise.all([
    msgQuery.order('detected_at', { ascending: true }).limit(200),
    respQuery.order('sent_at', { ascending: true }).limit(200),
  ]);

  if (msgs.error) console.error('[conversations] timeline messages:', msgs.error.message);
  if (resps.error) console.error('[conversations] timeline responses:', resps.error.message);

  const items: TimelineItem[] = [
    ...(msgs.data ?? []).map<TimelineItem>((m) => ({
      id: m.id,
      kind: 'user',
      body: m.body,
      at: m.detected_at,
    })),
    // 아직 전달 안 된 것(카카오 대기열)은 웹 타임라인에도 띄우지 않는다.
    ...(resps.data ?? [])
      .filter((r) => r.delivered_at !== null)
      .map<TimelineItem>((r) => ({
        id: r.id,
        kind: responseKind(r.response_type),
        body: r.response_body,
        at: r.sent_at,
        // 되돌림에만 싣는다 — 다른 말풍선에 이 칸이 있으면 위젯이 거기에도 버튼을 그릴 여지가 생긴다
        ...(r.response_type === 'loop_closed'
          ? { confirmation: (r.user_confirmation as ResolutionConfirmation | null) ?? null }
          : {}),
      })),
  ];

  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/**
 * 타임라인의 **마지막 `limit` 턴**만. 즉답 프롬프트의 「최근 대화」 재료다.
 *
 * `getTimeline` 을 쓰면 안 되는 이유: 그쪽은 «오름차순 200건»이라 턴이 200 을 넘는
 * 대화에서는 돌아오는 것이 가장 «오래된» 200턴이다. 뒤에서 8개를 잘라도 방금 한 말이
 * 아니라 옛날 말이 실린다 — 화면(폴링·증분)에는 맞는 쿼리가 프롬프트에는 정반대로 틀린다.
 * 여기서는 각 테이블을 «내림차순 limit» 으로 읽고 합친 뒤 다시 오름차순으로 되돌린다.
 *
 * 미전달 응답(카카오 대기열)을 빼는 규칙은 `getTimeline` 과 같다 — 아직 유저가 못 본
 * 말을 「최근 대화」라고 보여주면 모델이 이미 한 말로 여긴다.
 */
export async function getRecentTurns(
  conversationId: string,
  limit: number,
  before?: string,
): Promise<TimelineItem[]> {
  const [msgs, resps] = await Promise.all([
    db()
      .from('messages')
      .select('id, body, detected_at')
      .eq('conversation_id', conversationId)
      .lte('detected_at', before ?? new Date().toISOString())
      .order('detected_at', { ascending: false })
      .limit(limit),
    db()
      .from('responses')
      .select('id, response_type, response_body, sent_at, delivered_at')
      .eq('conversation_id', conversationId)
      .lte('sent_at', before ?? new Date().toISOString())
      .not('delivered_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(limit),
  ]);

  if (before && (msgs.error || resps.error)) throw new Error('recovery_context_unavailable');
  if (msgs.error) console.error('[conversations] recent messages:', msgs.error.message);
  if (resps.error) console.error('[conversations] recent responses:', resps.error.message);

  const items: TimelineItem[] = [
    ...(msgs.data ?? []).map<TimelineItem>((m) => ({
      id: m.id,
      kind: 'user',
      body: m.body,
      at: m.detected_at,
    })),
    ...(resps.data ?? []).map<TimelineItem>((r) => ({
      id: r.id,
      kind: responseKind(r.response_type),
      body: r.response_body,
      at: r.sent_at,
      responseType: r.response_type,
    })),
  ];

  // 두 갈래를 각각 limit 개씩 가져왔으니 합치면 최대 2×limit 이다. 오름차순으로
  // 되돌린 뒤 뒤에서 limit 개만 남긴다.
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return items.slice(-limit);
}

/** 위젯의 "연락처 남기기". 빈 값은 덮어쓰지 않는다. */
export async function saveContact(
  conversationId: string,
  contact: { name?: string; email?: string; phone?: string },
): Promise<boolean> {
  const patch: Record<string, string> = {};
  if (contact.name?.trim()) patch.contact_name = contact.name.trim();
  if (contact.email?.trim()) patch.contact_email = contact.email.trim();
  if (contact.phone?.trim()) patch.contact_phone = contact.phone.trim();
  if (Object.keys(patch).length === 0) return false;

  const { error } = await db().from('conversations').update(patch).eq('id', conversationId);
  if (error) {
    console.error('[conversations] saveContact error:', error.message);
    return false;
  }
  return true;
}

// ── 받은편지함 ──────────────────────────────────────

export interface InboxItem {
  id: string;
  source: string;
  externalUserId: string;
  contactName: string | null;
  contactEmail: string | null;
  /** 이메일이 없을 때 화면이 보여 줄 연락처. 전화번호만 남긴 리드가 «연락처 없음»으로 뜨지 않게. */
  contactPhone?: string | null;
  lastMessageAt: string | null;
  lastMessageBody: string | null;
  unread: boolean;
  /** 담당자가 봐야 한다 — AI 가 물러났거나 방문자가 직접 불렀다. 미읽음과는 별개다. */
  escalated: boolean;
  ownerEmailStatus?: string | null;
  ownerEmailError?: string | null;
}

/**
 * 운영자가 보는 대화 목록.
 *
 * 미읽음 판정은 `last_message_at > operator_read_at`. 대화가 많아지면
 * 마지막 메시지 본문을 대화별로 한 번씩 읽는 게 부담이 되므로,
 * 후보 대화의 메시지를 한 번에 가져와 메모리에서 접는다.
 */
export async function listConversations(botIds: string[], limit = 100): Promise<InboxItem[]> {
  if (botIds.length === 0) return [];

  const { data: convs, error } = await db()
    .from('conversations')
    .select('id, source, external_user_id, contact_name, contact_email, contact_phone, last_message_at, operator_read_at, escalated_at, owner_email_status, owner_email_error')
    .in('bot_id', botIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    console.error('[conversations] list error:', error.message);
    return [];
  }
  if (!convs || convs.length === 0) return [];

  const { data: msgs, error: msgsError } = await db()
    .from('messages')
    .select('conversation_id, body, detected_at')
    .in('conversation_id', convs.map((c) => c.id))
    .order('detected_at', { ascending: false });

  // 대화마다 가장 최근 것 하나만 남긴다 (정렬이 최신순이라 처음 만난 게 최신)
  const lastBody = new Map<string, string>();
  for (const m of msgs ?? []) {
    if (m.conversation_id && !lastBody.has(m.conversation_id)) {
      lastBody.set(m.conversation_id, m.body ?? '');
    }
  }

  // 메시지 조회가 «실패»했으면 유령 판정을 내리지 않는다 — 대화 전부가 «못 찾음»이 되어 받은편지함이
  // 통째로 비고, 대화 수만큼 재조회가 같은 장애를 두드린다. 본문만 비운 채 종전대로 줄을 남긴다.
  if (msgsError) {
    console.error('[conversations] list messages error:', msgsError.message);
    return convs.map((c) => toInboxItem(c, lastBody.get(c.id) ?? null));
  }

  // 위 한 번의 조회에서 메시지를 못 찾은 대화만 하나씩 다시 본다. 두 경우가 섞여 있다:
  //  (a) 메시지가 많아 PostgREST 행 상한(기본 1000)에 잘려 오래된 대화의 것이 빠진 경우 → 여기서 채운다
  //  (b) 정말 메시지가 0건인 «유령 대화» — 2026-09-17 전엔 upsertConversation 이 저장 «전»에 last_message_at
  //      을 찍어, 메시지 저장이 실패하면(I-23 경로) 빈 미읽음 줄이 남았다(I-29). 지금은 저장 뒤에 찍지만
  //      그때 쌓인 행이 DB 에 남아 있고, 새 행도 upsert 만 성공하면 시각 없이 남는다. 여기서 거른다 —
  //      방문자가 다시 보내면 그때 메시지가 붙어 다시 보인다. **이 필터는 지우지 않는다.**
  //  알려진 한계(2026-09-17 리뷰 🟡): 연락처는 남았는데 touch 가 실패해 last_message_at 이 NULL 인 행은
  //      아래 hasContact 로 살아남되 정렬에서 맨 뒤(nullsFirst:false)·미읽음 꺼짐이라, 대화가 limit 를 넘으면
  //      안 보인다. 정렬 키를 coalesce(last_message_at, created_at) 로 바꾸려면 뷰·RPC 가 필요해 제출 뒤 과제.
  // 못 찾는 대화는 드물어서 추가 왕복은 보통 0건이다. 배치가 행 상한에 잘리면 잘린 만큼 전부 여기로
  // 오므로(최악 목록 크기만큼) 동시 실행을 묶는다 — 한 번에 대화 수만큼 쿼리를 던지지 않는다.
  const missing = convs.filter((c) => !lastBody.has(c.id));
  // 재조회가 «실패»한 대화는 유령이 아니라 «모름»이다 — 거르지 않고 본문 없이 남긴다.
  const unknown = new Set<string>();
  await forEachLimited(missing, LAST_MESSAGE_LOOKUP_CONCURRENCY, async (c) => {
    const { data, error } = await db()
      .from('messages')
      .select('body')
      .eq('conversation_id', c.id)
      .order('detected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[conversations] last message lookup error (${c.id}):`, error.message);
      unknown.add(c.id);
      return;
    }
    // 행이 있으면 메시지가 있는 대화다 — 배치와 같은 기준(본문 null 은 빈 문자열)
    if (data) lastBody.set(c.id, data.body ?? '');
  });

  // 연락처가 붙은 대화는 메시지가 0건이어도 유령이 아니라 «리드»다 — 채널톡 상담 개시(userChat)와 위젯
  // 연락처 라우트는 메시지 없이 대화를 만들고 연락처만 저장하므로, 첫 메시지가 늦거나 저장에 실패해도
  // 운영자가 연락처는 봐야 한다. 유령(I-23 경로)은 연락처가 없다.
  return convs
    .filter((c) => lastBody.has(c.id) || unknown.has(c.id) || hasContact(c))
    .map((c) => toInboxItem(c, lastBody.get(c.id) ?? null));
}

/** 못 찾은 대화 재조회의 동시 실행 상한. 받은편지함 한 페이지(기본 100건)가 통째로 잘려도 10개씩만 나간다. */
export const LAST_MESSAGE_LOOKUP_CONCURRENCY = 10;

/** `items` 를 순서대로 최대 `limit` 개씩 동시에 처리한다. 실패 처리는 `fn` 안에서 끝내야 한다(여기선 거부를 모으지 않는다). */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  // 상한이 0 이하로 들어와도 워커 0개로 «조용히 전부 건너뛰는» 일은 없게 최소 1개
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function hasContact(c: Pick<InboxConvRow, 'contact_name' | 'contact_email' | 'contact_phone'>): boolean {
  return Boolean(c.contact_name?.trim() || c.contact_email?.trim() || c.contact_phone?.trim());
}

type InboxConvRow = {
  id: string;
  source: string;
  external_user_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone?: string | null;
  last_message_at: string | null;
  operator_read_at: string | null;
  escalated_at: string | null;
  owner_email_status?: string | null;
  owner_email_error?: string | null;
};

function toInboxItem(c: InboxConvRow, lastMessageBody: string | null): InboxItem {
  return {
    id: c.id,
    source: c.source,
    externalUserId: c.external_user_id,
    contactName: c.contact_name,
    contactEmail: c.contact_email,
    contactPhone: c.contact_phone ?? null,
    lastMessageAt: c.last_message_at,
    lastMessageBody,
    unread:
      c.last_message_at !== null &&
      (c.operator_read_at === null || c.last_message_at > c.operator_read_at),
    escalated: c.escalated_at !== null,
    ownerEmailStatus: c.owner_email_status ?? null,
    ownerEmailError: c.owner_email_error ?? null,
  };
}

/**
 * 대화의 메시지별 기술 맥락(`messages.context`). **운영자 화면 전용** — 무인증 위젯 GET 이 쓰는
 * `getTimeline` 에는 일부러 안 싣는다(5초 폴링에 얹힐 이유가 없고, html 뼈대가 다른 방문자에게
 * 되돌아갈 이유는 더 없다). 값은 저장 전에 context.ts 가 정규화·마스킹한 것이다.
 */
export async function getMessageContexts(conversationId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db()
    .from('messages')
    .select('id, context')
    .eq('conversation_id', conversationId)
    .not('context', 'is', null)
    .order('detected_at', { ascending: true })
    .limit(200);

  if (error) {
    console.error('[conversations] context lookup error:', error.message);
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const row of data ?? []) {
    if (row.context) out[row.id as string] = row.context;
  }
  return out;
}

/**
 * 이 대화의 메시지가 «어느 사이트에서» 왔는지 (계획 §B-7).
 *
 * 가장 최근에 기록된 Origin 하나만 본다. 목록이 아니라 대화를 «열 때» 한 번만 쓰는 값이라
 * 여기에 왕복 하나를 더해도 받은편지함 목록 성능에는 영향이 없다.
 *
 * 무인증 getTimeline 에 넣지 않는 이유: 그건 위젯 방문자에게도 나가는 응답이다.
 * origin 은 운영자만 볼 정보다.
 */
export async function getConversationOrigin(conversationId: string): Promise<string | null> {
  const { data, error } = await db()
    .from('messages')
    .select('origin')
    .eq('conversation_id', conversationId)
    .not('origin', 'is', null)
    .order('detected_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[conversations] origin lookup error:', error.message);
    return null;
  }
  return (data?.origin as string | null) ?? null;
}

/** 소유권 확인용 — 이 대화가 어느 봇 것인지. */
export async function getConversationOwner(
  conversationId: string,
): Promise<{ id: string; bot_id: string; source: string; external_user_id: string } | null> {
  const { data } = await db()
    .from('conversations')
    .select('id, bot_id, source, external_user_id')
    .eq('id', conversationId)
    .maybeSingle();
  return data ?? null;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ operator_read_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) console.error('[conversations] markRead error:', error.message);
}

// ── 대기열 (카카오) ─────────────────────────────────
//
// 카카오는 선톡이 안 된다. 운영자 답장·되돌림은 `delivered_at = null` 로 쌓아두고
// 그 유저가 다음에 말을 걸 때 응답에 얹어 내보낸다.

export interface QueuedResponse {
  id: string;
  body: string;
}

export async function getUndeliveredResponses(
  conversationId: string,
  limit = 3,
): Promise<QueuedResponse[]> {
  const { data, error } = await db()
    .from('responses')
    .select('id, response_body')
    .eq('conversation_id', conversationId)
    .is('delivered_at', null)
    .order('sent_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[conversations] getUndelivered error:', error.message);
    return [];
  }
  return (data ?? []).map((r) => ({ id: r.id, body: r.response_body }));
}

/**
 * 실제로 내보낸 뒤에만 호출한다.
 * `delivered_at IS NULL` 조건을 걸어 동시 요청 중 하나만 전달로 확정되게 한다.
 */
export async function markResponsesDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db()
    .from('responses')
    .update({ delivered_at: new Date().toISOString() })
    .in('id', ids)
    .is('delivered_at', null);
  if (error) console.error('[conversations] markDelivered error:', error.message);
}

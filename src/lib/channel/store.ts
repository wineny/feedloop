// 채널톡 메시지를 대화 계층에 앉히고 분류한다.
//
// **공용 파일을 한 줄도 고치지 않는다**(설계 §3-(b) C′). `extractResult` 가 `parsed` 플래그를
// 돌려주므로 「출력이 깨졌다」를 밖에서 판별할 수 있고, 그러면 `other` 쓰레기 인사이트를
// 저장하지 않고 버리기만 하면 된다.
//
// 이 경로에서 우리는 **말하지 않는다**(원칙 2). `callLlm` 의 `response` 는 만들어지지만
// 쓰지 않고 버린다 — 답변은 채널톡 ALF·상담원의 몫이다.

import { getServiceRoleClient } from '@/lib/supabase';
import { getBotConfigFromDB } from '@/lib/bot/core';
import { getSystemPrompt } from '@/lib/bot/prompts';
import { callLlm, extractResult } from '@/lib/bot/handler';
import { saveInsight } from '@/lib/bot/db';
import { saveConversationResponse, saveContact } from '@/lib/bot/conversations';
import { checkChannelBudget } from './budget';
import type { ChannelContact } from './payload';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/**
 * 분류 호출의 상한.
 *
 * 채널이 강제하는 마감이 없다 — 웹훅은 이미 200 을 줬고 이 일은 `after()` 안에서 돈다.
 * 그래도 상한은 있어야 한다. 함수 수명(`maxDuration = 60`)을 통째로 붙들면 같은 호출 안의
 * 미전달 되돌림 재시도가 굶는다.
 */
export const CHANNEL_LLM_TIMEOUT_MS = 20_000;

/** PostgreSQL 유니크 위반. `uq_msg_external` 이 웹훅 재전송을 여기서 잡는다. */
const UNIQUE_VIOLATION = '23505';

export interface SaveChannelMessageResult {
  id: string | null;
  /** 같은 `external_message_id` 가 이미 있다. 호출부는 분류를 건너뛴다. */
  duplicate: boolean;
}

/**
 * 유저가 채널톡에 보낸 말을 저장한다.
 *
 * `origin` 은 **NULL 로 둔다.** 그 컬럼은 브라우저 `Origin` 헤더 기록용이고
 * (20260910_01), 서버-투-서버 웹훅에는 해당이 없다. 없는 값을 채우면 「어디서 왔나」를
 * 사후에 판별하려 할 때 그 기록을 오염시킨다.
 */
export async function saveChannelMessage(params: {
  botId: string;
  conversationId: string;
  externalUserId: string;
  externalMessageId: string;
  authorName?: string | null;
  text: string;
  detectedAt?: string | null;
}): Promise<SaveChannelMessageResult> {
  const { data, error } = await db()
    .from('messages')
    .insert({
      bot_id: params.botId,
      conversation_id: params.conversationId,
      source: 'channel',
      external_user_id: params.externalUserId,
      external_message_id: params.externalMessageId,
      author_name: params.authorName || null,
      body: params.text,
      origin: null,
      detected_at: params.detectedAt || new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // 채널톡이 같은 이벤트를 다시 보냈다. 정상이다 — 조용히 건너뛴다.
      return { id: null, duplicate: true };
    }
    console.error(`[channel/${params.botId}] saveMessage error:`, error.message);
    return { id: null, duplicate: false };
  }
  return { id: data.id, duplicate: false };
}

/** 분류가 어디서 끝났는지. 호출부의 로그와 테스트가 이걸 읽는다. */
export type ClassifyOutcome =
  | 'saved'
  | 'no_insight'
  | 'unparsed'
  | 'over_limit'
  | 'llm_failed'
  | 'config_failed';

/**
 * 메시지 하나를 분류해 인사이트로 남긴다. **응답은 만들지도 저장하지도 않는다.**
 *
 * 분류 전용 프롬프트를 따로 두지 않는 이유: 프롬프트가 둘이 되면 골든셋 없이 조용히
 * 갈라진다. 출력 토큰을 조금 더 쓰는 대신 채널 사이에 분류 기준이 하나로 남는다.
 *
 * ⚠️ **BYOK 주의.** `callLlm` 은 운영자가 키를 넣었으면 그 사람의 키·모델·돈으로 나가고,
 * 실패하면 `llm_key_failed_at` 을 찍어 운영자 화면에 「키 확인 필요」 배지를 켠다.
 * **그대로 둔다** — 그 키는 위젯 즉답이 쓰는 바로 그 키이고, 여기서 거부됐다면 실제로
 * 죽은 것이다. 채널톡 경로만 예외로 빼면 운영자는 방문자가 답을 못 받는 순간에야
 * 알게 된다. 배지 문구도 「키가 거부됐어요」처럼 채널 중립이라 오해를 만들지 않는다.
 */
export async function classifyChannelMessage(
  botId: string,
  messageId: string | null,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<ClassifyOutcome> {
  let config;
  try {
    config = await getBotConfigFromDB(botId);
  } catch (err) {
    console.error(
      `[channel/${botId}] config load failed:`,
      err instanceof Error ? err.message : 'unknown',
    );
    return 'config_failed';
  }

  // 선증가 후판정. 상한을 넘으면 **부르지 않는다** — 메시지는 이미 저장된 뒤다.
  const budget = await checkChannelBudget(botId, config);
  if (!budget.allowed) return 'over_limit';

  const raw = await callLlm(config, getSystemPrompt(config.serviceProfile), text, {
    timeoutMs: opts.timeoutMs ?? CHANNEL_LLM_TIMEOUT_MS,
  });
  if (raw === null) return 'llm_failed';

  const result = extractResult(raw);

  // 출력이 깨졌다. 이때 `extractResult` 는 원문 앞부분을 `other` 인사이트로 채워 주는데,
  // 그걸 저장하면 묶기 단계가 그 쓰레기를 사람의 제보와 나란히 놓는다. 버린다.
  if (result.parsed === false) {
    console.warn(`[channel/${botId}] classify output unparsed — insight dropped`);
    return 'unparsed';
  }

  if (!result.insight) return 'no_insight';

  await saveInsight(botId, messageId, result.insight);
  // 자동 묶기(I-10)는 여기서 «걸지 않는다» — 웹훅 라우트가 되돌림 재전송까지 마친 뒤 건다.
  // 여기서 기다리면 대기자(최대 180초)가 그 재전송을 굶긴다(보안 리뷰 H1).
  return 'saved';
}

/**
 * 상담원이 채널톡 데스크에서 답한 것을 타임라인에 남긴다.
 *
 * ⚠️ `markConversationEscalated` 를 **부르지 않는다.** 그건 「AI 가 답을 못 냈다」는
 * 뜻인데 채널톡 경로는 애초에 우리가 답하지 않는다(원칙 2). 부르면 모든 채널톡 대화에
 * 「사람 필요」 배지가 붙어 받은편지함이 전부 빨개진다. `markBotConnected` 미호출과
 * 같은 종류의 결정이다.
 *
 * ⚠️ **알려진 빈틈**: `responses` 에는 `external_message_id` 가 없어 웹훅이 같은 상담원
 * 메시지를 다시 보내면 말풍선이 두 번 남는다. 돈도 인사이트도 늘지 않는 표시상의 문제라
 * 컬럼을 더하는 대신 남겨 뒀다. 본문 대조로 접으면 상담원이 「네」를 두 번 보낸 정상
 * 대화를 삼킨다.
 */
export async function saveManagerReply(params: {
  botId: string;
  conversationId: string;
  body: string;
}): Promise<string | null> {
  return saveConversationResponse({
    botId: params.botId,
    conversationId: params.conversationId,
    responseType: 'operator',
    body: params.body,
    // 이미 유저에게 도착한 말이다. 대기열(delivered_at IS NULL)에 남기지 않는다.
    delivered: true,
  });
}

// ── 대화 메타 ───────────────────────────────────────

/**
 * 유저챗 이벤트가 실어 온 연락처를 대화에 남긴다.
 *
 * 이름·이메일·전화는 공용 `saveContact` 가 쓴다(빈 값은 덮어쓰지 않는다).
 * 여기서 더하는 건 **출처** 한 칸이다 — `veil` 은 채널톡 익명 유저라 이름·이메일이
 * 검증되지 않은 값이고, 화면이 그걸 사실처럼 보여주면 안 된다.
 */
export async function saveChannelContact(
  conversationId: string,
  contact: ChannelContact | null,
): Promise<boolean> {
  if (!contact) return false;

  // 이름·이메일·전화 중 하나라도 «실제로» 남았는가. 호출부가 이 값으로 last_message_at 을 올린다 —
  // 빈 연락처(veil 만 있고 값은 없음)나 저장 실패는 운영자가 볼 리드가 아니다.
  const saved = await saveContact(conversationId, {
    name: contact.name ?? undefined,
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
  });

  const { error } = await db()
    .from('conversations')
    .update({ channel_contact_source: contact.contactSource })
    .eq('id', conversationId);
  if (error) console.error('[channel] contact source update error:', error.message);
  return saved;
}

/**
 * person 키가 아직 비어 있는 대화만 채운다.
 *
 * **덮어쓰지 않는 것이 요점이다.** `IS NULL` 조건이 걸려 있어, 고객의 진짜 `personId` 가
 * 이미 들어 있는 대화에 나중에 상담원 메시지가 와도 값이 바뀌지 않는다.
 *
 * 쓰이는 자리는 하나다 — 고객이 아직 말하지 않은 대화(상담원이 먼저 연 상담 등)에
 * `'chat:'+chatId` 결정적 폴백을 넣어 **NULL 을 남기지 않는 것**. NULL 이면 되돌림
 * 접기와 묶음 「몇 명」이 그 대화를 세지 못한다.
 */
export async function fillChannelPersonKey(
  conversationId: string,
  fallbackKey: string,
): Promise<void> {
  const { error } = await db()
    .from('conversations')
    .update({ channel_person_id: fallbackKey })
    .eq('id', conversationId)
    .is('channel_person_id', null);
  if (error) console.error('[channel] person key fill error:', error.message);
}

/**
 * 채널톡에서 유저챗이 닫히면 우리 대화도 닫는다.
 *
 * 실계정(2026-09-10 E8)에는 **닫힘 스코프가 없다** — 유저챗 이벤트로는 `opened` 만 오고 `closed` 는
 * 영영 안 온다. 대신 **message 이벤트마다 `refers.userChat.state`** 가 실려 오므로 라우트가 그 값을
 * 여기로 넘긴다. 상담원이 종료하며 남긴 마지막 말, 닫힌 채팅에 유저가 다시 건 말이 그 통로다.
 * 아무 말 없이 종료만 하면 다음 메시지가 올 때까지 우리 쪽은 열린 채다 — 그 공백은
 * 받은편지함의 수동 「대화 닫기」가 메운다.
 *
 * 아는 상태만 옮긴다 — 모르는 문자열이 오면 `conversations.status` 를 건드리지 않는다.
 */
export async function syncChannelChatState(
  conversationId: string,
  state: string | null,
): Promise<void> {
  const mapped = state === 'closed' ? 'closed' : state === 'opened' ? 'open' : null;
  if (!mapped) return;

  const { error } = await db()
    .from('conversations')
    .update({ status: mapped })
    .eq('id', conversationId);
  if (error) console.error('[channel] chat state sync error:', error.message);
}

// ── 봇 상태 ─────────────────────────────────────────

/**
 * 채널톡에서 이 봇 앞으로 요청이 «처음» 도달했다.
 *
 * ⚠️ `markBotConnected`(db.ts:181)를 부르지 않는다. 그건 `last_active_at` 을 찍어
 * `isBotConnected` 의 첫 분기를 통과시키는데, 그러면 카카오를 연결한 적도 없는 봇의
 * 카카오 탭이 「연결됐어요」로 바뀐다. 채널은 자기 칸만 쓴다.
 *
 * `IS NULL` 조건을 걸어 최초 1회만 쓴다 — 메시지마다 UPDATE 를 날리지 않는다.
 */
export async function markChannelConnected(botId: string): Promise<void> {
  const { error } = await db()
    .from('bots')
    .update({ channel_connected_at: new Date().toISOString() })
    .eq('id', botId)
    .is('channel_connected_at', null);
  if (error) console.error(`[channel/${botId}] connected mark error:`, error.message);
}

/**
 * `after()` 안에서 터진 것을 남긴다.
 *
 * 이 시점에는 이미 200 을 줬으므로 채널톡은 재전송하지 않는다 — 아무것도 안 하면
 * 제보가 조용히 사라진다. 최소한 «사라졌다는 사실»은 보이게 만든다.
 * 200자로 자른다. 사유 문자열이 길어질 이유가 없고, 무엇이 섞여 있을지 우리가 정하지 않는다.
 */
export async function recordChannelError(botId: string, message: string): Promise<void> {
  const { error } = await db()
    .from('bots')
    .update({
      channel_last_error: message.slice(0, 200),
      channel_last_error_at: new Date().toISOString(),
    })
    .eq('id', botId);
  if (error) console.error(`[channel/${botId}] error record failed:`, error.message);
}

// ── 속도 제한 ───────────────────────────────────────

/** 봇당 분당 채널톡 메시지 상한. 200 을 주기 «전에» 센다. */
export const CHANNEL_RATE_PER_MIN = 120;

/**
 * 무인증 경로라 DB 로 정확히 센다(서버리스라 인메모리는 인스턴스마다 갈린다).
 * `idx_msg_bot_detected` 가 이 조회를 받친다.
 *
 * 채널톡분만 센다 — 활발한 위젯이 채널톡 웹훅을 막으면 안 되고, 그 반대도 마찬가지다.
 * 세는 데 실패하면 **통과시킨다.** 이건 비용이 아니라 유입을 막는 문이고, DB 가 흔들릴 때
 * 제보를 통째로 버리는 쪽이 더 나쁘다. 돈이 걸린 상한은 budget.ts 가 따로 fail-closed 로 막는다.
 *
 * ⚠️ **`detected_at` 은 라우트가 서버 시각으로 클램프한 값이어야 한다.** 페이로드의
 * `createdAt` 을 그대로 저장하면 과거 시각을 반복 POST 하는 것만으로 이 카운터가 0 에
 * 머문다(`clampDetectedAt`). `created_at DEFAULT now()` 를 세면 위조가 원천 차단되지만
 * 거기엔 인덱스가 없어 봇당 전량 스캔이 된다 — 클램프 쪽을 골랐다.
 *
 * 세는 대상은 `messages` 행뿐이다. 유저챗 생성·상담원 답장 이벤트는 여기에 안 잡힌다 —
 * 그 둘은 LLM 을 태우지 않으므로 수용한 빈틈이다.
 */
export async function channelRateExceeded(botId: string): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await db()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', botId)
    .eq('source', 'channel')
    .gte('detected_at', since);

  if (error) {
    console.error(`[channel/${botId}] rate check error:`, error.message);
    return false;
  }
  return (count ?? 0) >= CHANNEL_RATE_PER_MIN;
}

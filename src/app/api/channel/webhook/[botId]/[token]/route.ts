// 채널톡(Channel.io) 웹훅 — 두 번째 입구
// POST /api/channel/webhook/{botId}/{token}
//
// **우리는 이 채널로 답하지 않는다**(원칙 2). 유저 메시지를 받아 분류만 하고, 답변은
// 채널톡 ALF·상담원의 몫이다. 여기서 나가는 유일한 말은 되돌림(`loop_closed`)이다.
//
// 무인증 경로다(원칙 3). 토큰 세그먼트 · 크기 상한 · UUID 검사 · DB 속도 제한을 전부
// 통과해야 본 처리가 시작된다. 그리고 **거절은 전부 404 다** — 401 은 "봇은 있는데 키가
// 틀렸다"를 알려주므로, 남의 봇 id 를 찍어보는 사람에게 답을 주게 된다.

import { NextRequest, NextResponse, after } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { isUuid } from '@/lib/widget/http';
import { readBoundedJson } from '@/lib/http/body';
import {
  matchesWebhookToken,
  matchesChannelId,
  matchesVerifyToken,
  isWebhookTokenShape,
} from '@/lib/channel/verify';
import {
  parseChannelEvent,
  personKeyFor,
  readChannelId,
  type ChannelEvent,
} from '@/lib/channel/payload';
import {
  saveChannelMessage,
  classifyChannelMessage,
  saveManagerReply,
  saveChannelContact,
  syncChannelChatState,
  markChannelConnected,
  recordChannelError,
  channelRateExceeded,
  fillChannelPersonKey,
} from '@/lib/channel/store';
import { scheduleAutoGrouping } from '@/lib/groups/auto-grouping';
import { retryUndelivered } from '@/lib/channel/redeliver';
import { touchConversation, upsertConversation } from '@/lib/bot/conversations';

/** `after()` 안에서 분류(LLM)와 미전달 되돌림 재시도가 돈다. */
// 즉시 200 + after(): 분류(30초 예산) → 되돌림 재전송 → 자동 묶기 대기자(최대 180초 + 묶기 100초).
export const maxDuration = 300;

/** 위젯과 같은 64KB. 채널톡 페이로드는 수 KB 라 넉넉하다. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * 미래 쪽으로만 인정하는 창. 채널톡·우리 서버의 시계 차이를 흡수한다.
 *
 * 미래 값은 속도 제한을 피하지 못한다 — 최근 60초를 세는 창에 «항상» 들어오기 때문이다.
 * 그래서 여기만 여유를 둔다.
 */
const DETECTED_AT_FUTURE_TOLERANCE_MS = 60_000;

/**
 * 제보자가 보낸 시각을 서버 시각으로 클램프한다.
 *
 * **속도 제한이 이 값을 센다.** `channelRateExceeded` 가 최근 60초의 `detected_at` 을
 * 세는데, 그 값이 페이로드의 `entity.createdAt` 그대로면 과거 시각을 반복 POST 하는
 * 것만으로 카운터가 0 에 머문다 — 무인증 경로에서 상한이 통째로 무력해진다.
 *
 * ⚠️ **과거는 한 순간도 허용하지 않는다.** 처음엔 5분을 뒀는데 그건 속도 제한 창(60초)보다
 * 넓어서 `now − 120초` 를 박고 messageId 만 바꿔 돌리면 그대로 다시 뚫린다. 허용 폭이
 * 창보다 좁아야 한다는 조건은 곧 「0 이어야 한다」와 같다.
 *
 * 대가는 표시 순서다. 늦게 도착한 웹훅은 «말한 순서» 가 아니라 «도착 순서» 로 기록된다.
 * 채널톡이 재전송하거나 우리 함수가 콜드스타트면 몇 초씩 밀릴 수 있다.
 * **표시 순서보다 속도 제한의 정확성을 택했다** — 순서가 조금 어긋난 타임라인은 읽을 수
 * 있지만, 세지 못하는 상한은 상한이 아니다.
 */
function clampDetectedAt(createdAt: string | null): string {
  const now = Date.now();
  if (createdAt) {
    const t = new Date(createdAt).getTime();
    if (Number.isFinite(t) && t >= now && t <= now + DETECTED_AT_FUTURE_TOLERANCE_MS) {
      return createdAt;
    }
  }
  return new Date(now).toISOString();
}

/**
 * 존재를 알리지 않는다. 봇이 없든, 토큰이 틀렸든, 채널 id 가 안 맞든 전부 같은 404 다.
 */
function notFound() {
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

/** 채널톡에게는 늘 처리했다고 말한다 — 재전송을 부르지 않기 위해서다. */
function accepted(extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...extra });
}

interface ChannelBot {
  id: string;
  status: string;
  channel_webhook_token_encrypted: string | null;
  /** 운영자가 붙여넣은 채널톡 `?token=` 값. NULL 이면 대조하지 않는다. */
  channel_webhook_verify_token_encrypted: string | null;
  channel_id: string | null;
}

async function loadBot(botId: string): Promise<ChannelBot | null> {
  const { data } = await getServiceRoleClient()
    .from('bots')
    .select('id, status, channel_webhook_token_encrypted, channel_webhook_verify_token_encrypted, channel_id')
    .eq('id', botId)
    .single();

  if (!data || data.status === 'paused') return null;
  return data as ChannelBot;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string; token: string }> },
) {
  const { botId, token } = await params;

  // 1·2. 형식이 아니면 DB 를 읽지도 않는다.
  if (!isUuid(botId) || !isWebhookTokenShape(token)) return notFound();

  const bot = await loadBot(botId);
  if (!bot) return notFound();

  // 3. 시크릿 세그먼트. 복호화 후 상수 시간 비교.
  if (!matchesWebhookToken(token, bot.channel_webhook_token_encrypted)) return notFound();

  // 3-b. 채널톡이 `?token=` 으로 붙여 보내는 웹훅 토큰(실측 E2). 운영자가 저장해 둔 경우에만
  //      대조한다. 겹이 되는 경우는 **복사한 URL·캡처가 유출**됐을 때다 — 요청 로그는 쿼리도 함께
  //      남기므로 그 통로에는 겹이 아니다. 거절은 역시 404 다. 「경로는 맞는데 쿼리가 틀렸다」를
  //      알려주지 않는다. 다만 이 거절은 본문 읽기 전이라 `channel_last_error` 에도 안 남는다 —
  //      우리가 아직 못 본 채널톡 동작(토큰 안 붙는 이벤트·채널톡 쪽 갱신)이 전부 조용한 404 가
  //      되므로 값 없이 봇 id 만 한 줄 남긴다.
  if (!matchesVerifyToken(req.nextUrl.searchParams.get('token'), bot.channel_webhook_verify_token_encrypted)) {
    console.warn(`[channel/${botId}] webhook query token mismatch`);
    return notFound();
  }

  // 4. 본문을 읽기 «전에» 크기부터 본다.
  const body = await readBoundedJson<unknown>(req, MAX_WEBHOOK_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.reason }, { status: body.status });
  }

  // 5. 페이로드가 채널 id 를 실어 보내면 대조한다. 없으면 검사하지 않는다.
  if (!matchesChannelId(readChannelId(body.value), bot.channel_id)) return notFound();

  // 6. 무인증 경로의 유입 제한. 200 을 주기 전에 센다.
  if (await channelRateExceeded(botId)) {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 });
  }

  // 7. 판별할 수 없는 이벤트는 만들지 않는다.
  const event = parseChannelEvent(body.value);
  if (!event) return accepted({ ignored: 'unknown_type' });

  // 8. ★ 그룹 챗은 **아무 행도 만들지 않는다.**
  //    봇 메시지 전송 API 는 user-chats 전용이라, 그룹 대화에 되돌림이 생기면 영원히
  //    실패하며 delivery_attempts 5회를 태운 뒤 조용히 포기한다. 애초에 안 만든다.
  if (event.kind !== 'user' && event.chatType !== 'userChat') {
    return accepted({ ignored: 'not_user_chat' });
  }

  // 파일만 보낸 메시지. 저장할 본문도 분류할 것도 없다.
  if (event.kind === 'message' && event.plainText.trim() === '') {
    return accepted({ ignored: 'empty_text' });
  }

  // 9. 즉시 200. 나머지는 응답 뒤에 돈다 — 채널톡을 기다리게 하지 않는다.
  after(handleEvent(botId, event));
  return accepted({ accepted: event.kind });
}

/**
 * 본 처리. 여기서 터진 것은 채널톡에 전달되지 않는다(이미 200 을 줬다) —
 * 그래서 최상위에서 잡아 봇에 흔적을 남긴다. 안 그러면 제보가 조용히 사라진다.
 */
async function handleEvent(botId: string, event: ChannelEvent): Promise<void> {
  try {
    // 연결 표시. `markBotConnected` 가 아니라 채널 전용 칸이다(store.ts 주석 참고).
    await markChannelConnected(botId);

    if (event.kind === 'message') return await handleMessage(botId, event);
    if (event.kind === 'userChat') return await handleUserChat(botId, event);
    // User 이벤트는 연락처 갱신인데, 어느 대화에 붙일지는 챗 이벤트가 정한다.
    // 대화 없이 사람만 아는 상태로는 남길 곳이 없어 지금은 건너뛴다.
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    console.error(`[channel/${botId}] webhook processing failed:`, message);
    await recordChannelError(botId, message).catch(() => {});
  }
}

async function handleMessage(
  botId: string,
  event: Extract<ChannelEvent, { kind: 'message' }>,
): Promise<void> {
  // ALF(채널톡 자체 AI)가 한 말은 기록하지 않는다. 우리 루프의 재료가 아니다.
  if (event.personType === 'bot') return;

  // ⚠️ `Message.personId` 는 **그 메시지를 쓴 사람**이다. 고객일 때만 person 키로 쓴다.
  //    상담원 메시지의 personId 를 실으면 그 상담원이 처리하는 모든 대화가 한 키로
  //    수렴해, 되돌림이 N개 대화에 1건만 나가고 남의 유저챗으로 전송되며 묶음
  //    「몇 명」이 무너진다. 상담원은 하루에 수십 명을 상대한다.
  const isCustomer = event.personType === 'user';

  const conversation = await upsertConversation({
    botId,
    source: 'channel',
    externalUserId: event.chatId,
    // 고객이 말했을 때만 싣는다. **같은 upsert 에 싣는 이유**는 뒤이어 갱신하면
    // 그 갱신이 실패했을 때 NULL 이 남기 때문이다(설계 §3-(a)).
    // 고객이 아니면 키를 아예 보내지 않는다 — payload 에 없으면 이미 저장된 고객
    // personId 를 덮어쓰지 않는다.
    ...(isCustomer ? { channelPersonId: personKeyFor(event) ?? undefined } : {}),
    channelChatType: event.chatType,
  });
  if (!conversation) return;

  // 고객이 아직 말하지 않은 대화(상담원이 먼저 연 상담)는 키가 비어 있다.
  // 결정적 폴백으로 채워 NULL 을 남기지 않는다. 이미 값이 있으면 건드리지 않는다.
  if (!conversation.channel_person_id) {
    await fillChannelPersonKey(conversation.id, `chat:${event.chatId}`);
  }

  // 닫힘은 여기서만 알 수 있다 — 채널톡에 닫힘 스코프가 없어 유저챗 이벤트로는 영영 안 온다(실측 E8).
  // 고객·상담원 가리지 않고 `refers.userChat.state` 를 맞춘다. 모르는 상태(`initial`·`snoozed`)는 건드리지 않는다.
  // ⚠️ 미확인: 이 값이 «메시지 이후» 상태인지 «직전» 상태인지 실물로 못 봤다(픽스처는 initial 하나, E7 은 closed).
  //    직전 상태라면 닫힌 채팅에 들어온 새 제보가 대화를 다시 닫는다. 영향은 받은편지함의 「닫힘」 배지·
  //    「대화 닫기」 버튼 노출뿐이다(필터·답장 차단 없음). 재개 전이는 E4·E5 측정 때 같이 본다.
  await syncChannelChatState(conversation.id, event.chatState);

  if (event.personType === 'manager') {
    await saveManagerReply({ botId, conversationId: conversation.id, body: event.plainText });
    return;
  }

  const saved = await saveChannelMessage({
    botId,
    conversationId: conversation.id,
    externalUserId: event.chatId,
    externalMessageId: event.messageId,
    text: event.plainText,
    // 남이 보낸 시각을 그대로 쓰면 속도 제한이 무력해진다(clampDetectedAt 주석 참고).
    detectedAt: clampDetectedAt(event.createdAt),
  });

  // 재전송이면 분류하지 않는다. 같은 제보로 인사이트가 둘이 되면 묶음도 둘이 된다.
  if (saved.duplicate || !saved.id) return;

  // 메시지가 «남은 뒤» 시각을 찍는다(I-29 근본 원인). 재전송·저장 실패는 위에서 끊겨 안 올라간다.
  // 상담원 답장(manager)은 위에서 return — 우리 쪽 말은 미읽음을 켜지 않는다(2026-09-17 ny).
  await touchConversation(conversation.id);

  const outcome = await classifyChannelMessage(botId, saved.id, event.plainText);

  // 유저가 다시 말을 걸었다 — 밀려 있던 되돌림을 지금 얹는다(설계 §3-(e) B).
  await retryUndelivered(conversation.id);

  // I-10 — 인사이트가 생겼으면 자동 묶기. 채널톡은 문의·칭찬도 «자동 닫힘» 대상이라 분류를 안 가린다.
  // 되돌림 재전송 «뒤»여야 한다 — 대기자로 뽑히면 최대 180초를 자므로 앞에 두면 재전송이 굶는다.
  if (outcome === 'saved') {
    try {
      // 대기 상한은 위젯(180초)보다 짧게 — 앞에 분류 30초 + 재전송이 있어 180 이면 최악 경로가 300초를 스친다.
      await scheduleAutoGrouping(botId, { maxWaitMs: 120_000 });
    } catch (err) {
      console.error(`[channel/${botId}] auto grouping failed:`, err instanceof Error ? err.message : err);
    }
  }
}

async function handleUserChat(
  botId: string,
  event: Extract<ChannelEvent, { kind: 'userChat' }>,
): Promise<void> {
  const conversation = await upsertConversation({
    botId,
    source: 'channel',
    externalUserId: event.chatId,
    channelPersonId: personKeyFor(event) ?? undefined,
    channelChatType: event.chatType,
  });
  if (!conversation) return;

  // 상담 개시엔 메시지가 없다. 연락처가 실제로 남았을 때만 시각을 찍어 리드로 올린다(2026-09-17 ny) —
  // 연락처도 없으면 빈 줄이라, 첫 메시지 이벤트가 올 때 그쪽에서 올라간다.
  const contactSaved = await saveChannelContact(conversation.id, event.contact);
  if (contactSaved) await touchConversation(conversation.id);
  await syncChannelChatState(conversation.id, event.state);
}

/** 온보딩 화면의 warm-up. 토큰 세그먼트가 없으면 이 경로 자체가 존재하지 않는다. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ botId: string; token: string }> },
) {
  const { botId, token } = await params;

  if (!isUuid(botId) || !isWebhookTokenShape(token)) return notFound();
  const bot = await loadBot(botId);
  if (!bot || !matchesWebhookToken(token, bot.channel_webhook_token_encrypted)) return notFound();

  return NextResponse.json({ status: 'ok', channel: 'channel', botId });
}

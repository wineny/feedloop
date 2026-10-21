// 위젯의 「상담원 연결」 — 무인증, CORS 개방 (백로그 B2 v2, 2026-09-13).
//
// 방문자가 직접 부른다: conversations.escalated_at(받은편지함 「담당자 확인 필요」 배지)과
// handoff_requested_at(위젯 하단 「상담원에게 전달됐어요」)이 같이 찍힌다. AI 가 스스로 물러나는 경로
// (needsEscalation → markConversationEscalated)는 배지만 켜고 위젯 상태 줄은 안 켠다 — 그건
// 방문자가 이 라우트를 «눌렀을 때만» 켜진다(2026-09-16 ny 결정).
// v2 에서 달라진 것(리서치 문서 docs/14-셀프QA/리서치-AI→상담원-연결-패턴-2026-09-13.md):
//  - «내용이 같이 간다» — text 가 오면 messages 에 handoff_at 을 찍어 저장하고 AI 는 답하지 않는다.
//    안내 칩이 그 문장을 인용해 «무엇을» 넘겼는지 말한다
//  - «봇 소유자에게 메일» — after() 로 emailOwnerHandoff(같은 대화 1시간 1통)
//  - «기대치» — 봇 status_text 를 안내에 싣는다
// 운영자 답장이 성공하면 reply 라우트가 둘 다 지운다.

import { NextRequest, after } from 'next/server';
import { escalationNotice } from '@/lib/bot/holding';
import { defaultStatusText, widgetLocale } from '@/lib/widget/strings';
import {
  findWebConversation,
  getRecentTurns,
  getTimeline,
  hasFreshEscalationNotice,
  markHandoffRequested,
  saveContact,
  saveConversationResponse,
  saveWebMessage,
  touchConversation,
  upsertConversation,
  type Conversation,
  type TimelineItem,
} from '@/lib/bot/conversations';
import { emailOwnerHandoff } from '@/lib/email/notify';
import { collapseWhitespace } from '@/lib/text';
import { sanitizeWidgetContext } from '@/lib/widget/context';
import { settleMessageShot } from '@/lib/widget/shots';
import {
  MAX_BODY_CHARS,
  checkWriteRate,
  isUuid,
  readJsonBody,
  resolveWidgetBot,
  widgetError,
  widgetJson,
  widgetOptions,
} from '@/lib/widget/http';

const MAX_FIELD = 200;
const MAX_ORIGIN_CHARS = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const OPTIONS = widgetOptions;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;
  const locale = widgetLocale(req);

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError(req, 'bot_not_found', 404);

  const body = await readJsonBody<{ visitorId?: unknown; text?: unknown; name?: unknown; email?: unknown; context?: unknown }>(req);
  if (!body.ok) return body.response;

  const { visitorId } = body.value;
  if (!isUuid(visitorId)) return widgetError(req, 'invalid_visitor', 400);

  // 상담원에게 남길 말(선택). 있으면 그 자체가 메시지다.
  const text = typeof body.value.text === 'string' ? body.value.text.trim() : '';
  if (text.length > MAX_BODY_CHARS) return widgetError(req, 'message_too_long', 400, { max: MAX_BODY_CHARS });

  // 연락처(선택) — contact 라우트와 같은 규칙. 개행은 접는다(분류 프롬프트에 레코드 경계로 읽힌다).
  const field = (v: unknown) => {
    if (typeof v !== 'string') return undefined;
    const clean = collapseWhitespace(v).slice(0, MAX_FIELD);
    return clean !== '' ? clean : undefined;
  };
  const name = field(body.value.name);
  const email = field(body.value.email);
  if (email && !EMAIL_RE.test(email)) return widgetError(req, 'email_invalid', 400);

  // IP 기준 제한. 방문자 기준(messages 행 수)은 text 가 있을 때만 메시지를 만들어 그쪽에 잡힌다.
  const limited = await checkWriteRate(req, botId, visitorId);
  if (limited) return limited;

  // 삽입 «전» 시각에서 몇 초 물러난 커서 — 응답엔 타임라인 전량이 아니라 이번에 생긴 것만 싣는다.
  const since = new Date(Date.now() - 5_000).toISOString();

  let conversation: Conversation | null;
  let messageId: string | null = null;
  if (text) {
    // 내용이 있으면 대화를 만들어도 된다 — 운영자가 받을 «말»이 있다.
    conversation = await upsertConversation({ botId, source: 'web', externalUserId: visitorId, locale });
    if (!conversation) return widgetError(req, 'conversation_failed', 500);
    if (name || email) await saveContact(conversation.id, { name, email });
    const handoffContext = sanitizeWidgetContext(body.value.context);
    messageId = await saveWebMessage({
      botId,
      conversationId: conversation.id,
      visitorId,
      text,
      authorName: name ?? conversation.contact_name ?? undefined,
      // 기술 맥락(페이지 URL·콘솔 에러) — 상담원 연결로 들어온 제보도 자동 PR 그라운딩 재료를 잃지 않게
      context: handoffContext,
      origin: req.headers.get('origin')?.slice(0, MAX_ORIGIN_CHARS) ?? null,
      handoff: true,
    });
    if (!messageId) return widgetError(req, 'message_save_failed', 500);
    // 「화면에서 선택하기」 스크린샷(I-55) — messages 라우트와 같은 규칙으로 붙이거나 뗀다.
    // 지금 위젯의 상담원 연결은 target 을 싣지 않아 늘 그냥 돌아온다 — 싣게 되면 그대로 동작하도록 둔 방어선
    // (남의 shotId 가 context 에 남지 않게)
    await settleMessageShot({ botId, visitorId, messageId, context: handoffContext });
  } else {
    // 말 없이 버튼만 — 대화를 «만들지 않는다». 한 마디도 안 한 방문자가 부르면 본문 없는 대화에
    // «답장을 보내야만 꺼지는» 배지가 남아 진짜 건을 밀어낸다(보안 리뷰 M1).
    const found = await findWebConversation(botId, visitorId);
    if (!found || found.messageCount === 0) return widgetError(req, 'message_first', 400);
    conversation = found;
  }
  // 두 갈래 다 여기서 끌어올린다. 말이 있으면 «저장이 성공한 뒤»여야 유령 대화가 안 생기고(I-29 근본 원인),
  // 말이 없으면 메시지가 안 생겨 시각이 안 오르므로 — 받은편지함 목록(최근 100건)에서 밀려나
  // 알림 메일의 딥링크가 못 찾는 일이 없게 여기서 올린다.
  await touchConversation(conversation.id);
  // 이 경로는 AI 즉답을 안 부르므로 realtime 인사이트도 안 생긴다 — 상담원이 읽을 말이지 제보가 아니다.
  // 버그 제보라면 배치 [분류] 가 다른 메시지와 같이 줍는다(handoff_at 은 기록용이고 배치는 가리지 않는다).

  // 멱등 판정은 «방문자가 이미 불렀나»다. AI 가 먼저 물러나 escalated_at 만 있는 대화는 아직 안 부른 것 —
  // 여기서 처음 handoff_requested_at 이 찍히고 위젯 상태 줄이 켜진다.
  const already = conversation.handoff_requested_at !== null && conversation.handoff_requested_at !== undefined;
  if (!already) {
    const marked = await markHandoffRequested(conversation.id);
    // 실패를 성공으로 포장하지 않는다 — 위젯은 escalated:true 를 받으면 버튼을 감춘다.
    if (!marked) return widgetError(req, 'handoff_failed', 500);
  }

  // 안내 칩. 말을 남겼으면 늘 붙고(새 내용), 버튼만이면 직전 칩이 아직 유효할 때 또 안 쌓는다(연타 멱등).
  let quote: string | null = text || null;
  if (!quote) {
    const turns = await getRecentTurns(conversation.id, 8).catch(() => []);
    quote = [...turns].reverse().find((t) => t.kind === 'user')?.body ?? null;
  }
  const hasEmail = !!(email || conversation.contact_email);
  let items: TimelineItem[] = [];
  if (text || !(await hasFreshEscalationNotice(conversation.id))) {
    // 저장에 실패해도 handoff_requested_at 은 이미 찍혔다 — 상태가 본체고 칩은 기록이라 500 으로 되돌리지 않는다.
    await saveConversationResponse({
      botId,
      conversationId: conversation.id,
      triggerMessageId: messageId,
      responseType: 'system',
      body: escalationNotice({
        locale,
        quote,
        hasEmail,
        statusText: bot.status_text ?? defaultStatusText(locale),
      }),
      delivered: true,
    });
  }
  items = await getTimeline(conversation.id, since);

  // 봇 소유자에게 알림. 응답을 기다리게 하지 않는다. 절대 throw 하지 않는다(notify.ts).
  const conversationId = conversation.id;
  after(emailOwnerHandoff({ botId, conversationId, requestBody: text || null }));

  return widgetJson({
    conversationId,
    escalated: true,
    already,
    items,
    contact: {
      name: name ?? conversation.contact_name,
      email: email ?? conversation.contact_email,
      phone: conversation.contact_phone,
    },
  });
}

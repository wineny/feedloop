// 운영자 답장.
//
// 웹 위젯은 폴링으로 바로 받아가므로 즉시 전달로 찍는다.
// 카카오는 선톡이 안 되니 delivered_at 을 비워 대기열에 남기고,
// 그 유저가 다음에 말을 걸 때 웹훅이 앞에 붙여 내보낸다.
// 채널톡은 답장 창구가 데스크 하나뿐이다 — 여기서는 받지 않고 그쪽 링크를 돌려준다.

import { NextResponse } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { getChannelDeskUrl } from '@/lib/bot/channel-registration';
import {
  clearConversationEscalated,
  getConversationOwner,
  saveConversationResponse,
} from '@/lib/bot/conversations';
import { describeReplyDelivery, emailResponse } from '@/lib/email/notify';
import { apiText } from '@/lib/http/api-text';
import { localeFromRequest } from '@/i18n/server-locale';

const MAX_REPLY_CHARS = 2000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;

  const conversation = await getConversationOwner(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: apiText(req, 'conversationNotFound') }, { status: 404 });
  }

  const auth = await resolveAccessibleBots(conversation.bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  // 승인자(bot_members)는 받은편지함을 «보고» 환불을 승인·거절할 수만 있다. 방문자에게 말을 거는 것은
  // 소유자의 일이다 — 본문을 읽기 전에 끊어 저장 경로에 닿지 않게 한다(3단계 6/6).
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: apiText(req, 'ownerOnly') }, { status: 403 });
  }

  // 채널톡은 답을 데스크에서 한다(§3-(d) A). 답장 창구가 둘이 되면 「누가 이미 답했나」가
  // 흐려진다 — 카카오 대기열 리허설에서 겪은 실패다. 본문을 읽기 전에 끊어 저장 경로에
  // 아예 닿지 않게 한다. 아래 clearConversationEscalated 도 여기서 멈춰 닿지 않는데,
  // 채널톡 대화는 escalated_at 을 애초에 찍지 않으므로 지울 것도 없다.
  if (conversation.source === 'channel') {
    const deskUrl = await getChannelDeskUrl(conversation.bot_id, conversation.external_user_id);
    return NextResponse.json(
      { error: apiText(req, 'channelTalkReplyElsewhere'), deskUrl },
      { status: 409 },
    );
  }

  let payload: { text?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: apiText(req, 'badRequest') }, { status: 400 });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: apiText(req, 'replyEmpty') }, { status: 400 });
  }
  if (text.length > MAX_REPLY_CHARS) {
    return NextResponse.json(
      { error: apiText(req, 'replyTooLong', { max: MAX_REPLY_CHARS }) },
      { status: 400 },
    );
  }

  const immediate = conversation.source === 'web';

  const id = await saveConversationResponse({
    botId: conversation.bot_id,
    conversationId,
    responseType: 'operator',
    body: text,
    delivered: immediate,
  });

  if (!id) {
    return NextResponse.json({ error: apiText(req, 'replySaveFailed') }, { status: 500 });
  }

  // 사람이 답했으니 「담당자 확인 필요」은 해소다. 저장이 «성공한 뒤에만» 지운다.
  // 카카오라 아직 전달 전이어도 마찬가지다 — 운영자가 할 일은 이미 끝났고,
  // 남은 건 그 유저가 다음에 말을 거는 것뿐이다.
  await clearConversationEscalated(conversationId);

  // 연락처 폼에 이메일을 남긴 방문자에게는 메일로도 보낸다 — 위젯은 사이트를 다시 열어야
  // 보이지만 메일은 지금 닿는다. 채널과 무관하다(카카오 대화도 이메일이 있으면 간다).
  // 실패해도 답장은 이미 저장·전달됐다 — 결과는 안내 문구로만 말한다.
  const email = await emailResponse({
    kind: 'operator',
    responseId: id,
    conversationId,
    botId: conversation.bot_id,
    body: text,
  });

  return NextResponse.json({
    id,
    delivered: immediate,
    emailed: email.sent,
    // 카카오는 "보냈다"고 말하면 거짓이다. 언제 가는지 화면이 정확히 알려야 한다.
    notice: describeReplyDelivery(immediate, email, localeFromRequest(req)),
  });
}

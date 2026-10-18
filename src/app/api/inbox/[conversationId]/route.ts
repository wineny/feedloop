// 대화 하나의 타임라인. 열어보는 행위가 곧 "읽음"이다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getChannelDeskUrl } from '@/lib/bot/channel-registration';
import { getServiceRoleClient } from '@/lib/supabase';
import {
  getConversationOrigin,
  getConversationOwner,
  getMessageContexts,
  getTimeline,
  markConversationRead,
} from '@/lib/bot/conversations';
import { signShotsForMessages } from '@/lib/widget/shots';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;

  const conversation = await getConversationOwner(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: '대화를 찾을 수 없습니다' }, { status: 404 });
  }

  // 남의 대화를 열 수 없게 봇 소유권으로 막는다.
  const auth = await resolveOwnedBots(conversation.bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // 운영자만 보는 값이라 무인증 getTimeline 이 아니라 여기서 따로 읽는다(계획 §B-7).
  // contexts 도 같은 이유로 여기서만 — 제보 시점 페이지·기기와 「화면에서 짚기」로 고른 요소(B3).
  const [items, origin, contexts] = await Promise.all([
    getTimeline(conversationId),
    getConversationOrigin(conversationId),
    getMessageContexts(conversationId),
  ]);
  await markConversationRead(conversationId);

  // 「화면에서 선택하기」 스크린샷(I-55) — 소유 확인을 지난 뒤에만, 10분짜리 서명 URL 로. 무인증 getTimeline 엔 없다
  const shotIds = Object.entries(contexts)
    .filter(([, c]) => Boolean((c as { target?: { shot?: unknown } } | null)?.target?.shot))
    .map(([id]) => id);
  const shots = await signShotsForMessages(shotIds, [conversation.bot_id]);

  // 채널톡은 화면에 입력창 대신 데스크 링크를 띄운다. 다른 채널은 읽을 이유가 없어 건너뛴다.
  const deskUrl =
    conversation.source === 'channel'
      ? await getChannelDeskUrl(conversation.bot_id, conversation.external_user_id)
      : null;

  // 닫힘 여부. 「대화 닫기」 버튼을 이미 닫힌 대화에 또 보여주지 않으려고 함께 싣는다.
  const { data: state } = await getServiceRoleClient()
    .from('conversations')
    .select('status')
    .eq('id', conversationId)
    .maybeSingle();

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      source: conversation.source,
      externalUserId: conversation.external_user_id,
      origin,
      deskUrl,
      status: (state as { status?: string } | null)?.status ?? 'open',
    },
    items,
    contexts,
    shots,
  });
}

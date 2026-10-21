// 대화 하나의 타임라인. 열어보는 행위가 곧 "읽음"이다.

import { NextResponse } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
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
import { toPaymentActionView } from '@/lib/paypal/action-view';
import { supabasePaymentsStore } from '@/lib/paypal/store';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;

  const conversation = await getConversationOwner(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: '대화를 찾을 수 없습니다' }, { status: 404 });
  }

  // 남의 대화를 열 수 없게 봇 접근권(소유자 또는 승인자)으로 막는다.
  const auth = await resolveAccessibleBots(conversation.bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // 운영자만 보는 값이라 무인증 getTimeline 이 아니라 여기서 따로 읽는다(계획 §B-7).
  // contexts 도 같은 이유로 여기서만 — 제보 시점 페이지·기기와 「화면에서 짚기」로 고른 요소(B3).
  // 결제 행(환불 요청·승인 카드, 3단계)도 같은 묶음. 못 읽으면 빈 목록 — 대화는 보여야 한다.
  const [items, origin, contexts, paymentActions] = await Promise.all([
    getTimeline(conversationId),
    getConversationOrigin(conversationId),
    getMessageContexts(conversationId),
    supabasePaymentsStore()
      .listActionsForConversation(conversationId)
      .catch((err) => {
        console.error('[inbox] payment actions lookup failed:', err instanceof Error ? err.message : err);
        return [];
      }),
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
    // owner | approver — the screen hides reply and close from an approver (the routes refuse them too).
    role: auth.role ?? 'owner',
    items,
    contexts,
    shots,
    paymentActions: paymentActions.map(toPaymentActionView),
  });
}

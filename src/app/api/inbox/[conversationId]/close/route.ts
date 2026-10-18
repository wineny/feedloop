// 대화 수동 닫기.
//
// 왜 있나 — 채널톡의 「닫힘」을 전달하는 웹훅 스코프가 아직 확인되지 않았다(§3-(f) 3차 주의).
// 그 이벤트가 영영 안 오더라도 받은편지함이 끝난 상담을 열린 것으로 보여주지 않게,
// 운영자가 직접 닫을 수 있는 길을 둔다. 채널톡 전용은 아니다 — 어느 채널이든 닫을 수 있다.

import { NextResponse } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { getConversationOwner } from '@/lib/bot/conversations';
import { getServiceRoleClient } from '@/lib/supabase';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;

  const conversation = await getConversationOwner(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: '대화를 찾을 수 없습니다' }, { status: 404 });
  }

  const auth = await resolveAccessibleBots(conversation.bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { error } = await getServiceRoleClient()
    .from('conversations')
    .update({ status: 'closed' })
    .eq('id', conversationId);

  if (error) {
    console.error('[inbox] close error:', error.message);
    return NextResponse.json({ error: '대화를 닫지 못했습니다' }, { status: 500 });
  }

  return NextResponse.json({ id: conversationId, status: 'closed' });
}

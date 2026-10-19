// 받은편지함 목록 — 운영자용 (세션 + 봇 접근권: 소유자 또는 승인자, bot_members).

import { NextRequest, NextResponse } from 'next/server';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { listConversations } from '@/lib/bot/conversations';

export async function GET(req: NextRequest) {
  const botId = req.nextUrl.searchParams.get('botId');

  const auth = await resolveAccessibleBots(botId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.botIds.length === 0) {
    return NextResponse.json({ conversations: [] });
  }

  const conversations = await listConversations(auth.botIds);
  return NextResponse.json({ conversations });
}

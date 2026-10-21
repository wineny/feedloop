// 봇 연결 상태 조회 — 연결 화면(/bots/[id]/connect)의 폴링 대상.
//
// 카카오 판정(`isBotConnected`)은 2026-09-14 에 뺐다. 카카오를 화면에서 내려 읽는 곳이
// 없어졌는데, 그 판정은 메시지를 세는 쿼리라 **3초마다 도는 폴링에 얹혀 있었다**.
// 카카오를 되살린다면 그 함수는 lib/bot/connection.ts 에 그대로 있다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { apiText } from '@/lib/http/api-text';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const owned = await resolveOwnedBots(id);
  if (!owned.ok) {
    return NextResponse.json({ error: owned.error }, { status: owned.status });
  }

  const { data: bot, error } = await getServiceRoleClient()
    .from('bots')
    .select(
      'id, status, status_message, platform, last_active_at, widget_connected_at, channel_connected_at',
    )
    .eq('id', id)
    .single();

  if (error || !bot) {
    return NextResponse.json({ error: apiText(req, 'botNotFound') }, { status: 404 });
  }

  return NextResponse.json({
    id: bot.id,
    status: bot.status,
    status_message: bot.status_message,
    platform: bot.platform,
    last_active_at: bot.last_active_at,
    // 입구마다 판정이 다르다 — 위젯은 처음 뜰 때 첫 폴링이, 채널톡은 첫 웹훅이 자기 칸을 찍는다.
    // 한 봇이 둘 다 쓸 수 있어 섞지 않고 따로 싣는다.
    widget_connected_at: bot.widget_connected_at,
    widget_connected: Boolean(bot.widget_connected_at),
    // 채널톡도 자기 칸에서 판정한다. 웹훅이 처음 도착할 때 이 값이 찍힌다.
    channel_connected_at: bot.channel_connected_at,
    channel_connected: Boolean(bot.channel_connected_at),
  });
}

// 위젯 「연결 해제」(I-25) — 연결 «표시»를 내린다.
//
// 서버는 스크립트가 서비스에서 지워졌는지 알 길이 없다. 그래서 해제의 정의는
// `widget_connected_at` 을 비우는 것뿐이다(2026-09-16 ny 결정). 스크립트가 아직 남아 있으면
// 다음 방문자가 위젯을 열 때 첫 폴링이 다시 찍는다(`api/widget/[botId]/messages` GET 은
// `IS NULL` 일 때만 UPDATE). 대화·피드백·설정은 건드리지 않는다 — 그건 「서비스 삭제」의 일이다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .update({ widget_connected_at: null })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(`[widget/${id}] disconnect failed:`, error.message);
    return NextResponse.json({ error: '연결을 해제하지 못했습니다' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: '봇을 찾을 수 없습니다' }, { status: 404 });
  }

  return NextResponse.json({ widget_connected: false });
}

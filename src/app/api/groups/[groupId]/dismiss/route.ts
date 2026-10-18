// 묶음 닫기 — 고칠 생각이 없는 묶음을 목록에서 내린다.
// 인사이트의 group_id 는 남겨둔다. 다시 묶기 대상이 되면 같은 것이 또 올라온다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const db = getServiceRoleClient();

  const { data: group } = await db
    .from('insight_groups')
    .select('id, bot_id')
    .eq('id', groupId)
    .maybeSingle();

  if (!group) return NextResponse.json({ error: '묶음을 찾을 수 없습니다' }, { status: 404 });

  const auth = await resolveOwnedBots(group.bot_id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { error } = await db
    .from('insight_groups')
    .update({ status: 'dismissed' })
    .eq('id', groupId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

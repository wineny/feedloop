// 기능 요청 묶음의 스펙 초안 만들기 (Gleap 차용 P1-3).
//
// 자동 PR 과 달리 레포를 읽지 않는다. 결과물은 코드가 아니라 사람이 읽는 문서다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { generateGroupSpec } from '@/lib/groups/spec';
import { isCodeFixable } from '@/lib/groups/policy';

export const maxDuration = 120;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params;
  const db = getServiceRoleClient();

  const { data: group } = await db
    .from('insight_groups')
    .select('id, bot_id, category')
    .eq('id', groupId)
    .maybeSingle();

  if (!group) return NextResponse.json({ error: '묶음을 찾을 수 없습니다' }, { status: 404 });

  const auth = await resolveOwnedBots(group.bot_id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // 버그 묶음은 스펙이 아니라 PR 이 답이다. 막지는 않되 굳이 권하지 않는다.
  if (isCodeFixable(group.category as string)) {
    return NextResponse.json(
      { error: '이 분류는 코드 수정안 대상입니다. 스펙 초안은 기능 요청에 씁니다.' },
      { status: 400 },
    );
  }

  try {
    const result = await generateGroupSpec(groupId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : '스펙 초안을 만들지 못했습니다';
    console.error('[groups/spec] failed', { groupId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

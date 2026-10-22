// 수정 PR 실행 하나의 「닫은 사유」 기록 — 사람이 「수정 PR」 상세에서 고른다.
//
// closed_at 은 크론·「머지 확인」이 GitHub 를 보고 자동으로 찍는다. 사유는 사람만 알기 때문에
// 여기서 받는다. 머지 없이 닫힌 run 에만 의미가 있어 그 조건을 서버가 확인한다 —
// 열린 PR 에 「중복」을 찍어두면 화면이 거짓말을 하게 된다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { parseCloseReasonPatch } from '@/lib/auto-dev/close-reason';
import { apiText, apiValidation } from '@/lib/http/api-text';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: apiText(req, 'badRequest') }, { status: 400 });
  }

  const patch = parseCloseReasonPatch(body);
  if (!patch.ok) return NextResponse.json({ error: apiValidation(req, patch) }, { status: 400 });

  const db = getServiceRoleClient();

  // 소유권 + 상태 확인을 한 번에. 남의 봇 run 은 404 로 — 존재 여부를 알려주지 않는다.
  const { data: run, error: loadError } = await db
    .from('auto_dev_runs')
    .select('id, bot_id, closed_at, merged_at')
    .eq('id', id)
    .maybeSingle();

  // DB 오류를 404 로 뭉개면 운영자가 엉뚱한 곳을 찾는다 (마이그레이션 누락 등)
  if (loadError) return NextResponse.json({ error: apiText(req, 'runReadFailed', { message: loadError.message }) }, { status: 500 });
  if (!run || !auth.botIds.includes(run.bot_id as string)) {
    return NextResponse.json({ error: apiText(req, 'runNotFound') }, { status: 404 });
  }
  if (!run.closed_at || run.merged_at) {
    return NextResponse.json(
      { error: apiText(req, 'closeNeedsClosedPr') },
      { status: 409 },
    );
  }

  const { data, error } = await db
    .from('auto_dev_runs')
    .update({ close_reason: patch.close_reason, close_note: patch.close_note })
    .eq('id', id)
    .select('id, close_reason, close_note')
    .single();

  if (error || !data) return NextResponse.json({ error: apiText(req, 'saveFailed') }, { status: 500 });

  return NextResponse.json({
    id: data.id,
    closeReason: data.close_reason ?? null,
    closeNote: data.close_note ?? null,
  });
}

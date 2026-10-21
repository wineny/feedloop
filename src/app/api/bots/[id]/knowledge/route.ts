// 봇 설정 › 답변 지식 쓰기.
//
// 여기 저장한 값은 시스템 프롬프트에 통째로 실린다(검색 없음). 방문자에게 직접
// 나가지는 않는다 — 무인증 /api/widget/[botId]/config 는 이 컬럼을 읽지 않는다.
// 그래도 쓰기는 반드시 소유자 확인을 거친다. 남의 봇 지식을 고칠 수 있으면
// 그 서비스 방문자가 받는 답변을 남이 쓰는 것과 같다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { validateKnowledgeInput } from '@/lib/bot/knowledge';
import { invalidateBotCache } from '@/lib/bot/core';
import { apiText, apiValidation } from '@/lib/http/api-text';

export const dynamic = 'force-dynamic';

const SELECT = 'id, service_name, knowledge_text, knowledge_faq, knowledge_updated_at';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: apiText(req, 'badRequest') }, { status: 400 });
  }

  const parsed = validateKnowledgeInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: apiValidation(req, parsed) }, { status: 400 });
  }

  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .update({ ...parsed.values, knowledge_updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(SELECT)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: apiText(req, 'saveFailed') }, { status: 500 });
  }

  // ⚠️ appearance 라우트에는 이 무효화가 없다(위젯 config 가 CDN 캐시를 따로 쓴다).
  //    지식은 다르다 — 봇 설정 캐시가 5분이라, 무효화하지 않으면 운영자가 저장하고
  //    바로 물어봤을 때 옛 지식으로 답한다. "저장했는데 안 바뀐다"가 된다.
  invalidateBotCache(id);

  return NextResponse.json(data);
}

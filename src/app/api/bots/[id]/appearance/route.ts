// 봇 설정 › 위젯 모양 읽기·쓰기 (설계 §3 목업 8번).
//
// 여기서 저장한 값을 무인증 /api/widget/[botId]/config 가 방문자에게 내보낸다.
// 그래서 쓰기는 반드시 소유자 확인을 거친다 — 남의 위젯 헤더를 바꿀 수 있으면
// 그건 그 서비스 사이트에 뜨는 문구를 남이 고치는 것과 같다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { validateAppearanceInput } from '@/lib/bot/appearance';

export const dynamic = 'force-dynamic';

/**
 * 위젯 모양 PATCH 본문의 상한. 여기 들어오는 건 표시 이름·인사말(300자)·시작 질문
 * 4개 같은 짧은 텍스트뿐이라 64KB 면 실제 입력의 수십 배다.
 * (무인증 위젯 라우트의 MAX_PAYLOAD_BYTES 와 같은 값이지만, 그쪽 상수를 끌어오면
 *  운영자 라우트가 CORS 헬퍼 모듈에 묶인다 — 값만 맞춘다.)
 */
const MAX_APPEARANCE_BODY_BYTES = 64 * 1024;

const SELECT =
  'id, service_name, display_name, status_text, greeting, operator_display_name, profile_image_url, accent_color, visitor_bubble_color, starter_questions, starter_faq_fallback';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // 본문을 파싱하기 «전에» 크기를 본다. 인증된 소유자만 닿는 경로지만, 상한을 넘는
  // 거대한 배열도 파싱 비용은 그대로 들고 그 비용은 공유 함수 CPU 에서 나간다.
  // Content-Length 는 위조·생략될 수 있으므로 실제로 읽은 길이도 확인한다.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_APPEARANCE_BODY_BYTES) {
    return NextResponse.json({ error: '요청 본문이 너무 큽니다' }, { status: 413 });
  }

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_APPEARANCE_BODY_BYTES) {
      return NextResponse.json({ error: '요청 본문이 너무 큽니다' }, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
  }

  const parsed = validateAppearanceInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .update(parsed.values)
    .eq('id', id)
    .select(SELECT)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: '저장하지 못했습니다' }, { status: 500 });
  }

  return NextResponse.json(data);
}

// 위젯 부팅 설정 — 무인증, CORS 개방. 위젯이 로드될 때 1회 읽는다.
//
// "봇 설정 › 위젯 모양"(설계 §3, 목업 8번) 값과 첫 화면 카테고리 칩을 돌려준다.
// 운영자가 아직 아무것도 안 정했으면 service_name 과 기본 문구로 채운다 —
// 위젯이 빈 헤더로 뜨는 일이 없게.

import { NextRequest } from 'next/server';
import { WIDGET_CHIPS, resolveWidgetBot, widgetError, widgetJson, widgetOptions } from '@/lib/widget/http';
import { getServiceRoleClient } from '@/lib/supabase';
// 폴백 문구·시작 질문 조립은 운영자 화면(위젯 모양 미리보기)과 한 곳을 공유한다 —
// 두 화면이 어긋나면 운영자가 "미리보기와 다른 위젯"을 보게 된다.
import { readFaqFallback, resolveStarterQuestions } from '@/lib/bot/appearance';
// 비어 있는 값의 기본 문구는 방문자 언어(?locale=en|ko, 기본 en)로 — 위젯 모양 미리보기와 같은 사전에서 온다.
import {
  chipLabel,
  defaultGreeting,
  defaultOperatorName,
  defaultStatusText,
  widgetLocale,
} from '@/lib/widget/strings';

export const OPTIONS = widgetOptions;


export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError('봇을 찾을 수 없습니다', 404);

  const locale = widgetLocale(req);
  const displayName = bot.display_name?.trim() || bot.service_name;

  // 시작 질문을 운영자가 안 정했고 «자동 채우기를 켜 뒀을 때만» FAQ 를 본다.
  // 비공개 답변이 딸려 오는 조회라 필요한 순간에만, 이 라우트에서만 한다
  // (공용 resolveWidgetBot 주석 참고). 응답은 CDN 에 60초 얹히므로
  // 방문자가 몰려도 DB 조회는 분당 1회 수준이다.
  // 여기서는 «해석 결과»가 아니라 원본 배열의 길이로 가른다 — 조회를 아끼려는 것이다.
  // 그래서 「비어 있지 않은데 전부 무효(40자 초과 등)」인 배열은 FAQ 로 떨어지지 않고
  // 빈 목록이 된다. 저장 단계(validateStarterQuestions)가 그런 값을 막으므로 지금은
  // 도달할 수 없지만, 상한을 «낮추면» 이미 저장된 질문이 읽기에서 탈락해 그 상태가 된다.
  const faqFallback = readFaqFallback(bot.starter_faq_fallback);
  const needsFaq =
    faqFallback && (!Array.isArray(bot.starter_questions) || bot.starter_questions.length === 0);

  let faq: unknown = null;
  if (needsFaq) {
    const { data } = await getServiceRoleClient()
      .from('bots')
      .select('knowledge_faq')
      .eq('id', bot.id)
      .single();
    faq = data?.knowledge_faq ?? null;
  }

  return widgetJson(
    {
      displayName,
      statusText: bot.status_text?.trim() || defaultStatusText(locale),
      greeting: bot.greeting?.trim() || defaultGreeting(locale, displayName),
      profileImageUrl: bot.profile_image_url || null,
      operatorDisplayName: bot.operator_display_name?.trim() || defaultOperatorName(locale, displayName),
      // 색은 null 을 그대로 내보낸다. 여기서 기본값을 채우면 위젯 CSS 폴백이
      // 무용지물이 되고, 나중에 기본색을 바꿀 때 고칠 곳이 두 군데가 된다.
      accentColor: bot.accent_color || null,
      visitorBubbleColor: bot.visitor_bubble_color || null,
      // 첫 화면 위쪽 줄 — 누르면 «바로 전송»된다. 운영자가 안 정했으면 FAQ 질문으로
      // 채운다. 답변은 절대 나가지 않는다(resolveStarterQuestions 가 질문만 꺼낸다).
      starterQuestions: resolveStarterQuestions(bot.starter_questions, faq, faqFallback),
      // 첫 화면 아래 줄 — 누르면 입력창이 채워지고 방문자가 이어 쓴다.
      chips: WIDGET_CHIPS.map(({ hint }) => ({ hint, label: chipLabel(locale, hint) })),
    },
    200,
    // 모양은 자주 안 바뀐다. 사이트 방문자마다 DB 를 때리지 않도록 CDN 에 1분 얹는다.
    { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  );
}

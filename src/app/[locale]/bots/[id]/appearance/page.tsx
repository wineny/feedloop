// 봇 설정 › 위젯 모양 — 방문자가 보는 위젯의 이름·인사말·프로필을 정하는 화면.
//
// 여기서 비워두면 위젯 config 라우트가 service_name 과 기본 문구로 채운다.
// 그래서 "필수" 항목이 하나도 없다 — 아무것도 안 정해도 위젯은 멀쩡히 뜬다.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { PageHero } from '@/components/layout/PageHero';
import { WidgetAppearanceForm } from '@/components/onboarding/WidgetAppearanceForm';
import { resolveStarterQuestions } from '@/lib/bot/appearance';

export const dynamic = 'force-dynamic';

export default async function BotAppearancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('bots.pages.appearance');

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/bots/${id}/appearance`);
  }

  const { data: bot } = await getServiceRoleClient()
    .from('bots')
    .select(
      'id, user_id, service_name, display_name, status_text, greeting, operator_display_name, profile_image_url, accent_color, visitor_bubble_color, starter_questions, starter_faq_fallback, knowledge_faq',
    )
    .eq('id', id)
    .single();

  // 남의 봇도 없는 봇과 똑같이 취급한다 — 존재 여부를 알려주지 않는다.
  if (!bot || bot.user_id !== session.user.id) {
    notFound();
  }

  // 시작 질문을 비워두면 위젯이 답변 지식 FAQ 에서 뽑아 쓴다. 운영자가 «무엇이
  // 대신 뜨는지» 미리보기에서 그대로 보게 같은 함수로 미리 풀어 넘긴다.
  // 자동 채우기를 꺼 뒀어도 «켜면 무엇이 뜨는지» 보여야 하므로 여기서는 항상 푼다 —
  // 켜고 끄는 판단의 재료다. 실제로 띄울지는 폼이 라디오 값으로 가른다.
  const faqQuestions = resolveStarterQuestions(null, bot.knowledge_faq, true);

  return (
    <div className="flex flex-col gap-6">
      <PageHero
        title={t('title')}
        description={t('description', { name: bot.service_name })}
        actions={
          <Link
            href={`/bots/${bot.id}/connect`}
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('back')}
          </Link>
        }
      />

      <WidgetAppearanceForm
        botId={bot.id}
        serviceName={bot.service_name}
        initial={{
          display_name: bot.display_name,
          status_text: bot.status_text,
          greeting: bot.greeting,
          operator_display_name: bot.operator_display_name,
          profile_image_url: bot.profile_image_url,
          accent_color: bot.accent_color,
          visitor_bubble_color: bot.visitor_bubble_color,
          starter_questions: bot.starter_questions,
          starter_faq_fallback: bot.starter_faq_fallback,
        }}
        faqQuestions={faqQuestions}
      />
    </div>
  );
}

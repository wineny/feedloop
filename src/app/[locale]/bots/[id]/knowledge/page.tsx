// 봇 설정 › 답변 지식 / API 키 — 봇이 «무엇으로» 답하고 «누구 돈으로» 답하는지를 정하는 화면.
//
// 두 가지를 한 화면 두 탭에 둔 이유: 운영자가 봇을 설정하는 자리가 이미
// 연결·위젯 모양으로 흩어져 있다. 답변 품질(지식)과 답변 비용(키)은 같은 결정의
// 앞뒤라 따로 찾아다니게 하지 않는다.
//
// 탭 2 는 계획 §B-5(T7) 자리다 — 루프 칸마다 어느 두뇌가 붙는지 보여준다(LlmPurposePanel).
// 탭 3 「GitHub」(B5) — 수정 PR 을 어느 계정으로 여는지. components/onboarding/GithubTokenForm.tsx.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { PageHero } from '@/components/layout/PageHero';
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UrlSyncedTabs } from '@/components/layout/UrlSyncedTabs';
import { LINE_TAB, LINE_TABS_LIST } from '@/components/layout/lineTabs';
import { KnowledgeForm } from '@/components/onboarding/KnowledgeForm';
import { LlmPurposePanel } from '@/components/onboarding/LlmPurposePanel';
import { GithubTokenForm } from '@/components/onboarding/GithubTokenForm';
import type { FaqItem } from '@/lib/bot/knowledge';

export const dynamic = 'force-dynamic';

export default async function BotKnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const t = await getTranslations('bots.pages.knowledge');

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/bots/${id}/knowledge`);
  }

  const { data: bot } = await getServiceRoleClient()
    .from('bots')
    .select('id, user_id, service_name, knowledge_text, knowledge_faq')
    .eq('id', id)
    .single();

  // 남의 봇도 없는 봇과 똑같이 취급한다 — 존재 여부를 알려주지 않는다.
  if (!bot || bot.user_id !== session.user.id) {
    notFound();
  }

  const faq: FaqItem[] = Array.isArray(bot.knowledge_faq) ? bot.knowledge_faq : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHero
        title={t('title')}
        description={t('description', { name: bot.service_name })}
        actions={
          <Link
            href="/bots"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('back')}
          </Link>
        }
      />

      {/* 널널투어 v2: 밑줄 탭(대화·수정 PR 화면과 같은 문법) */}
      {/* 탭을 누르면 주소의 `?tab=` 도 따라 바뀐다 — 그래야 헤더 셀렉터가 들고 가는 주소가
          «지금 보고 있는 탭»과 같아진다. 서버 왕복 없이 주소창만 고친다(UrlSyncedTabs 주석 참고). */}
      <UrlSyncedTabs defaultValue={tab === 'key' ? 'key' : tab === 'github' ? 'github' : 'knowledge'} className="gap-6">
        <TabsList variant="line" className={LINE_TABS_LIST}>
          <TabsTrigger value="knowledge" className={LINE_TAB}>{t('tabKnowledge')}</TabsTrigger>
          <TabsTrigger value="key" className={LINE_TAB}>{t('tabKey')}</TabsTrigger>
          <TabsTrigger value="github" className={LINE_TAB}>{t('tabGithub')}</TabsTrigger>
        </TabsList>

        <TabsContent value="knowledge">
          <KnowledgeForm
            botId={bot.id}
            serviceName={bot.service_name}
            initial={{ knowledge_text: bot.knowledge_text, knowledge_faq: faq }}
          />
        </TabsContent>

        <TabsContent value="key">
          <LlmPurposePanel botId={bot.id} serviceName={bot.service_name} />
        </TabsContent>

        <TabsContent value="github">
          <GithubTokenForm botId={bot.id} serviceName={bot.service_name} />
        </TabsContent>
      </UrlSyncedTabs>
    </div>
  );
}

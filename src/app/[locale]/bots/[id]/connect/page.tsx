// 서비스 연결 — 봇 등록 직후 오는 화면. **탭이 아니라 분기**다.
//
// 예전엔 탭 셋(웹 위젯 · 채널톡 · 카카오톡)이 한 화면에 있었고, 다시 와도 똑같이 셋을 물었다.
// 탭은 무엇을 고를지 이미 아는 사람의 문법이라, 「웹 위젯」이 자기 것인지 모르는 운영자를
// 지나친다. 이제는 갈림길 질문 하나를 던지고(`ConnectChooser`), 고른 쪽만 보여준다.
// 한 번이라도 연결된 뒤에는 질문 대신 현황판(`ConnectOverview`)이 선다.
//
// 상태는 URL 이 갖는다(`?via=widget` · `?via=channel`). 새로고침·뒤로가기가 그대로 살고,
// 안내 메일이나 다른 화면에서 「채널톡 연결하기」로 곧장 링크를 걸 수 있다.
// 예전 `?tab=` 링크도 받는다 — `?tab=kakao` 만은 갈림길로 보낸다(카카오는 화면에서 내렸다).
//
// 카카오톡 채널은 여기서 뺐다. 웹훅 라우트·대기열·「대화」의 입구 표시는 그대로 살아 있고
// 화면만 내린 것이다 — 마지막 카카오 메시지가 2026-09-06 이고 그 뒤로 0건이라
// 라이브 연결이 없음을 확인했다(2026-09-14).
//
// 2026-09-20 — **한 서비스에 입구는 하나다**(`lib/connect/exclusive.ts`). 쓰던 쪽이 있으면
// 반대쪽 안내는 잠긴 화면으로 바뀐다. 갈아타는 길은 열려 있다 — 현황판에서 「연결 해제」다.

import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ChevronLeft } from 'lucide-react';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getServiceRoleClient } from '@/lib/supabase';
import { PageHero } from '@/components/layout/PageHero';
import { ChannelTalkConnectGuide } from '@/components/onboarding/ChannelTalkConnectGuide';
import { WebWidgetConnectGuide } from '@/components/onboarding/WebWidgetConnectGuide';
import { ConnectChooser, ConnectLocked, ConnectOverview } from '@/components/onboarding/ConnectChooser';
import { resolveVia } from '@/lib/connect/via';
import { resolveConnectScreen } from '@/lib/connect/exclusive';
import { limitForDisplay, resolveLimit } from '@/lib/llm/limits';

export const dynamic = 'force-dynamic';

/** 그 입구로 마지막 피드백이 들어온 시각. 대화가 없으면 null */
async function lastFeedbackAt(botId: string, source: string): Promise<string | null> {
  const { data, error } = await getServiceRoleClient()
    .from('conversations')
    .select('last_message_at')
    .eq('bot_id', botId)
    .eq('source', source)
    // DESC 는 NULLS FIRST 라, 거르지 않으면 시각을 모르는 대화가 맨 위로 온다
    .not('last_message_at', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 삼키면 「아직 들어온 피드백이 없어요」로 조용히 뭉개진다 — 컬럼이 사라지거나 쿼리가
  // 깨져도 화면은 멀쩡해 보인다(위젯이 조회 오류를 삼켜 스스로 사라졌던 것과 같은 형태).
  if (error) console.error(`[connect/${botId}] ${source} 마지막 피드백 조회 실패:`, error.message);

  return data?.last_message_at ?? null;
}

export default async function BotConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ via?: string | string[]; tab?: string | string[] }>;
}) {
  const { id } = await params;
  const { via: viaParam, tab } = await searchParams;
  const t = await getTranslations('bots.pages.connect');
  const tn = await getTranslations('connect.entrance');

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/bots/${id}/connect`);
  }

  const { data: bot } = await getServiceRoleClient()
    .from('bots')
    .select('id, user_id, service_name, widget_connected_at, channel_connected_at, daily_reply_limit, llm_api_key_encrypted, llm_provider')
    .eq('id', id)
    .single();

  // 남의 봇도 없는 봇과 똑같이 취급한다 — 존재 여부를 알려주지 않는다.
  if (!bot || bot.user_id !== session.user.id) {
    notFound();
  }

  const via = resolveVia(viaParam, tab);
  // 서비스명은 운영자가 적은 임의의 말이다. 뒤에 붙는 조사는 받침을 타지 않는 것만 쓴다 —
  // 「…로」는 받침이 있으면 「…으로」여야 해서(「봇로」 ✗) 남의 서비스 이름에서 곧바로 깨진다.
  const serviceName = bot.service_name || t('fallbackName');
  const widgetOn = Boolean(bot.widget_connected_at);
  const channelOn = Boolean(bot.channel_connected_at);

  // 프로토콜을 https 로 굳히면 로컬에서 https://localhost:3001 이라는 못 쓰는 주소가 나온다.
  // 프록시 뒤(Vercel)에서는 x-forwarded-proto 가 https 로 온다.
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const baseUrl = process.env.WEBHOOK_BASE_URL || `${proto}://${h.get('host')}`;

  // 갈림길·현황판·안내·잠김 중 무엇을 그릴지는 순수 함수가 정한다(`lib/connect/exclusive.ts`).
  const screen = resolveConnectScreen(via, { widgetOn, channelOn });

  // 쓰던 입구가 있는데 반대쪽 안내로 들어온 경우. 주소를 직접 친 길도 여기서 막힌다 —
  // 세 단계를 다 채운 «뒤» 저장에서 400 을 만나는 건 잠금이 아니라 함정이다.
  if (screen.kind === 'locked') {
    return (
      <Frame
        botId={bot.id}
        backLabel={t('overviewTitle')}
        // 「채널톡 붙이기」라고 쓰면 제목이 약속하는 일과 본문이 말하는 일이 어긋난다 —
        // 큰 글씨로 붙이라고 해놓고 아래에서 못 붙인다고 하는 꼴이다(2026-09-20 브라우저 QA).
        title={t('lockedTitle', { want: tn(screen.want) })}
        // 서비스명 뒤에 받침 타는 조사를 붙이지 않는다 — 「널널투어은」이 실제로 나왔다.
        // 이 파일 위쪽 serviceName 주석이 경고하던 바로 그 함정이다.
        description={t('lockedDescription', { using: tn(screen.using) })}
      >
        <ConnectLocked botId={bot.id} want={screen.want} using={screen.using} />
      </Frame>
    );
  }

  if (screen.kind === 'guide' && screen.via === 'widget') {
    return (
      <Frame botId={bot.id} backLabel={t('overviewTitle')} title={t('widgetTitle')} description={t('widgetDescription')}>
        <WebWidgetConnectGuide
          botId={bot.id}
          scriptSrc={`${baseUrl}/widget.js`}
          appearanceHref={`/bots/${bot.id}/appearance`}
          initiallyConnected={widgetOn}
        />
      </Frame>
    );
  }

  if (screen.kind === 'guide' && screen.via === 'channel') {
    return (
      <Frame botId={bot.id} backLabel={t('overviewTitle')} title={t('channelTitle')} description={t('channelDescription')}>
        <ChannelTalkConnectGuide
          botId={bot.id}
          serviceName={bot.service_name ?? ''}
          initiallyConnected={channelOn}
        />
      </Frame>
    );
  }

  // 한 번이라도 연결됐으면 같은 질문을 다시 하지 않는다.
  if (screen.kind === 'overview') {
    // 켜진 입구의 시각만 물어본다 — 꺼진 쪽은 어차피 「아직 안 붙음」으로 그린다.
    const [widgetLastAt, channelLastAt] = await Promise.all([
      widgetOn ? lastFeedbackAt(bot.id, 'web') : Promise.resolve(null),
      channelOn ? lastFeedbackAt(bot.id, 'channel') : Promise.resolve(null),
    ]);

    return (
      <div className="flex flex-col gap-6">
        <PageHero
          title={t('overviewTitle')}
          description={t('overviewDescription', { name: serviceName })}
        />
        <ConnectOverview
          botId={bot.id}
          widget={{ on: widgetOn, lastAt: widgetLastAt }}
          channel={{ on: channelOn, lastAt: channelLastAt }}
          appearanceHref={`/bots/${bot.id}/appearance`}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHero
        title={t('overviewTitle')}
        description={t('chooserDescription', { name: serviceName })}
      />
      <ConnectChooser
        botId={bot.id}
        // llm-key GET(`present`)과 같은 계산 — 화면 두 곳이 다른 숫자를 말하면 안 된다(I-26)
        dailyLimit={limitForDisplay(
          resolveLimit({
            dailyReplyLimit: bot.daily_reply_limit,
            llmApiKeyEncrypted: bot.llm_api_key_encrypted,
            llmProvider: bot.llm_provider,
          }),
        )}
        dailyLimitOverridden={bot.daily_reply_limit != null}
      />
    </div>
  );
}

/**
 * 고른 갈래의 틀 — 돌아가는 길을 제목 위에 둔다. 두 안내가 같은 자리를 쓰게 여기서 그린다.
 *
 * 뒤로가기 라벨이 「연결 방법 고르기」가 아닌 이유: 한쪽이라도 붙은 봇은 그 링크가 갈림길이
 * 아니라 **현황판**으로 간다. 두 목적지 모두에 맞는 이름은 그 화면의 제목이다.
 */
function Frame({
  botId,
  title,
  description,
  children,
  backLabel,
}: {
  botId: string;
  backLabel: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href={`/bots/${botId}/connect`}
          className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          {backLabel}
        </Link>
        <PageHero title={title} description={description} />
      </div>
      {children}
    </div>
  );
}

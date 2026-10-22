import type { Metadata } from "next";
// 시안 서체 Pretendard — CDN 대신 npm 패키지로 self-host (심사 기간 외부 의존 최소화)
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "../globals.css";
import { Navigation } from "@/components/layout/Navigation";
import { AppMain } from "@/components/layout/AppMain";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { DemoProvider } from "@/lib/demo/DemoProvider";
import { BotScopeProvider } from "@/lib/scope/BotScopeProvider";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { SelfWidget } from "@/components/layout/SelfWidget";
import { PostHogGate } from "@/components/layout/PostHogGate";
import { hasLocale } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { BrowserTimeZoneIntl } from "@/i18n/BrowserTimeZoneIntl";
import { LAYOUT_NAMESPACES } from "@/i18n/namespaces";

// 언어별로 빌드 때 미리 그린다 — 주소에는 언어가 없고 proxy 가 이 경로로 rewrite 한다.
// en/ko 밖의 값(`/nope.txt` 처럼 proxy 를 안 거친 점 경로)은 이 레이아웃을 건너뛰고 app/global-not-found.tsx 가 받는다.
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    metadataBase: new URL("https://ai-feedloop.vercel.app"),
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // 클라이언트로 가는 사전은 공통 namespace 만 — 화면별 namespace 는 각 구역의 layout 이 `PageMessages` 로 더한다.
  const all = await getMessages();
  const common = Object.fromEntries(LAYOUT_NAMESPACES.map((ns) => [ns, all[ns]]));
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full flex flex-col overflow-x-hidden">
        <BrowserTimeZoneIntl locale={locale} messages={common}>
        <AuthProvider>
          <DemoProvider>
            {/* 봇 스코프(I-27) — 헤더 셀렉터가 고르고 네 탭이 읽는다. 세션 안쪽이어야 /api/bots 를 부를 수 있다 */}
            <BotScopeProvider>
              <Navigation />
              <DemoBanner />
              {/* 바탕색·fab 하단 여백은 경로를 알아야 갈리므로 클라이언트 조각이 맡는다 */}
              <AppMain>{children}</AppMain>
              <SelfWidget />
              <PostHogGate />
            </BotScopeProvider>
          </DemoProvider>
        </AuthProvider>
        </BrowserTimeZoneIntl>
      </body>
    </html>
  );
}

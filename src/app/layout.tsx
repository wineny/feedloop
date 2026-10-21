import type { Metadata } from "next";
// 시안 서체 Pretendard — CDN 대신 npm 패키지로 self-host (심사 기간 외부 의존 최소화)
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import { Navigation } from "@/components/layout/Navigation";
import { AppMain } from "@/components/layout/AppMain";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { DemoProvider } from "@/lib/demo/DemoProvider";
import { BotScopeProvider } from "@/lib/scope/BotScopeProvider";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { SelfWidget } from "@/components/layout/SelfWidget";
import { PostHogGate } from "@/components/layout/PostHogGate";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    metadataBase: new URL("https://ai-feedloop.vercel.app"),
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full flex flex-col overflow-x-hidden">
        <NextIntlClientProvider>
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
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

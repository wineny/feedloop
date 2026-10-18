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

export const metadata: Metadata = {
  metadataBase: new URL("https://ai-feedloop.vercel.app"),
  title: "Feedloop — 고객 피드백이 들어오는 즉시 수정이 시작되고, 완료되면 자동으로 알립니다",
  description: "고객 피드백이 들어오는 즉시 수정이 시작되고, 완료되면 보낸 분께 자동으로 알립니다. 설치는 5분이면 끝납니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col overflow-x-hidden">
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
      </body>
    </html>
  );
}

'use client';

import Script from 'next/script';
import { usePathname } from '@/i18n/navigation';
import { isPricingPath } from '@/lib/pricing/paths';

/**
 * Feedloop 위젯을 Feedloop 자기 자신에 붙인다 — 도그푸딩(ny 결정 2026-09-16).
 *
 * 봇은 프로덕션 Supabase `bots` 의 「Feedloop」(운영자 소유).
 * 모양(프로필·인사말·시작 질문)은 코드가 아니라 «봇 설정 › 위젯 모양»에서 바꾼다.
 * 봇 ID 는 비밀이 아니다 — 방문자 브라우저에 그대로 실리는 값이라 env 로 감출 이유가 없다.
 *
 * 전 페이지에 붙인다(루트 레이아웃). 랜딩의 「데모」 팝업은 각본 재생이라 가짜 위젯을 그리므로
 * 가이드 데모가 열려 있는 동안은 이 위젯을 숨긴다 — 데모 안 가짜 위젯과 같은 자리(우측 하단)라
 * 버튼이 둘 뜬다. 숨기는 규칙은 globals.css 의 `body.gd-demo-open [data-feedloop-widget]`.
 *
 * `/pricing` 아래(PayPal 데모 가게)는 데모 봇 위젯(`DemoWidget`)이 대신 붙으므로 여기서 빠진다.
 */
export const SELF_BOT_ID = '8f0c0182-741a-42a3-825e-94550ca6a677';

export function SelfWidget() {
  const pathname = usePathname();
  if (isPricingPath(pathname)) return null;
  return <Script src="/widget.js" data-feedloop={SELF_BOT_ID} strategy="afterInteractive" />;
}

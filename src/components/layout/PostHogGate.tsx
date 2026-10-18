'use client';
import { useLayoutEffect } from 'react';
import { useSession } from 'next-auth/react';
import { confirmLoggedOut, setAnalyticsAllowed } from '@/lib/analytics/posthog';

/**
 * 로그아웃이 확인되면 PostHog 를 켜고, 확인 중(loading)이거나 로그인했으면 닫는다.
 * 'unauthenticated' 만 믿지 않고 서버에 한 번 더 묻는다 — 세션 조회 실패도 그렇게 오기 때문.
 * layout effect 인 이유: 로그인으로 바뀌어 실제 데이터가 그려진 직후, 녹화기가 그 변화를 집어 가기 전에 끈다.
 * 이유 전체는 src/lib/analytics/posthog.ts 머리말.
 */
export function PostHogGate() {
  const { status } = useSession();

  useLayoutEffect(() => {
    if (status !== 'unauthenticated') {
      setAnalyticsAllowed(false);
      return;
    }
    let stale = false;
    void confirmLoggedOut().then((loggedOut) => {
      if (!stale && loggedOut) setAnalyticsAllowed(true);
    });
    return () => {
      stale = true;
    };
  }, [status]);

  return null;
}

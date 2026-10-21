import { defineRouting } from 'next-intl/routing';

// 주소에 언어를 넣지 않는다(`/en/...` 없음) — 위젯 삽입 주소·PayPal return·webhook 주소가 그대로여야 한다.
// 페이지는 내부적으로만 `[locale]` 아래에 있고, proxy 가 쿠키(NEXT_LOCALE) → Accept-Language → en 순으로
// 언어를 골라 그 경로로 rewrite 한다. 덕분에 언어별로 정적 렌더가 된다.
export const routing = defineRouting({
  locales: ['en', 'ko'],
  defaultLocale: 'en',
  localePrefix: 'never',
  // 기본은 세션 쿠키 — 브라우저를 닫아도 고른 언어가 남도록 1년.
  localeCookie: { name: 'NEXT_LOCALE', maxAge: 60 * 60 * 24 * 365 },
});

export type Locale = (typeof routing.locales)[number];

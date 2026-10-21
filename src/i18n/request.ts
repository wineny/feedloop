import * as rootParams from 'next/root-params';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

// 언어는 `[locale]` 세그먼트(proxy 가 쿠키 → Accept-Language → en 으로 골라 rewrite)에서 읽는다.
// cookies()/headers() 를 읽지 않으므로 페이지가 정적 렌더된다.
// root-params 는 Route Handler·Server Action 에서 못 쓴다 — 거기서는 `getTranslations({ locale, ... })` 로 넘긴다.
// 명시적으로 넘긴 locale 도 검사한다 — `/nope.txt` 처럼 public 에 없는 점 경로는 proxy 를 안 거쳐
// `[locale]` 에 그대로 들어오고, generateMetadata 가 그 값을 넘긴다.
export default getRequestConfig(async ({ locale }) => {
  const candidate = locale ?? (await rootParams.locale());
  if (!hasLocale(routing.locales, candidate)) notFound();
  return {
    locale: candidate,
    messages: (await import(`../../messages/${candidate}.json`)).default,
  };
});

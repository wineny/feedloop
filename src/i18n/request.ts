import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE } from './config';
import { pickLocale } from './pick-locale';

// URL 에 언어 접두어를 두지 않는다 — 위젯·PayPal return·webhook 주소가 그대로여야 해서
// 미들웨어 없이 요청마다 쿠키 → Accept-Language 순으로 읽는다.
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = pickLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});

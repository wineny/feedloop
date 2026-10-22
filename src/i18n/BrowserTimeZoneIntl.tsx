'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
// 서버 렌더(SSG)와 hydration 첫 렌더는 UTC — 날짜는 클라이언트가 받아 온 데이터로만 그려서 HTML 에 날짜가 없다.
// hydration 이 끝나면 브라우저 시간대로 바뀐다.
const serverTimeZone = () => 'UTC';

/** 클라이언트 쪽 사전 Provider — 날짜를 **보는 사람의 브라우저 시간대**로 포맷하게 한다 */
export function BrowserTimeZoneIntl({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}

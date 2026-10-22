'use client';

import type { ReactNode } from 'react';
import { NextIntlClientProvider, useLocale, type AbstractIntlMessages, useMessages, useTimeZone } from 'next-intl';

/** 바깥 Provider 의 사전에 이 구역이 쓰는 namespace 를 더한다. 언어·시간대는 바깥 것을 그대로 쓴다 */
export function MessageScope({ messages, children }: { messages: AbstractIntlMessages; children: ReactNode }) {
  const outer = useMessages();
  return (
    <NextIntlClientProvider locale={useLocale()} messages={{ ...outer, ...messages }} timeZone={useTimeZone()}>
      {children}
    </NextIntlClientProvider>
  );
}

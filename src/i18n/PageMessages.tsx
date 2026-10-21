import type { ReactNode } from 'react';
import { getMessages } from 'next-intl/server';
import { MessageScope } from './MessageScope';
import { PAGE_NAMESPACES, type PageKey } from './namespaces';

/** 구역(layout)·페이지가 클라이언트 컴포넌트에 넘길 namespace 만 골라 싣는다 — 목록은 `namespaces.ts` */
export async function PageMessages({ page, children }: { page: PageKey; children: ReactNode }) {
  const all = await getMessages();
  const picked = Object.fromEntries(PAGE_NAMESPACES[page].map((ns) => [ns, all[ns]]));
  return <MessageScope messages={picked}>{children}</MessageScope>;
}

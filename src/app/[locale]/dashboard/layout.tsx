import type { ReactNode } from 'react';
import { PageMessages } from '@/i18n/PageMessages';

export default function Layout({ children }: { children: ReactNode }) {
  return <PageMessages page="dashboard">{children}</PageMessages>;
}

'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from './constants';

const CALLBACK_URL = PRIMARY_CTA_HREF;

export function ArrowIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

interface PrimaryCtaProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * 주 CTA — 로그인 안 했으면 Google 로그인으로, 했으면 곧장 봇 등록으로.
 * 진짜 `<a href>` 라 JS 가 없어도 `/bots/new` 에 닿는다(그 화면이 로그인을 안내한다).
 */
export function PrimaryCta({ className, style, children }: PrimaryCtaProps) {
  const { status } = useSession();

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // 로그인됐거나 아직 모르면(loading) 진짜 링크로 보낸다 — 로그인된 사람을 Google 로 다시 보내지 않는다.
    if (status !== 'unauthenticated') return;
    e.preventDefault();
    void signIn('google', { callbackUrl: CALLBACK_URL });
  }

  return (
    <a href={PRIMARY_CTA_HREF} onClick={onClick} className={className} style={style}>
      {children ?? (
        <>
          {PRIMARY_CTA_LABEL}
          <ArrowIcon />
        </>
      )}
    </a>
  );
}

/** nav 의 「로그인」 — 로그인돼 있으면 대시보드 링크로 바뀐다 */
export function LoginLink({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return <span className={className} aria-hidden="true">&nbsp;</span>;
  }
  if (session?.user) {
    return (
      <a href="/dashboard" className={className} onClick={onNavigate}>
        내 대시보드
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onNavigate?.();
        void signIn('google', { callbackUrl: '/dashboard' });
      }}
    >
      로그인
    </button>
  );
}

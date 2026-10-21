'use client';

import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/landing/Logo';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { GoogleMark } from './GoogleMark';
import { dynamicT } from '@/i18n/dynamic';

/**
 * NextAuth 가 돌려주는 error 코드 → 사전 키(`auth.errors.<코드>`). 목록에 없으면 generic.
 * (next-auth v4 pages/signin·pages/error 의 코드값)
 */
const KNOWN_ERRORS = ['AccessDenied', 'OAuthAccountNotLinked', 'SessionRequired', 'Configuration'];

interface LoginCardProps {
  /** 로그인 뒤 돌아갈 곳. 서버(page.tsx)에서 상대 경로만 통과시킨다 */
  callbackUrl: string;
  error: string | null;
}

export function LoginCard({ callbackUrl, error }: LoginCardProps) {
  const t = useTranslations('auth');
  const errorText = error ? dynamicT(t)(`errors.${KNOWN_ERRORS.includes(error) ? error : 'generic'}`) : null;

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="flex w-full max-w-[360px] flex-col items-center px-6 py-10 text-center">
        <Link href="/" className="inline-flex items-center gap-2 text-[17px] font-bold text-foreground" aria-label={t('homeLabel')}>
          <LogoMark size={26} className="text-[#F2645C]" />
          Feedloop
        </Link>
        {/* 로그인 화면엔 전역 나브가 없다 — 언어 전환만 워드마크 밑에 둔다 */}
        <LocaleSwitcher className="mt-3 text-muted-foreground" />

        <h1 className="mt-8 text-[22px] font-bold tracking-[-0.01em] text-foreground">{t('title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground" style={{ textWrap: 'pretty' }}>
          {t('lead')}
        </p>

        <Button
          type="button"
          size="lg"
          onClick={() => signIn('google', { callbackUrl })}
          className="mt-7 h-12 w-full gap-2.5 text-[15px] font-semibold"
        >
          <GoogleMark className="h-[18px] w-[18px]" />
          {t('continueWithGoogle')}
        </Button>

        {errorText && (
          <p role="alert" className="mt-4 text-[13px] leading-relaxed text-[#c0392b]">
            {errorText}
          </p>
        )}

        <p className="mt-8 text-[12px] leading-relaxed text-muted-foreground">
          {t.rich('browseSample', {
            link: (chunks) => (
              <Link href="/dashboard" className="font-semibold text-foreground underline-offset-2 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </div>
  );
}

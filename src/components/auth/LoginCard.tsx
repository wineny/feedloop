'use client';

import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/landing/Logo';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { GoogleMark } from './GoogleMark';

/**
 * NextAuth 가 돌려주는 error 코드 → 사람이 읽을 한 줄. 목록에 없으면 generic.
 * (next-auth v4 pages/signin·pages/error 의 코드값)
 */
const ERROR_TEXT: Record<string, string> = {
  AccessDenied: '이 계정으로는 로그인할 수 없어요. 다른 Google 계정으로 시도해 주세요.',
  OAuthAccountNotLinked: '이 이메일은 다른 방법으로 가입돼 있어요. 처음 쓴 방법으로 로그인해 주세요.',
  SessionRequired: '로그인이 필요한 화면이에요.',
  Configuration: '로그인 설정에 문제가 있어요. 잠시 후 다시 시도해 주세요.',
};
const GENERIC_ERROR = '로그인 중 문제가 생겼어요. 다시 시도해 주세요.';

interface LoginCardProps {
  /** 로그인 뒤 돌아갈 곳. 서버(page.tsx)에서 상대 경로만 통과시킨다 */
  callbackUrl: string;
  error: string | null;
}

export function LoginCard({ callbackUrl, error }: LoginCardProps) {
  const errorText = error ? (ERROR_TEXT[error] ?? GENERIC_ERROR) : null;

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="flex w-full max-w-[360px] flex-col items-center px-6 py-10 text-center">
        <Link href="/" className="inline-flex items-center gap-2 text-[17px] font-bold text-foreground" aria-label="Feedloop 홈">
          <LogoMark size={26} className="text-[#F2645C]" />
          Feedloop
        </Link>
        {/* 로그인 화면엔 전역 나브가 없다 — 언어 전환만 워드마크 밑에 둔다 */}
        <LocaleSwitcher className="mt-3 text-muted-foreground" />

        <h1 className="mt-8 text-[22px] font-bold tracking-[-0.01em] text-foreground">로그인</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground" style={{ textWrap: 'pretty' }}>
          Google 계정 하나면 돼요. 가입 절차도, 비밀번호도 따로 없어요.
        </p>

        <Button
          type="button"
          size="lg"
          onClick={() => signIn('google', { callbackUrl })}
          className="mt-7 h-12 w-full gap-2.5 text-[15px] font-semibold"
        >
          <GoogleMark className="h-[18px] w-[18px]" />
          Google로 계속하기
        </Button>

        {errorText && (
          <p role="alert" className="mt-4 text-[13px] leading-relaxed text-[#c0392b]">
            {errorText}
          </p>
        )}

        <p className="mt-8 text-[12px] leading-relaxed text-muted-foreground">
          로그인 없이도{' '}
          <Link href="/dashboard" className="font-semibold text-foreground underline-offset-2 hover:underline">
            예시 데이터로 둘러보기
          </Link>
          가 돼요.
        </p>
      </div>
    </div>
  );
}

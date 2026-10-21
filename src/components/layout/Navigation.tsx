'use client';

import Link from 'next/link';
import { LogoMark } from '@/components/landing/Logo';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import { AuthButton } from '@/components/auth/AuthButton';
import { BotScopeSelect } from '@/components/layout/BotScopeSelect';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { isPricingPath } from '@/lib/pricing/paths';

// 순서가 곧 루프다: 대화(들어옴) → 피드백(분류) → 수정 PR(수정·되돌림).
// 「알림」 탭은 뺐다 — 가짜 데이터만 있던 화면이고, 되돌림 기록은 수정 PR 상세에서 본다.
const navItems = [
  { label: '대시보드', href: '/dashboard' },
  { label: '대화', href: '/inbox' },
  { label: '피드백', href: '/classify' },
  { label: '수정안', href: '/monitor' },
  { label: '챗봇 설정', href: '/bots' },
];

/** 전역 헤더 — 널널투어 v2 셸(60px · 1120 컨테이너 · 워드마크 20/800 · GNB 활성 = 잉크 600) */
export function Navigation() {
  const pathname = usePathname();
  const { status } = useSession();
  const isAuthenticated = status === 'authenticated';

  // 랜딩(/)은 자체 나브(LandingNav)를 렌더하므로 전역 나브를 숨긴다
  // 랜딩은 자체 나브(LandingNav)가 있고, 로그인 화면은 워드마크만 보여준다
  // PayPal 데모 가게(/pricing)는 영어 화면이라 자체 헤더(PricingHeader)를 쓴다
  if (pathname === '/' || pathname === '/login' || isPricingPath(pathname)) return null;

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-sm">
      <div className="mx-auto flex min-h-[60px] max-w-[1120px] flex-wrap items-center gap-x-4 px-6 py-2 lg:h-[60px] lg:flex-nowrap lg:gap-8 lg:py-0">
        {/* 랜딩(LandingNav)과 같은 워드마크 — 루프 마크(코랄) + Feedloop(잉크).
            로그인 여부와 무관하게 «랜딩»으로 간다. 로그인하면 /dashboard 로 보내던 때는
            헤더 로고가 지금 보는 화면을 가리켜, 서비스 소개로 돌아갈 길이 화면에서 사라졌다. */}
        <Link
          href="/"
          className="flex min-h-11 shrink-0 items-center gap-2 text-xl font-extrabold tracking-[-0.03em] text-foreground"
        >
          <LogoMark size={22} className="text-[#F2645C]" />
          Feedloop
        </Link>

        <nav className="order-last flex w-full min-w-0 items-center gap-6 overflow-x-auto text-sm lg:order-none lg:w-auto lg:flex-1">
          {navItems.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap transition-colors',
                  isActive
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex min-w-0 max-w-[calc(100%_-_140px)] items-center gap-3 lg:ml-0 [&>div]:min-w-0 [&>div>span]:max-w-32 [&>div>span]:truncate [&_button]:shrink-0">
          {/* 서비스 셀렉터(I-27) — 봇이 둘 이상인 계정에서만 나타난다 */}
          {isAuthenticated && <BotScopeSelect />}
          <LocaleSwitcher className="text-muted-foreground" />
          <AuthButton />
        </div>
      </div>
    </header>
  );
}

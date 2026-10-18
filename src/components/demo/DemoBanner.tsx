'use client';

import { usePathname } from 'next/navigation';
import { useDemoContext } from '@/lib/demo/DemoProvider';

/**
 * 「지금 보는 건 예시 데이터고, 로그인 없이 다 둘러볼 수 있다」 — 심사자가 링크를 열고
 * 가장 먼저 읽는 줄이다.
 *
 * v4(2026-09-18): 390px 에서 긴 한 문장이 두 줄로 접히는데 알약은 `items-center` 로 세로
 * 가운데에 걸려 어긋나 보였다(ny 지적). 줄을 접는 대신 **폭에 맞는 문장을 고른다** —
 * 좁으면 짧은 판, 넓으면 온전한 판. 어느 쪽이든 배너는 «한 줄»이다.
 * 두 판 모두 같은 두 가지(예시 데이터 · 로그인 불필요)를 말한다.
 */
export function DemoBanner() {
  const { isDemo } = useDemoContext();
  const pathname = usePathname();
  // 랜딩(/)은 풀블리드 히어로 위에 배너가 얹히면 안 되므로 숨긴다
  // 로그인 화면에 「로그인 없이 볼 수 있어요」 배너가 얹히면 말이 안 맞는다
  if (!isDemo || pathname === '/' || pathname === '/login') return null;

  return (
    <div className="demo-banner relative overflow-hidden border-b border-[var(--primary-100)]">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--primary-50)] via-white to-[var(--primary-50)]" />
      <div className="demo-banner-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-[var(--primary-100)]/60 to-transparent" />

      {/* 컨테이너 폭·좌우 여백을 본문(`AppMain`)과 같게 맞춘다 — 예전엔 max-w-6xl(1152)이라
          아래 본문(1120)과 32px 어긋나 배너만 삐져나온 것처럼 보였다 */}
      <div className="relative mx-auto flex max-w-[1120px] items-center justify-center gap-2 px-6 py-2 sm:gap-3">
        {/* 라이브 표시 알약. 「지금 보는 화면이 살아 있다」는 뜻이라 점은 계속 깜빡인다 */}
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-500)]/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--primary-600)]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--primary-400)] opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--primary-500)]" />
          </span>
          Live Demo
        </span>

        {/* 좁은 화면 — 같은 두 사실을 짧게. 한 줄에 들어간다 */}
        <span className="text-[12.5px] leading-snug text-[var(--neutral-600)] sm:hidden">
          예시 데이터 · 로그인 없이 둘러보기
        </span>
        {/* 넓은 화면 — 온전한 문장. 사이를 이었던 「 — 」는 마침표로 바꿨다(한국어로 더 자연스럽다) */}
        <span className="hidden text-sm text-[var(--neutral-600)] sm:inline">
          예시 데이터로 둘러보는 중이에요. 모든 메뉴를 로그인 없이 볼 수 있어요.
        </span>
      </div>
    </div>
  );
}

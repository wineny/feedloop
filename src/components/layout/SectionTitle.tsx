import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SectionTitleProps {
  children: ReactNode;
  /** 제목 «아래» 한 줄 설명. 제목 옆에 붙이지 않는다 — 아래 주석 참고 */
  sub?: ReactNode;
  className?: string;
}

/**
 * 섹션 제목 20/700 −0.02em — v4(2026-09-17).
 *
 * v2 는 설명을 제목 **옆**에 13px 로 붙였다. 그러면 제목과 설명이 한 줄에서 서로 음량을 다투고,
 * 좁은 폭에서는 제목이 먼저 잘린다. 설명은 아래로 내리고 본문 크기(14)로 둔다 — 읽으라고 쓴
 * 문장이면 읽을 수 있는 크기여야 하고, 읽을 필요가 없으면 애초에 없어야 한다.
 *
 * 13px 는 이 시스템에서 사라졌다. 13px 가 하던 일은 본문(14) 아니면 메타(12.5) 둘 중 하나다.
 */
export function SectionTitle({ children, sub, className }: SectionTitleProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <h2 className="text-xl font-bold tracking-[-0.02em]">{children}</h2>
      {sub && <p className="text-sm leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

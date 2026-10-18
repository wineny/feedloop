import type { ReactNode } from 'react';
import Image from 'next/image';
import { cn } from '@/lib/utils';

interface PageHeroProps {
  title: string;
  /** 한 줄 부제. 형용사가 아니라 숫자·사실을 말한다(예: "검토를 기다리는 수정안 1개") */
  description?: ReactNode;
  /**
   * 제목 앞 Fluent 3D 이모지 경로(`PAGE_EMOJI` 에서 고른다).
   * 장식이 아니라 **루프의 어느 단계인가**를 말한다 — 네비게이션 순서가 곧 루프이고,
   * 대시보드의 `LoopStages` 가 같은 이모지로 같은 단계를 그린다.
   */
  emoji?: string;
  /** 우측 정렬 액션 버튼 영역 */
  actions?: ReactNode;
  className?: string;
}

/**
 * 화면 ↔ 루프 단계 매핑. 값이 두 곳(여기와 `LoopStages`)에 흩어지지 않게 이름을 여기 모은다.
 * 자산은 `public/emoji/` 에 self-host 돼 있다 — 심사 기간(9/21~10/5) 외부 의존을 늘리지 않는다.
 */
export const PAGE_EMOJI = {
  /** 루프 전체를 내려다보는 화면. 로고(무한 루프 마크)와 같은 뜻이다 */
  dashboard: '/emoji/counterclockwise_arrows_button_3d.png',
  /** 들어온 말 — `LoopStages` 의 「들어온 피드백」과 짝 */
  inbox: '/emoji/speech_balloon_3d.png',
  /** 나눈 결과 — `LoopStages` 의 「AI 가 분류」와 같은 자산 */
  classify: '/emoji/card_index_dividers_3d.png',
  /** 고치는 일 — `LoopStages` 의 「수정 PR」과 같은 자산 */
  monitor: '/emoji/hammer_and_wrench_3d.png',
  /** 붙이는 일. 루프의 단계가 아니라 루프가 «시작되게» 하는 화면이다 */
  bots: '/emoji/electric_plug_3d.png',
} as const;

/**
 * 내부 페이지 공통 머리글 — v4(2026-09-17).
 *
 * 제목 30/800 + 부제 한 줄. v2 의 26/800 에서 키운 이유는 크기 자체가 아니라 **간격**이다 —
 * 한 화면 글자의 91%가 11~14px 한 구간에 몰려 있어(실측: 대시보드 텍스트 노드 141개 중 128개)
 * 위계가 없었다. 제목이 본문의 두 배를 넘어야 비로소 「여기가 시작」으로 읽힌다.
 *
 * ⚠️ 부제는 **한 줄**이다. 기능 설명 문단을 여기에 넣지 않는다 — 설명이 필요하면 그 설명이
 * 필요한 자리(해당 섹션의 첫 행)에 둔다.
 */
export function PageHero({ title, description, emoji, actions, className }: PageHeroProps) {
  return (
    <section className={cn('flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em]">
          {/* `alt=""` + `aria-hidden` — 스크린리더에는 제목 글자만 읽힌다. 이모지는 뜻을 보태는
              장식이지 이름의 일부가 아니다 */}
          {emoji && <Image src={emoji} alt="" width={32} height={32} className="h-8 w-8 shrink-0" aria-hidden />}
          {title}
        </h1>
        {description && (
          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

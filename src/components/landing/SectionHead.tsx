import type { ReactNode } from 'react';

/**
 * 랜딩 본문 섹션의 «머리» — 배지 → 제목 → 리드, 세 층 고정.
 *
 * 2026-09-18 ny 지적: 섹션 리듬이 어색하다. 실측해 보니 바깥 여백은 네 섹션 모두
 * `padding-top: 120px` 로 같았고, 어긋난 건 «머리»였다.
 *
 *   문제       코랄 배지   h2 48px   좌측
 *   작동 방식  (없음)      h2 28px   좌측
 *   붙이는 것  이모지 72px h2 28px   좌측
 *   마지막 CTA 이모지 88px h2 40px   중앙
 *
 * 히어로 82px 에서 48 → 28 → 28 → 40 으로 오르내리고, 제목 앞자리 신호도
 * 배지·없음·이모지·이모지로 넷이 다 달랐다. 눈이 «여기가 새 장이다»를 매번
 * 다른 방식으로 배워야 했다. 이 컴포넌트가 그 셋을 하나로 묶는다.
 *
 * ⚠️ 제목 크기는 `--fs-h2`(모바일 28px · 데스크톱 40px) 하나만 쓴다. 섹션마다
 *    clamp 를 따로 쓰면 다시 갈라진다 — 문제 섹션이 그렇게 48px 가 됐었다.
 *
 * ⚠️ 섹션 «머리»의 장식 이모지는 배지로 대체했다(ny 결정 9/18). 본문 콘텐츠로
 *    쓰이는 이모지 — 작동 방식 4단계의 넷 — 는 그대로다. 애플 3D 세트를 다른
 *    스타일로 갈아끼우는 건 이번 회차 대상이 아니다.
 */
interface SectionHeadProps {
  /** 앞 섹션과 잇는 한마디. 코랄 배지로 앉는다. */
  kicker: string;
  title: ReactNode;
  lead?: ReactNode;
  /** 마지막 CTA 만 중앙 정렬이다 — 페이지의 마침표라서. */
  align?: 'left' | 'center';
  className?: string;
}

export function SectionHead({ kicker, title, lead, align = 'left', className = '' }: SectionHeadProps) {
  const centered = align === 'center';
  return (
    <div className={`${centered ? 'text-center' : ''} ${className}`}>
      <span
        className="inline-flex items-center rounded-full bg-[var(--coral-tint)] px-[11px] py-1 font-semibold text-[var(--coral-strong)]"
        style={{ fontSize: 13, letterSpacing: '-0.01em' }}
      >
        {kicker}
      </span>
      <h2
        className="mt-5 font-bold lg:mt-6"
        style={{
          fontSize: 'var(--fs-h2)',
          lineHeight: 1.2,
          letterSpacing: '-0.035em',
          textWrap: 'pretty',
          wordBreak: 'keep-all',
        }}
      >
        {title}
      </h2>
      {lead && (
        <p
          className={`mt-4 text-[var(--l-muted)] lg:mt-5 ${centered ? 'mx-auto max-w-[520px]' : 'max-w-[560px]'}`}
          style={{
            fontSize: 'var(--fs-body)',
            lineHeight: 1.7,
            letterSpacing: '-0.01em',
            textWrap: 'pretty',
            wordBreak: 'keep-all',
          }}
        >
          {lead}
        </p>
      )}
    </div>
  );
}

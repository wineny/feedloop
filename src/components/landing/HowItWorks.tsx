/**
 * 「작동 방식」 섹션 — 4단계 타임라인 + 닫힌 루프 증거.
 *
 * 2026-09-18 «닫힌 루프»(옛 `LoopSection`)를 여기로 합쳤다. 두 섹션이 같은 4단계를
 * 같은 이모지 넷으로 두 번 말하고 있었다 — 가로 타임라인 한 번, 원형 다이어그램 한 번.
 * 세로 600px 거리에서 같은 그림을 두 번 보는 구조였다(ny 지시: 겹치면 하나로 합친다).
 * 원형 다이어그램은 버렸고, 그 안에만 있던 «대화 왕복»과 «사실 3줄»을 아래로 옮겨 왔다.
 *
 * ⚠️ 단계 이름은 히어로(`HeroSection.tsx` STEPS)와 «글자까지» 같아야 한다.
 *    예전엔 히어로가 「피드백·AI 분류·수정 PR·반영 알림」, 여기가 「수집·AI 분류·PR 생성·되돌림」이라
 *    같은 넷을 두 이름으로 불렀다. 히어로 쪽으로 통일했다(ny 결정 2026-09-18).
 *
 * ⚠️ 2026-09-18 실물 임베드는 이 섹션을 떠나 독립 섹션(`DemoSection`)이 됐다. 여기 h3 아래에
 *    있으니 «다른 섹션보다 한 급 낮은 머리»라 데모인 줄 모르겠다는 지적이 있었다(ny).
 *
 * ⚠️ 방문자 쪽 입구는 랜딩에서 「피드루프 챗봇」이라 부른다. 앱 내부 라벨
 *    (`lib/channel/labels.ts` 의 `SOURCE_LABEL.web` = 「웹 위젯」)은 «그대로 둔다» —
 *    내부 화면 34곳이 그 말을 쓰고 있어 제출 직전에 흔들 값이 아니다.
 */
import { useTranslations } from 'next-intl';
import { SectionHead } from './SectionHead';
import { dynamicT } from '@/i18n/dynamic';

const steps = [
  {
    key: 'feedback',
    emoji: '/emoji/speech_balloon_3d.png',
  },
  {
    key: 'classify',
    emoji: '/emoji/card_index_dividers_3d.png',
  },
  {
    key: 'fix',
    emoji: '/emoji/hammer_and_wrench_3d.png',
  },
  {
    key: 'notify',
    emoji: '/emoji/bell_3d.png',
  },
];

export function HowItWorks() {
  const t = useTranslations('landing');
  return (
    <section id="how" className="mx-auto max-w-[1200px] px-6" style={{ paddingTop: 'var(--space-section)' }}>
      <SectionHead
        kicker={t('how.kicker')}
        title={t('how.title')}
        lead={t('how.lead')}
      />

      <div className="relative mt-10 lg:mt-12">
        {/* 데스크톱 진행선 — 이모지 세로 중심(28px)을 지난다 */}
        <svg
          width="100%"
          height="2"
          viewBox="0 0 100 2"
          preserveAspectRatio="none"
          className="absolute inset-x-0 top-[27px] hidden lg:block"
          aria-hidden="true"
        >
          <path
            d="M0 1H100"
            stroke="var(--coral)"
            strokeWidth="1.8"
            strokeDasharray="10 8"
            vectorEffect="non-scaling-stroke"
            style={{ animation: 'dash 1.6s linear infinite' }}
          />
        </svg>

        <div className="relative flex flex-col gap-12 lg:grid lg:grid-cols-4 lg:gap-8">
          {steps.map((step) => (
            <div key={step.key}>
              {/* 모바일: 이모지+제목 한 줄 / 데스크톱: 이모지가 선 위에, 제목은 아래 */}
              <div className="flex items-center gap-3.5 lg:block">
                <span className="inline-flex bg-[var(--bg)] lg:pr-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={step.emoji} alt="" loading="lazy" className="h-11 w-11 lg:h-14 lg:w-14" />
                </span>
                <h3
                  className="font-bold lg:mt-5"
                  style={{ fontSize: 'var(--fs-h3)', letterSpacing: '-0.01em' }}
                >
                  {dynamicT(t)(`steps.${step.key}.title`)}
                </h3>
              </div>
              <p className="mt-3 text-[var(--l-muted)]" style={{ fontSize: 'var(--fs-body)', lineHeight: 1.7, textWrap: 'pretty' }}>
                {dynamicT(t)(`steps.${step.key}.desc`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

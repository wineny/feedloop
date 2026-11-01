import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { HeroPhone } from './HeroPhone';
import { PrimaryCta } from './PrimaryCta';
import { DemoAnchor } from './LiveDemo';
import { Link } from '@/i18n/navigation';

/**
 * 히어로 — 제출용 대표 이미지(`docs/15-제출/cover/hero.html`)의 디자인을 그대로 가져왔다.
 * 딥 코랄 지면 위에 흰 글자, 「코드」만 속을 비운 테두리, 루프 네 단계를 한 줄로,
 * 오른쪽에 살짝 기운 폰 한 대. 커버와 랜딩이 같은 얼굴을 갖는다.
 *
 * 커버에 없던 것 — 나브·CTA·부제는 페이지에 필요해서 같은 언어로 더했다.
 * 커버에만 있던 워드마크는 나브가 이미 갖고 있어 뺐다.
 */
const fadeUp = (delay: number) => ({ animation: `fadeUp .6s ease-out ${delay}s both` });

/** 커버와 같은 3겹 그라데이션. 픽셀 대신 비율이라 폭이 달라져도 결이 유지된다. */
const COVER_FIELD =
  'radial-gradient(56% 99% at 76% 50%, rgba(255,176,146,.72), transparent 56%),' +
  'radial-gradient(71% 103% at 18% 50%, rgba(214,62,50,.55), transparent 70%),' +
  'linear-gradient(120deg, #cf3b2f 0%, #e6524492 46%, #b92e25 100%)';

const STEP_KEYS = ['feedback', 'classify', 'fix', 'notify'] as const;

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5z" />
    </svg>
  );
}

const em = (chunks: ReactNode) => <em className="hero-outline">{chunks}</em>;

export function HeroSection() {
  const t = useTranslations('landing');
  return (
    <section
      data-landing-hero /* LandingNav 가 「코랄 지면을 다 지났는가」를 이 높이로 잰다 */
      className="relative overflow-hidden text-white"
      style={{ background: COVER_FIELD }}
    >
      <div /* 위 여백 = 나브 높이 + 원래 여백. 나브는 sticky·h-0 이라 흐름에서 자리를 안 차지한다 */
        className="relative mx-auto grid max-w-[1200px] gap-12 px-6 pb-16 pt-[calc(var(--nav-h)+24px)] lg:grid-cols-[minmax(0,1fr)_540px] lg:items-center lg:gap-10 lg:pb-[104px] lg:pt-[calc(var(--nav-h)+32px)]">
        <div>
          <h1
            className="font-extrabold"
            style={{
              fontSize: 'clamp(34px, 6.4vw, 82px)',
              lineHeight: 1.12,
              letterSpacing: '-0.045em',
              ...fadeUp(0.15),
            }}
          >
            {t('hero.line1')}
            <br />
            {t.rich('hero.line2', { em })}
            <br />
            {t('hero.line3')}
          </h1>

          {/* 제품이 무엇인지 히어로에서 말하는 유일한 줄이다 (ny 결정 2026-09-18).
              h1 은 제출용 커버와 같은 얼굴이라 손대지 않고, 구체는 이 한 줄이 맡는다.
              이 줄이 없으면 랜딩은 «무엇을 붙이는지»를 세 번째 섹션까지 말하지 않는다. */}
          <p
            className="mt-5 max-w-[30ch] font-medium text-white/90 lg:mt-6 lg:max-w-[34ch]"
            style={{
              fontSize: 'clamp(15px, 1.45vw, 20px)',
              lineHeight: 1.6,
              letterSpacing: '-0.015em',
              textWrap: 'pretty',
              /* 한국어는 어절 안에서 끊기면 「AI / 가 분류하고」처럼 읽힌다 */
              wordBreak: 'keep-all',
              ...fadeUp(0.22),
            }}
          >
            {t('hero.sub')}
          </p>

          <div className="mt-6 h-1.5 w-[110px] rounded-full bg-white/85 lg:mt-7" style={fadeUp(0.3)} />
          <div
            className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-semibold text-white/92 lg:mt-5 lg:gap-x-4"
            style={{ fontSize: 'clamp(15px, 1.5vw, 21px)', ...fadeUp(0.3) }}
          >
            {STEP_KEYS.map((key, i) => (
              <span key={key} className="flex items-center gap-x-3 lg:gap-x-4">
                {i > 0 && <i className="not-italic text-[#ffd9cf]">→</i>}
                {t(`steps.${key}.title`)}
              </span>
            ))}
          </div>

          <div className="mt-9 flex flex-col gap-2.5 lg:mt-10 lg:flex-row lg:gap-3" style={fadeUp(0.45)}>
            <PrimaryCta
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[16px] font-bold text-[#b92e25]"
            >
              {t('cta.primary')}
            </PrimaryCta>
            {/* 팝업을 열지 않고 페이지 안 실물 임베드(`#try`)로 내려간다 — ny 결정 9/18 */}
            <DemoAnchor className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/45 px-6 text-[16px] font-semibold text-white">
              <PlayIcon />
              {t('hero.watchDemo')}
            </DemoAnchor>
          </div>
          <p className="mt-4 text-[14px] text-white/72 lg:text-[15px]" style={fadeUp(0.6)}>
            {t('hero.setupNote')}
          </p>
          {/* PayPal 쪽 기능이 랜딩에서 안 보이던 것을 한 줄로 드러낸다. 주 CTA 보다 작게 — 보조 진입점이다 */}
          <Link
            href="/pricing"
            className="mt-5 inline-flex max-w-full items-start gap-2 rounded-2xl bg-white/12 px-3.5 py-2 text-[13px] font-semibold leading-snug text-white ring-1 ring-white/30 transition-colors hover:bg-white/20 lg:text-[14px]"
            style={fadeUp(0.6)}
          >
            <span className="shrink-0 rounded-full bg-white px-2 py-px text-[11px] font-bold uppercase tracking-wide text-[#b92e25] lg:text-[12px]">
              {t('hero.paypalTag')}
            </span>
            <span>
              {t('hero.paypalLine')} <span aria-hidden="true">→</span>
            </span>
          </Link>
        </div>

        <div className="flex flex-col items-center lg:items-end" style={fadeUp(0.6)}>
          {/* 모바일은 한 대만 — 390px 에 두 대를 겹치면 둘 다 안 읽힌다 */}
          <HeroPhone width={250} screen="chat" className="lg:hidden" />

          {/* 데스크톱은 두 대를 겹친다. 앞이 운영자 대시보드, 뒤가 방문자 대화 —
              「고객이 남긴 말」과 「그걸 받는 쪽 화면」이 한 장에 같이 있다.
              앞을 대시보드로 둔 건 루프가 «닫힌다»는 증거가 이 화면에 있기 때문이다. */}
          <div className="relative hidden lg:block" style={{ width: 540, height: 690 }}>
            {/* 뒤 — 방문자 대화. 왼쪽 일부가 대시보드에 가린다 */}
            <HeroPhone
              width={296}
              screen="chat"
              rotate={-4}
              className="absolute"
              style={{ left: 240, top: 78, zIndex: 1 }}
            />
            {/* 앞 — 운영자 대시보드. 가리는 것이 없어 루프 지표 넷이 온전히 읽힌다 */}
            <HeroPhone
              width={280}
              screen="dashboard"
              rotate={-10}
              className="absolute"
              style={{ left: 14, top: 6, zIndex: 2 }}
            />
          </div>

          <p className="mt-6 text-[13px] text-white/70 lg:mt-3">{t('hero.screensNote')}</p>
        </div>
      </div>
    </section>
  );
}

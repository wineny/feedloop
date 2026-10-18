import { HeroPhone } from './HeroPhone';
import { PrimaryCta } from './PrimaryCta';
import { DemoAnchor } from './LiveDemo';
import { AWARD_LINE, AWARD_RATIO, DEMO_LABEL, PRIMARY_CTA_LABEL } from './constants';

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

const STEPS = ['피드백', 'AI 분류', '수정안', '반영 알림'];

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5z" />
    </svg>
  );
}

export function HeroSection() {
  return (
    <section
      data-landing-hero /* LandingNav 가 「코랄 지면을 다 지났는가」를 이 높이로 잰다 */
      className="relative overflow-hidden text-white"
      style={{ background: COVER_FIELD }}
    >
      <div /* 위 여백 = 나브 높이 + 원래 여백. 나브는 sticky·h-0 이라 흐름에서 자리를 안 차지한다 */
        className="relative mx-auto grid max-w-[1200px] gap-12 px-6 pb-16 pt-[calc(var(--nav-h)+24px)] lg:grid-cols-[minmax(0,1fr)_540px] lg:items-center lg:gap-10 lg:pb-[104px] lg:pt-[calc(var(--nav-h)+32px)]">
        <div>
          {/* 수상 알약 — 예전 알약과 같은 흰 반투명 결에, 테두리·바탕만 한 단계 진하게 해 첫눈에 걸리게 했다 */}
          <div
            className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border border-white/45 bg-white/15 px-3.5 text-[13px] font-semibold text-white lg:h-9 lg:px-4 lg:text-[14px]"
            style={fadeUp(0)}
          >
            <span aria-hidden="true">🏆</span>
            {AWARD_LINE}
            <span className="hidden font-medium text-white/75 sm:inline">· {AWARD_RATIO}</span>
          </div>

          <h1
            className="mt-6 font-extrabold"
            style={{
              fontSize: 'clamp(34px, 6.4vw, 82px)',
              lineHeight: 1.12,
              letterSpacing: '-0.045em',
              ...fadeUp(0.15),
            }}
          >
            고객의 말이
            <br />
            <em className="hero-outline">코드</em>가 되어
            <br />
            돌아옵니다
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
            내 서비스에 챗봇 한 줄을 붙이면, 고객이 남긴 말을 AI가 분류하고 수정안까지 올립니다.
          </p>

          <div className="mt-6 h-1.5 w-[110px] rounded-full bg-white/85 lg:mt-7" style={fadeUp(0.3)} />
          <div
            className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-semibold text-white/92 lg:mt-5 lg:gap-x-4"
            style={{ fontSize: 'clamp(15px, 1.5vw, 21px)', ...fadeUp(0.3) }}
          >
            {STEPS.map((step, i) => (
              <span key={step} className="flex items-center gap-x-3 lg:gap-x-4">
                {i > 0 && <i className="not-italic text-[#ffd9cf]">→</i>}
                {step}
              </span>
            ))}
          </div>

          <div className="mt-9 flex flex-col gap-2.5 lg:mt-10 lg:flex-row lg:gap-3" style={fadeUp(0.45)}>
            <PrimaryCta
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[16px] font-bold text-[#b92e25]"
            >
              {PRIMARY_CTA_LABEL}
            </PrimaryCta>
            {/* 팝업을 열지 않고 페이지 안 실물 임베드(`#try`)로 내려간다 — ny 결정 9/18 */}
            <DemoAnchor className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/45 px-6 text-[16px] font-semibold text-white">
              <PlayIcon />
              {DEMO_LABEL} 보기
            </DemoAnchor>
          </div>
          <p className="mt-4 text-[14px] text-white/72 lg:text-[15px]" style={fadeUp(0.6)}>
            스크립트 한 줄 · 설치 5분
          </p>
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

          <p className="mt-6 text-[13px] text-white/70 lg:mt-3">화면은 실제 제품 · 데이터는 예시</p>
        </div>
      </div>
    </section>
  );
}

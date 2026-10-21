import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';

interface HeroPhoneProps {
  /** 기기 바깥 폭(px). 나머지 치수는 전부 여기서 비례로 뽑는다. */
  width: number;
  /** 화면 안에 무엇을 보여줄지 — 운영자 대시보드 캡처 / 방문자 위젯 대화 */
  screen?: 'dashboard' | 'chat';
  /** 기울기(도). 기본은 커버와 같은 -5도 */
  rotate?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * 히어로의 폰 한 대 — 제출용 대표 이미지(`docs/15-제출/cover/hero.html`)에서 그대로 옮겼다.
 *
 * 원본은 화면 폭을 런타임에 재서(`--sw`) 치수를 잡았는데, 여기서는 width 하나로
 * 전부 계산한다. 잴 것이 없으니 JS 도, 레이아웃 흔들림도 없다.
 * 비율은 원본과 같다 — 기기 870:1740, 화면 여백 2.9%.
 */
export function HeroPhone({ width, screen = 'dashboard', rotate = -5, className, style }: HeroPhoneProps) {
  const height = width * 2;
  const pad = width * 0.029;
  // 화면 실측 폭 — 원본 CSS 의 --sw 와 같은 값이다
  const sw = width - pad * 2;

  return (
    <div className={className} style={{ ...style, transform: `rotate(${rotate}deg)` }} aria-hidden="true">
      <div
        style={{
          width,
          height,
          borderRadius: width * 0.1276,
          padding: pad,
          boxSizing: 'border-box',
          background:
            'linear-gradient(152deg,#5a5f5e 0%,#232826 18%,#0e1211 46%,#171b1a 72%,#4a4f4e 100%)',
          boxShadow: [
            '0 0 0 1.5px rgba(0,0,0,.35)',
            '0 2px 0 rgba(255,255,255,.22) inset',
            '0 -2px 0 rgba(255,255,255,.10) inset',
            '-40px 70px 110px -30px rgba(92,44,38,.42)',
            '-12px 24px 46px -16px rgba(92,44,38,.28)',
          ].join(','),
        }}
      >
        <div
          className="relative h-full overflow-hidden"
          style={{
            borderRadius: width * 0.1,
            background: '#faf8f7',
            boxShadow: '0 0 0 1.5px rgba(0,0,0,.28) inset',
          }}
        >
          {/* 상태바 */}
          <div
            className="absolute inset-x-0 top-0 z-[3] flex items-center justify-between bg-white font-semibold text-[var(--ink)]"
            style={{
              height: sw * 0.137,
              padding: `0 ${sw * 0.075}px 0 ${sw * 0.085}px`,
              fontSize: sw * 0.043,
              letterSpacing: '-0.01em',
            }}
          >
            <span>10:02</span>
            <span className="flex items-center" style={{ gap: sw * 0.018 }}>
              <svg viewBox="0 0 20 14" fill="currentColor" style={{ height: sw * 0.036, width: 'auto', display: 'block' }}>
                <rect x="0" y="9" width="3" height="5" rx="1" />
                <rect x="5" y="6.5" width="3" height="7.5" rx="1" />
                <rect x="10" y="3.5" width="3" height="10.5" rx="1" />
                <rect x="15" y="0" width="3" height="14" rx="1" />
              </svg>
              <svg viewBox="0 0 18 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ height: sw * 0.036, width: 'auto', display: 'block' }}>
                <path d="M1.2 4.2a11 11 0 0 1 15.6 0" />
                <path d="M4.3 7.4a6.6 6.6 0 0 1 9.4 0" />
                <path d="M7.4 10.5a2.2 2.2 0 0 1 3.2 0" />
              </svg>
              <svg viewBox="0 0 27 13" fill="none" style={{ height: sw * 0.036, width: 'auto', display: 'block' }}>
                <rect x=".7" y=".7" width="22" height="11.6" rx="3.2" stroke="currentColor" strokeOpacity=".38" strokeWidth="1.2" />
                <rect x="2.3" y="2.3" width="18.8" height="8.4" rx="2" fill="currentColor" />
                <path d="M24.6 4.6v3.8a2.1 2.1 0 0 0 0-3.8z" fill="currentColor" fillOpacity=".45" />
              </svg>
            </span>
          </div>

          {/* 카메라 컷아웃 */}
          <div
            className="absolute left-1/2 z-[4] -translate-x-1/2 rounded-full bg-[#050706]"
            style={{ top: sw * 0.028, width: sw * 0.31, height: sw * 0.094 }}
          />

          {/* 화면 — 상태바 아래에서 시작하고 아래는 홈 인디케이터 자리를 비운다 */}
          <div className="absolute overflow-hidden" style={{ inset: `${sw * 0.137}px 0 ${sw * 0.048}px 0` }}>
            {screen === 'chat' ? (
              <ChatScreen sw={sw} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/landing/hero-dashboard.png"
                alt=""
                className="block h-full w-full object-cover object-top"
              />
            )}
          </div>

          {/* 홈 인디케이터 */}
          <div
            className="absolute left-1/2 z-[4] -translate-x-1/2 rounded-full"
            style={{ bottom: sw * 0.018, width: sw * 0.355, height: sw * 0.0125, background: 'rgba(9,12,11,.86)' }}
          />
        </div>
      </div>
    </div>
  );
}


/**
 * 폰 안의 방문자 위젯 대화.
 *
 * 치수·색은 눈대중이 아니라 `public/widget.js` 의 실제 CSS 값을 그대로 옮긴 것이다.
 * 위젯 패널이 360px 폭이므로 k = 화면폭/360 을 곱해 줄이기만 한다 —
 * 그래야 폰 크기를 바꿔도 실물과 같은 비례가 유지된다.
 * ⚠️ widget.js 의 .hd/.bub/.card/.tool/.send 를 고치면 여기도 같이 고쳐야 한다.
 */
function ChatScreen({ sw }: { sw: number }) {
  const t = useTranslations('landing.phone');
  // 위젯 패널 실제 폭이 360px 이다
  const k = sw / 360;
  const s = (px: number) => px * k;

  return (
    // ⚠️ 히어로 섹션이 text-white 라 글자색을 여기서 되돌린다.
    // 안 하면 흰 말풍선 위 글자가 흰색이 되어 통째로 사라진다(실측으로 잡았다).
    <div className="flex h-full flex-col bg-white text-[var(--ink)]">
      {/* .hd */}
      <div
        className="flex flex-shrink-0 items-center border-b border-[#eeeae9]"
        style={{ gap: s(10), padding: `${s(14)}px ${s(14)}px ${s(12)}px` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/dailymarket-profile.jpg"
          alt=""
          className="flex-shrink-0 rounded-full object-cover"
          style={{ width: s(28), height: s(28), objectPosition: '50% 46%' }}
        />
        <span className="flex min-w-0 flex-1 flex-col" style={{ gap: s(1) }}>
          <span className="truncate font-bold" style={{ fontSize: s(14), letterSpacing: '-0.01em' }}>{t('botName')}</span>
          <span className="truncate text-[#6e6968]" style={{ fontSize: s(11) }}>{t('botStatus')}</span>
        </span>
        <span className="flex flex-shrink-0 items-center justify-center text-[#a39d9b]" style={{ width: s(32), height: s(32) }}>
          <svg width={s(16)} height={s(16)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </span>
      </div>

      {/* .body — 실제 위젯은 흰 바탕이다 */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white"
        style={{ padding: `${s(16)}px ${s(14)}px`, gap: s(12) }}
      >
        {/* 인사말 — 실제 위젯이 열리자마자 띄우는 첫 말풍선.
            mt-auto 로 대화를 아래쪽에 붙여 «이미 오간 대화»처럼 보이게 한다 */}
        <div className="mt-auto flex items-start" style={{ gap: s(8) }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/dailymarket-profile.jpg"
            alt=""
            className="flex-shrink-0 rounded-full object-cover"
            style={{ width: s(28), height: s(28), objectPosition: '50% 46%' }}
          />
          <div
            className="border border-[#eeeae9] bg-white"
            style={{
              maxWidth: '84%',
              padding: `${s(10)}px ${s(13)}px`,
              borderRadius: `${s(14)}px ${s(14)}px ${s(14)}px ${s(4)}px`,
              fontSize: s(14),
              lineHeight: 1.55,
              letterSpacing: '-0.01em',
            }}
          >
            {t('greeting')}
          </div>
        </div>

        {/* .row.me > .bub.me — 방문자 말풍선은 잉크, 오른쪽 아래 모서리만 각지다 */}
        <div className="flex justify-end">
          <div
            className="bg-[var(--ink)] text-white"
            style={{
              maxWidth: '84%',
              padding: `${s(10)}px ${s(13)}px`,
              borderRadius: `${s(14)}px ${s(14)}px ${s(4)}px ${s(14)}px`,
              fontSize: s(14),
              lineHeight: 1.55,
              letterSpacing: '-0.01em',
            }}
          >
            {t('visitorMessage')}
          </div>
        </div>

        {/* .row — 아바타 + 이름 + AI 배지 + 시각, 그 아래 .bub.op */}
        <div className="flex flex-col" style={{ gap: s(5) }}>
          <div className="flex items-center text-[#6e6968]" style={{ gap: s(5), marginLeft: s(36), fontSize: s(11) }}>
            {t('botName')}
            <span
              className="rounded-full bg-[var(--demo-tint)] font-bold text-[var(--demo-strong)]"
              style={{ fontSize: s(9.5), padding: `${s(1)}px ${s(6)}px`, lineHeight: 1.4 }}
            >
              AI
            </span>
            <span className="tabular-nums text-[#a39d9b]" style={{ fontSize: s(10.5) }}>{t('time')}</span>
          </div>
          <div className="flex items-start" style={{ gap: s(8) }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/landing/dailymarket-profile.jpg"
              alt=""
              className="flex-shrink-0 rounded-full object-cover"
              style={{ width: s(28), height: s(28), objectPosition: '50% 46%' }}
            />
            <div
              className="border border-[#eeeae9] bg-white"
              style={{
                maxWidth: '84%',
                padding: `${s(10)}px ${s(13)}px`,
                borderRadius: `${s(14)}px ${s(14)}px ${s(14)}px ${s(4)}px`,
                fontSize: s(14),
                lineHeight: 1.55,
                letterSpacing: '-0.01em',
              }}
            >
              {t('aiReply')}
            </div>
          </div>
        </div>

        {/* .card — 되돌림. 아바타 폭(36)만큼 들여쓴다 */}
        <div
          className="flex flex-col border border-[var(--demo-tint-2)] bg-[var(--demo-tint)]"
          style={{ marginLeft: s(36), padding: `${s(12)}px ${s(14)}px`, borderRadius: s(14), gap: s(6) }}
        >
          <div className="flex items-center" style={{ gap: s(7) }}>
            <span
              className="flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--demo)]"
              style={{ width: s(17), height: s(17) }}
            >
              <svg width={s(10)} height={s(10)} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5L20 7" />
              </svg>
            </span>
            <b style={{ fontSize: s(13.5) }}>{t('fixedTitle')}</b>
          </div>
          <p style={{ margin: 0, fontSize: s(13), lineHeight: 1.55 }}>
            {t('fixedBody')}
          </p>
          <div className="flex items-center justify-between" style={{ marginTop: s(3) }}>
            <span className="font-bold text-[var(--demo-strong)]" style={{ fontSize: s(13) }}>{t('viewPr')}</span>
          </div>
          <div className="flex flex-wrap" style={{ gap: s(6) }}>
            {[t('chipYes'), t('chipNo')].map((label) => (
              <span
                key={label}
                className="whitespace-nowrap rounded-full border border-[#eeeae9] bg-[#f6f3f2] text-[#6e6968]"
                style={{ padding: `${s(7)}px ${s(13)}px`, fontSize: s(12.5), lineHeight: 1.3 }}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* .ft — 도구 줄 + 입력줄 + 크레딧 */}
      <div className="flex-shrink-0 border-t border-[#eeeae9] bg-white">
        <div className="flex items-center" style={{ gap: s(6), padding: `${s(10)}px ${s(10)}px 0` }}>
          {[
            { label: t('toolPick'), icon: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3.4M12 18.6V22M22 12h-3.4M5.4 12H2" /></> },
            { label: t('toolHuman'), icon: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" /></> },
          ].map((tool) => (
            <span
              key={tool.label}
              className="inline-flex flex-shrink-0 items-center whitespace-nowrap rounded-full border border-[#eeeae9] bg-white font-semibold text-[var(--ink)]"
              style={{ gap: s(6), height: s(32), padding: `0 ${s(12)}px 0 ${s(10)}px`, fontSize: s(12.5), letterSpacing: '-0.01em' }}
            >
              <svg width={s(14)} height={s(14)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                {tool.icon}
              </svg>
              {tool.label}
            </span>
          ))}
        </div>

        <div className="flex items-end" style={{ gap: s(8), padding: `${s(8)}px ${s(10)}px ${s(6)}px` }}>
          <div
            className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap rounded-xl border border-[#d9d3d1] text-[var(--faint)]"
            style={{ height: s(42), padding: `0 ${s(12)}px`, fontSize: s(13.5), borderRadius: s(12) }}
          >
            {t('placeholder')}
          </div>
          <div
            className="flex flex-shrink-0 items-center font-bold text-white"
            style={{ background: 'var(--demo)', borderRadius: s(12), height: s(42), padding: `0 ${s(15)}px`, fontSize: s(13) }}
          >
            {t('send')}
          </div>
        </div>

        <div className="flex justify-end text-[var(--faint)]" style={{ padding: `0 ${s(12)}px ${s(9)}px`, fontSize: s(11) }}>
          Powered by Feedloop
        </div>
      </div>
    </div>
  );
}

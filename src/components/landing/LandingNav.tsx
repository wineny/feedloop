'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { LoginLink, PrimaryCta } from './PrimaryCta';
import { DemoAnchor, scrollToHash } from './LiveDemo';
import { LogoMark } from './Logo';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { Link as LocaleLink } from '@/i18n/navigation';

const links = [{ labelKey: 'how', href: '#how' }] as const;

/** 페이지 안 앵커는 휙 점프하지 않고 부드럽게. 진짜 href 는 남겨 JS 없이도 닿는다 */
function handleAnchorClick(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  scrollToHash(href);
}

/**
 * 랜딩 상단 나브 — 스크롤해도 맨 위에 붙어 있는다.
 *
 * **자리를 차지하지 않는다.** 바깥은 `h-0` 이고 막대는 그 밖으로 흘러넘친다.
 * 히어로의 딥 코랄 지면이 페이지 맨 위에서 시작해야 하는데, 나브가 흐름에서
 * 높이를 가져가면 그만큼 지면이 아래로 밀리기 때문이다. 대신 히어로 안쪽
 * 컨테이너가 `--nav-h` 만큼 위 여백을 갖는다. **높이는 `globals.css` 의
 * `--nav-h` 한 곳에서만 정한다** — 막대·히어로 여백·앵커 여백이 전부 거기서
 * 파생되므로, 높이를 바꿀 일이 생기면 그 변수 하나만 고치면 된다.
 *
 * 아래 선은 `border` 가 아니라 `inset` 그림자다. 테두리는 투명해도 1px 을
 * 차지해서 막대 높이가 `--nav-h` 와 어긋난다.
 *
 * **두 얼굴이다.** 코랄 지면이 막대 뒤에 있는 동안은 투명 + 흰 글자,
 * 지면이 다 지나가면 바탕·블러·아래 선을 켜고 글자를 잉크색으로 바꾼다.
 * 기준이 「조금이라도 스크롤」이 아니라 「히어로가 다 지나감」인 이유는,
 * 코랄 위에 흰 막대가 뜨면 지면이 두 동강 난 것처럼 보이기 때문이다.
 *
 * ⚠️ 히어로 `<section>` 은 `overflow-hidden` 이라 그 안에 두면 sticky 가 죽는다.
 * 그래서 이 조각은 `page.tsx` 가 히어로 **바깥**에서 렌더한다.
 */
export function LandingNav() {
  const t = useTranslations('landing');
  const [open, setOpen] = useState(false);
  const handleClose = () => setOpen(false);
  // 히어로 코랄 지면을 다 지났는가 — 나브의 두 얼굴을 가르는 유일한 상태
  const [scrolled, setScrolled] = useState(false);
  const menuWrapRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const hero = document.querySelector<HTMLElement>('[data-landing-hero]');
    // 막대 뒤에 코랄이 한 점도 안 남는 지점. 히어로를 못 찾으면 「조금이라도 내리면」으로 물러선다
    let limit = 8;
    const measure = () => {
      const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 60;
      limit = hero ? Math.max(8, hero.offsetHeight - navH) : 8;
    };
    const onScroll = () => setScrolled(window.scrollY > limit);
    const onResize = () => {
      measure();
      onScroll();
    };
    onResize(); // 새로고침·뒤로가기가 페이지 중간에서 시작할 수 있다
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // 모바일 메뉴는 이제 sticky 라 페이지 끝까지 따라온다 — 열어둔 채 잊히지 않게 닫는 길을 둘 더 준다
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const onCoral = !scrolled;
  const fg = onCoral ? 'text-white' : 'text-[var(--ink)]';
  const fgMuted = onCoral ? 'text-white/80' : 'text-[var(--l-muted)]';

  return (
    <header ref={menuWrapRef} className="sticky top-0 z-50 h-0">
      <div
        className={cn(
          // 자식의 `color` 는 부모 transition 을 물려받지 않는다 — 글자만 먼저 튀지 않게 함께 건다
          'transition-colors duration-200 [&_*]:transition-colors [&_*]:duration-200',
          !onCoral &&
            'bg-[var(--bg)]/85 shadow-[inset_0_-1px_0_var(--line),0_1px_3px_rgba(25,29,27,.06)] backdrop-blur-md',
        )}
      >
        {/* 데스크톱 */}
        <nav
          className="mx-auto hidden h-[var(--nav-h)] max-w-[1200px] items-center justify-between px-6 lg:flex"
          aria-label={t('nav.main')}
        >
          <Link href="/" className={cn('flex items-center gap-2.5 text-xl font-extrabold tracking-[-0.02em]', fg)}>
            <LogoMark size={26} className={onCoral ? 'text-white' : 'text-[var(--coral)]'} />
            Feedloop
          </Link>
          <div className={cn('flex gap-9 text-[15px] font-medium', fgMuted)}>
            {links.map((l) => (
              <a key={l.href} href={l.href} onClick={(e) => handleAnchorClick(e, l.href)}>
                {t(`nav.${l.labelKey}`)}
              </a>
            ))}
            <DemoAnchor className="text-[15px] font-medium" />
            {/* PayPal 데모 상점 — 심사위원이 랜딩에서 바로 찾게 한다 */}
            <LocaleLink href="/pricing">{t('nav.paypalDemo')}</LocaleLink>
          </div>
          <div className="flex items-center gap-5">
            <LocaleSwitcher className={fg} />
            <LoginLink className={cn('text-[15px] font-medium', fg)} />
            <PrimaryCta
              className={cn(
                'inline-flex h-11 items-center gap-2 rounded-full px-[18px] text-[15px] font-bold',
                onCoral ? 'bg-white text-[#b92e25]' : 'bg-[var(--ink)] text-white',
              )}
            >
              {t('cta.primary')}
            </PrimaryCta>
          </div>
        </nav>

        {/* 모바일 */}
        <nav className="flex h-[var(--nav-h)] items-center justify-between px-6 lg:hidden" aria-label={t('nav.main')}>
          <Link href="/" className={cn('flex items-center gap-2 text-lg font-extrabold tracking-[-0.02em]', fg)}>
            <LogoMark size={22} className={onCoral ? 'text-white' : 'text-[var(--coral)]'} />
            Feedloop
          </Link>
          <div className="flex items-center gap-2">
          <LocaleSwitcher className={fg} />
          <button
            type="button"
            aria-label={open ? t('nav.menuClose') : t('nav.menuOpen')}
            aria-expanded={open}
            aria-controls="landing-mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className={cn('p-1', fg)}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
          </div>
        </nav>
      </div>
      {open && (
        <div
          id="landing-mobile-menu"
          className="absolute inset-x-4 top-[calc(var(--nav-h)+4px)] z-50 rounded-[14px] border border-[var(--line)] bg-[var(--bg)] p-2 shadow-lg lg:hidden"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={(e) => {
                handleClose();
                handleAnchorClick(e, l.href);
              }}
              className="block rounded-[10px] px-4 py-3 text-[15px] font-medium text-[var(--ink)]"
            >
              {t(`nav.${l.labelKey}`)}
            </a>
          ))}
          <a
            href="#try"
            onClick={(e) => {
              handleClose();
              handleAnchorClick(e, '#try');
            }}
            className="block rounded-[10px] px-4 py-3 text-[15px] font-medium text-[var(--ink)]"
          >
            {t('nav.demo')}
          </a>
          <LocaleLink
            href="/pricing"
            onClick={handleClose}
            className="block rounded-[10px] px-4 py-3 text-[15px] font-medium text-[var(--ink)]"
          >
            {t('nav.paypalDemo')}
          </LocaleLink>
          <LoginLink
            className="block rounded-[10px] px-4 py-3 text-[15px] font-medium text-[var(--ink)]"
            onNavigate={handleClose}
          />
          <div className="p-2 pt-1">
            <PrimaryCta className="flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--ink)] text-[15px] font-bold text-white">
              {t('cta.primary')}
            </PrimaryCta>
          </div>
        </div>
      )}
    </header>
  );
}

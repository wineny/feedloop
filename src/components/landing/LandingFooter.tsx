import { useTranslations } from 'next-intl';
import { LogoMark } from './Logo';

/** 푸터 */
export function LandingFooter() {
  const t = useTranslations('landing');
  return (
    <footer className="border-t border-[var(--line)]">
      <div className="mx-auto max-w-[1200px] px-6 py-7 text-[13px] leading-[1.6] text-[var(--l-muted)] lg:flex lg:h-[88px] lg:items-center lg:justify-between lg:py-0 lg:text-sm">
        <div className="flex items-center gap-2 font-bold text-[var(--ink)] lg:gap-2.5">
          <LogoMark size={20} className="text-[var(--coral)]" />
          Feedloop
        </div>
        <div className="mt-2 lg:mt-0 lg:text-right">
          <div>{t('footer.entry')}</div>
          {/* PostHog 고지 — 로그아웃 방문만, 입력칸·위젯은 가린다(src/lib/analytics/posthog.ts) */}
          <div className="text-xs">{t('footer.privacy')}</div>
        </div>
      </div>
    </footer>
  );
}

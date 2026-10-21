'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/**
 * EN / KO 전환 — next-intl 라우터로 같은 화면을 다른 언어로 다시 연다. 쿠키(NEXT_LOCALE)는 next-intl 이 심고,
 * proxy 가 접두어 없는 주소로 되돌린다. 쿼리(`?c=…`)는 그대로 들고 간다.
 * 접근 이름은 화면 글자(EN/KO) 그대로 — 음성 입력으로 「EN 누르기」가 통하게 aria-label 로 덮지 않는다.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const current = useLocale();
  const t = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const handleSwitch = (locale: string) => {
    if (locale === current) return;
    const query = Object.fromEntries(new URLSearchParams(window.location.search));
    startTransition(() => router.replace({ pathname, query }, { locale }));
  };

  return (
    <div
      role="group"
      aria-label={t('language')}
      aria-busy={pending || undefined}
      className={cn('inline-flex shrink-0 items-center text-xs font-semibold', className)}
    >
      {routing.locales.map((locale, i) => (
        <span key={locale} className="inline-flex items-center">
          {i > 0 && <span aria-hidden className="mx-0.5 opacity-40">/</span>}
          <button
            type="button"
            lang={locale}
            aria-pressed={locale === current}
            title={t(locale === 'en' ? 'english' : 'korean')}
            onClick={() => handleSwitch(locale)}
            className={cn(
              'inline-flex min-h-8 min-w-8 items-center justify-center rounded px-1 transition-colors',
              locale === current ? 'opacity-100' : 'opacity-50 hover:opacity-80',
            )}
          >
            {locale.toUpperCase()}
          </button>
        </span>
      ))}
    </div>
  );
}

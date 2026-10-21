'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';
import { LOCALES } from '@/i18n/config';
import { setLocale } from '@/i18n/actions';

/** EN / KO 전환 — 쿠키를 서버 액션으로 심고 현재 화면을 새로 그린다. */
export function LocaleSwitcher({ className }: { className?: string }) {
  const current = useLocale();
  const t = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div role="group" aria-label={t('language')} className={cn('inline-flex items-center text-xs font-semibold', className)}>
      {LOCALES.map((locale, i) => (
        <span key={locale} className="inline-flex items-center">
          {i > 0 && <span aria-hidden className="mx-0.5 opacity-40">/</span>}
          <button
            type="button"
            disabled={pending}
            aria-pressed={locale === current}
            aria-label={t(locale === 'en' ? 'english' : 'korean')}
            onClick={() =>
              startTransition(async () => {
                await setLocale(locale);
                router.refresh();
              })
            }
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

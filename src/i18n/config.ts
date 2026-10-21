export const LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

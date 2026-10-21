import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from './config';

/**
 * 언어 선택: 쿠키(NEXT_LOCALE) → Accept-Language → 기본(en).
 * Accept-Language 는 q 값 내림차순으로 훑어 지원 언어(`ko-KR` 은 `ko`)를 처음 만나는 것을 고른다.
 */
export function pickLocale(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookie)) return cookie;
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), weight: Number.isNaN(weight) ? 0 : weight, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  for (const { tag } of ranked) {
    const base = tag.split('-')[0];
    const match = LOCALES.find((l) => l === base);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

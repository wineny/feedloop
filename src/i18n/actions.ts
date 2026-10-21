'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, isLocale } from './config';

export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
  });
}

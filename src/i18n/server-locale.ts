// route handler·server action 에서 «이 요청을 보낸 사람의 언어»를 고른다.
// 거기서는 `next/root-params` 도 `cookies()` 도 쓰지 않는 편이 낫다(정적 렌더·Request 단독 테스트) —
// 요청 객체만 보고 정하고, 그 값을 `getTranslations({ locale })`·`createTranslator` 에 넘긴다.
//
// 고르는 순서:
//   widget   ① 쿼리 `?locale=en|ko`  ③ Accept-Language  ④ en      (남의 사이트에서 도는 위젯 — 쿠키가 우리 도메인 것이 아니다)
//   operator ② 쿠키 `NEXT_LOCALE`   ③ Accept-Language  ④ en      (운영자 화면이 부르는 API — 언어 전환 버튼이 쿠키를 건다)
// Accept-Language 는 첫 항목이 `ko` 로 시작하면 ko, 그 밖은 en.

import { routing, type Locale } from './routing';

export type RequestLocaleKind = 'widget' | 'operator';

// routing.ts 의 localeCookie.name 과 같은 이름(그쪽을 바꾸면 여기도).
const LOCALE_COOKIE = 'NEXT_LOCALE';

// `en`·`ko` 뿐 아니라 `en-US`·`ko_KR` 처럼 지역이 붙은 값도 앞 언어 코드로 받는다(브라우저·임베드 코드가 그렇게 보낸다).
function asLocale(value: string | null | undefined): Locale | null {
  const m = /^(en|ko)(?:[-_].*)?$/i.exec((value ?? '').trim());
  return m ? (m[1].toLowerCase() as Locale) : null;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      // 깨진 퍼센트 인코딩(`%E0%A4%A`)이 URIError 로 번지면 운영자 API 전체가 500 이 된다 — 쿠키가 없는 것으로 본다
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function queryLocale(req: Request): Locale | null {
  try {
    return asLocale(new URL(req.url).searchParams.get('locale'));
  } catch {
    return null;
  }
}

/**
 * 요청이 `?locale=` 로 «직접» 알린 언어. 없으면 undefined.
 * `conversations.locale` 처럼 저장하는 자리는 이 값이 있을 때만 쓴다 — Accept-Language 짐작으로는 저장값을 덮어쓰지 않는다.
 */
export function explicitWidgetLocale(req: Request): Locale | undefined {
  return queryLocale(req) ?? undefined;
}

/** Accept-Language 의 첫 언어가 ko 로 시작하면 ko, 아니면 en. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  const first = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('ko') ? 'ko' : 'en';
}

/** `req` 가 없으면(테스트가 인자 없이 부르는 핸들러) 기본 언어 en. */
export function localeFromRequest(req: Request | undefined, kind: RequestLocaleKind = 'operator'): Locale {
  if (!req) return routing.defaultLocale;
  const explicit =
    kind === 'widget' ? queryLocale(req) : asLocale(cookieValue(req.headers.get('cookie'), LOCALE_COOKIE));
  return explicit ?? localeFromAcceptLanguage(req.headers.get('accept-language'));
}

/** 요청 객체를 못 받는 lib(`resolveOwnedBots` 등)용 — 헤더만으로 운영자 화면 쪽 순서(쿠키 → Accept-Language → en). */
export function localeFromHeaders(headers: Headers): Locale {
  return asLocale(cookieValue(headers.get('cookie'), LOCALE_COOKIE)) ?? localeFromAcceptLanguage(headers.get('accept-language'));
}

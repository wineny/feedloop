// 운영자 화면이 부르는 API 의 `error` 문구 — 요청의 언어(쿠키 → Accept-Language → en)로 사전에서 읽는다.
// 위젯 라우트는 `lib/widget/http.ts` 의 `widgetError`(코드 + 문구)를 쓴다.

import { headers } from 'next/headers';
import { serverT } from '@/i18n/server-messages';
import { localeFromHeaders, localeFromRequest } from '@/i18n/server-locale';
import type { CodedError } from '@/lib/i18n/message';

type Values = Record<string, string | number>;

/** `messages/<locale>/errors.json` 의 `api.<key>`. */
export function apiText(req: Request | undefined, key: string, values?: Values): string {
  return serverT(localeFromRequest(req, 'operator'), 'errors.api')(key, values);
}

/**
 * 검증 함수(`validate*`)의 실패 결과를 문구로. 결과에 `code` 가 있으면 사전에서 읽는다 —
 * 화면과 같은 `common.validation.<code>` 를 먼저, 없으면 서버 전용 `errors.validation.<code>`.
 * `vars.field` 는 입력칸 이름(`errors.fields.<field>`)으로 바꿔 끼운다. 코드가 없거나 사전에 없으면 함수가 준 `error`(한국어).
 */
export function apiValidation(req: Request | undefined, result: CodedError): string {
  if (!result.code) return result.error;
  const locale = localeFromRequest(req, 'operator');
  let vars = result.vars;
  if (vars && typeof vars.field === 'string') {
    vars = { ...vars, field: serverT(locale, 'errors.fields')(vars.field) };
  }
  for (const ns of ['common.validation', 'errors.validation']) {
    const t = serverT(locale, ns);
    if (t.has(result.code)) return t(result.code, vars);
  }
  return result.error;
}

/**
 * 요청 객체가 없는 lib 에서 — 현재 요청의 헤더로 언어를 정한다. 요청 밖(테스트·크론)이면 en.
 * 가능하면 `apiText(req, ...)` 를 쓴다.
 */
export async function apiTextInContext(key: string, values?: Values): Promise<string> {
  let locale = localeFromRequest(undefined);
  try {
    locale = localeFromHeaders(await headers());
  } catch {
    // 요청 범위 밖
  }
  return serverT(locale, 'errors.api')(key, values);
}

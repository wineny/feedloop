// 검증 오류처럼 «서버도 같은 함수를 부르는» 곳의 메시지를 화면 언어로 바꾸는 얇은 길.
//
// lib 의 검증 함수는 서버(API 응답)용 한국어 `error` 를 그대로 두고, 화면용으로 `code`(+`vars`)를 더해 준다.
// 화면은 `validationText` 로 사전(`common.validation.<code>`)을 읽는다. zod 스키마처럼 문자열 메시지만 실을 수 있는
// 자리에는 `i18nMessage` 로 키를 문자열에 담고(`i18n:<키>?a=1`), 그리는 쪽(`FormMessage`·`resolveMessage`)이 푼다.

export type MessageVars = Record<string, string | number>;

export interface CodedError {
  error: string;
  /** 사전 키(`common.validation.` 아래). 없으면 `error` 를 그대로 쓴다 */
  code?: string;
  vars?: MessageVars;
}

const PREFIX = 'i18n:';

/** 문자열 하나에 사전 키와 인자를 싣는다. 인자는 문자열·숫자만. */
export function i18nMessage(key: string, vars?: MessageVars): string {
  if (!vars || Object.keys(vars).length === 0) return `${PREFIX}${key}`;
  const qs = new URLSearchParams(Object.entries(vars).map(([k, v]) => [k, String(v)])).toString();
  return `${PREFIX}${key}?${qs}`;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** `i18nMessage` 로 만든 문자열이면 사전에서 읽고, 아니면 그대로 돌려준다. */
export function resolveMessage(t: Translate, message: string): string {
  if (!message.startsWith(PREFIX)) return message;
  const body = message.slice(PREFIX.length);
  const q = body.indexOf('?');
  const key = q < 0 ? body : body.slice(0, q);
  const vars: Record<string, string | number> = {};
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(body.slice(q + 1))) vars[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return t(key, vars);
}

/** 검증 실패를 zod 메시지 등 «문자열 하나»로. 코드가 없으면 한국어 error 를 쓴다. */
export function validationMessage(r: CodedError): string {
  return r.code ? i18nMessage(`common.validation.${r.code}`, r.vars) : r.error;
}

/** 화면에 그릴 검증 오류 문구. `t` 는 `useTranslations()`(루트)의 것. */
export function validationText(t: Translate, r: CodedError): string {
  return resolveMessage(t, validationMessage(r));
}

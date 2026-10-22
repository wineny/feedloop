// route handler·lib 에서 사전(messages/<locale>/*.json)을 읽는 길. 화면은 next-intl 의 훅을 쓰고, 서버 응답·메일은 여기를 쓴다.
// `createTranslator` 는 locale 을 인자로 받으므로 `next/root-params` 가 안 되는 곳에서도 된다.
// 키를 조립하는 자리가 많아 타입 검사를 끈 번역 함수(`DynamicTranslate`)로 돌려준다 — 키가 사전에 있는지는 사전 테스트가 본다.

import { createTranslator } from 'next-intl';
import enErrors from '../../messages/en/errors.json';
import koErrors from '../../messages/ko/errors.json';
import enServer from '../../messages/en/server.json';
import koServer from '../../messages/ko/server.json';
import enEmail from '../../messages/en/email.json';
import koEmail from '../../messages/ko/email.json';
import enDashboard from '../../messages/en/dashboard.json';
import koDashboard from '../../messages/ko/dashboard.json';
import enCommon from '../../messages/en/common.json';
import koCommon from '../../messages/ko/common.json';
import type { DynamicTranslate } from './dynamic';
import type { Locale } from './routing';

const MESSAGES = {
  en: { errors: enErrors, server: enServer, email: enEmail, dashboard: enDashboard, common: enCommon },
  ko: { errors: koErrors, server: koServer, email: koEmail, dashboard: koDashboard, common: koCommon },
} as const;

export type ServerNamespace = keyof (typeof MESSAGES)['en'];

/** `serverT('ko', 'errors.api')('botNotFound')` 처럼 쓴다. namespace 는 점 경로 가능. */
export function serverT(locale: Locale, namespace: string): DynamicTranslate {
  return createTranslator({
    locale,
    messages: MESSAGES[locale] as never,
    namespace: namespace as never,
  }) as unknown as DynamicTranslate;
}

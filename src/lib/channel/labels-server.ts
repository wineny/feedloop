// 서버 응답(`/api/dashboard`, `/api/auto-dev/runs`)에 실리는 입구·사람 호칭 — 요청 언어로.
// 화면 컴포넌트는 `useChannelLabels`(번역 훅)를 쓰고, 프롬프트·카카오 대화 기록은 `labels.ts` 의 한국어 표를 그대로 쓴다.
// 클라이언트 번들에 사전이 딸려 가지 않도록 `labels.ts` 와 파일을 나눴다.

import { serverT } from '@/i18n/server-messages';
import type { Locale } from '@/i18n/routing';

/** 그 입구의 사람 호칭(`common.channels.person`). 모르는 입구는 「Visitor / 방문자」. */
export function personLabelFor(source: string, locale: Locale): string {
  const t = serverT(locale, 'common.channels.person');
  return t.has(source) ? t(source) : t('default');
}

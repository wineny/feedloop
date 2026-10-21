'use client';

import { useTranslations } from 'next-intl';

/**
 * `lib/channel/labels.ts` 의 화면용 짝 — 같은 입구 코드(`web`·`kakao`·`channel`)를 현재 언어의 사전에서 읽는다.
 * labels.ts 는 서버 코드(API·메일·프롬프트)가 쓰는 한국어 값이라 그대로 두고, 화면은 이 훅으로 간다.
 * 모르는 입구는 원문 그대로 돌려준다(새 입구를 더하고 사전을 빠뜨린 걸 화면에서 알아채도록).
 */
export function useChannelLabels() {
  const t = useTranslations('common.channels');
  return {
    sourceLabel: (source: string) => (t.has(`source.${source}`) ? t(`source.${source}`) : source),
    personLabel: (source: string) => (t.has(`person.${source}`) ? t(`person.${source}`) : t('person.default')),
  };
}

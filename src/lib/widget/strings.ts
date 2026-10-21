// 위젯이 서버에서 받는 방문자용 기본 문구 — 언어는 en|ko 둘뿐, 모르면 en.
//
// 위젯(public/widget.js)이 모든 요청에 `?locale=en|ko` 를 실어 보낸다. 서버는 그 값을 먼저 보고
// (`widgetLocale`), 없으면 Accept-Language, 그 밖의 값은 en 으로 본다.
// 기본 인사말·운영자 이름·상태 문구·대기 문구는 화면 미리보기가 쓰는 사전(messages/<locale>/*.json)을
// 그대로 읽는다 — 미리보기와 실제 위젯이 같은 문장이 되도록. 사전에 없는 안내(느림·상한·상담원 연결)는
// 아래 표에 둔다.

import { createTranslator } from 'next-intl';
import { localeFromRequest } from '@/i18n/server-locale';
import enBots from '../../../messages/en/bots.json';
import koBots from '../../../messages/ko/bots.json';
import enCommon from '../../../messages/en/common.json';
import koCommon from '../../../messages/ko/common.json';
import { HOLDING_MESSAGE_EN, HOLDING_MESSAGE } from '@/lib/bot/holding';
import type { ReplyNotices } from '@/lib/paypal/notices';

export type WidgetLocale = 'en' | 'ko';

/** `?locale=` → Accept-Language(ko 로 시작하면 ko) → en. 옛 widget.js(`?locale` 없음)도 브라우저 언어를 따른다. */
export function widgetLocale(req: Request): WidgetLocale {
  return localeFromRequest(req, 'widget');
}

const MESSAGES = {
  en: { bots: enBots, common: enCommon },
  ko: { bots: koBots, common: koCommon },
} as const;

export function defaultStatusText(locale: WidgetLocale): string {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bots.defaults' })('statusText');
}

export function defaultGreeting(locale: WidgetLocale, displayName: string): string {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bots.defaults' })('greeting', {
    name: displayName,
  });
}

export function defaultOperatorName(locale: WidgetLocale, displayName: string): string {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'bots.defaults' })('operatorName', {
    name: displayName,
  });
}

/** 칩 라벨(「불편한 점이 있어요」 / 「I have a problem」). 사전 `bots.appearance.chips.<hint>` 와 같은 문장. */
export function chipLabel(locale: WidgetLocale, hint: 'bug' | 'feature'): string {
  return MESSAGES[locale].bots.appearance.chips[hint];
}

/** 기본(일반 CS) 응답 경로의 안내 다섯 가지. 결제 경로는 lib/paypal/notices.ts 의 영어 고정 문장을 쓴다. */
export function defaultReplyNotices(locale: WidgetLocale): ReplyNotices {
  if (locale === 'ko') {
    return {
      slow: '말씀 잘 받았어요! 확인하고 바로 답 드릴게요 🙌',
      rate: '말씀 잘 받았어요! 지금 문의가 몰려 자동 답변은 잠시 쉬고 있어요. 팀이 직접 읽고 답 드릴게요 🙌',
      limit: '말씀 잘 받았어요! 오늘은 자동 답변이 어려워 팀이 직접 읽고 답 드릴게요 🙌',
      holding: `말씀 잘 받았어요! ${HOLDING_MESSAGE}`,
      holdingMessage: HOLDING_MESSAGE,
    };
  }
  return {
    slow: "Got it! We're checking and will reply shortly 🙌",
    rate: 'Got it! Automatic replies are paused for a moment because of high traffic. Our team will read this and reply 🙌',
    limit: 'Got it! Automatic replies are not available today, so our team will read this and reply 🙌',
    holding: `Got it! ${HOLDING_MESSAGE_EN}`,
    holdingMessage: HOLDING_MESSAGE_EN,
  };
}

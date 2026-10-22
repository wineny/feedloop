// 사업자(봇 소유자)가 읽는 AI 생성물의 언어 — 한 곳.
//
// 대상: 인사이트 요약(insights.summary), 묶음 제목·요약·영향 이유(insight_groups.title/summary/impact_reason),
// 스펙 초안, PR 제목·설명·explanation, 메일 AI 요약, 코드 검토 의견. 방문자가 한국어로 써도 이 언어로 쓴다.
// 방문자에게 가는 답(위젯·카카오·채널톡·텔레그램 봇 답변, 대기 문구)은 이 값이 아니라 방문자 언어를 따른다.
//
// 사업자 메일의 언어(`OWNER_EMAIL_LOCALE`, lib/email/notify.ts)와 «같은 값»이어야 한다 — 메일 본문은 영어인데
// 그 안의 AI 요약만 다른 언어면 한 통이 두 언어가 된다. 사업자 언어를 저장하게 되면 둘을 같이 바꾼다.
// 이 파일은 의존성이 타입뿐이다(classify·groups·auto-dev 가 가볍게 가져다 쓴다).

import type { Locale } from './routing';

export const OWNER_CONTENT_LOCALE: Locale = 'en';

/** 프롬프트의 「Write X in {language}」 자리에 들어가는 언어 이름. */
export const LANGUAGE_NAME: Record<Locale, string> = { en: 'English', ko: 'Korean' };

export const OWNER_CONTENT_LANGUAGE = LANGUAGE_NAME[OWNER_CONTENT_LOCALE];

// 피드백 분류 기준의 단일 출처.
//
// 왜 한 곳인가 — 예전엔 분류 기준이 **두 벌**이었다. 실시간 경로(`lib/bot/prompts.ts`
// SYSTEM_PROMPT)는 카테고리 이름만 나열하고 정의를 안 줬고, 배치 경로
// (`api/classify/route.ts`)는 자기만의 한 줄 정의를 따로 갖고 있었다. 같은 문장이
// 어느 문으로 들어오느냐에 따라 다르게 분류될 수 있었다는 뜻이다.
//
// 분류가 왜 중요한가 — 이 값이 곧 **그 다음에 무슨 일이 벌어지는지**를 정한다
// (`lib/groups/policy.ts`). bug·ux 는 자동 코드 PR 로, feature_request 는 스펙 초안으로,
// 나머지는 아무 데도 안 간다. 그래서 오분류는 화면의 라벨이 틀리는 문제가 아니라
// **엔진이 엉뚱한 일을 하는** 문제다. 실측된 사고 둘이 정확히 이 계열이었다:
//   - PR #5: 빈 상태 안내 부족(ux)을 bug 로 읽어 "고장 원인"을 찾다가 없는 번역 키를 지어냄
//   - PR #6: 재현되지 않는 증상에 도달 불가능한 방어 코드를 추가(wrong_causality)
// 엔진 프롬프트가 "버그"를 들으면 원인을 찾으려 하고, 원인이 없으면 지어낸다.

import { OWNER_CONTENT_LANGUAGE } from '@/i18n/owner-locale';

export const CATEGORIES = ['bug', 'ux', 'feature_request', 'praise', 'cs', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

const CATEGORY_SET = new Set<string>(CATEGORIES);
const SENTIMENT_SET = new Set<string>(SENTIMENTS);

/**
 * 모델이 뱉은 값을 저장 가능한 값으로 좁힌다.
 *
 * ⚠️ `insights` 테이블엔 CHECK 제약이 없다. 모델이 `"버그"` 나 `"Bug"` 를 쓰면 그대로
 * 저장되고, 그러면 `isCodeFixable('버그') === false` 라 그 제보는 **조용히 묶음에서
 * 빠진다**. 화면에도 DB 에도 에러가 안 남아서 아무도 모른다. 여기서 막는다.
 *
 * 모르는 값은 버리지 않고 `other` 로 떨어뜨린다 — 인사이트를 통째로 잃는 것보다
 * 「분류 실패」로 남아 사람 눈에 띄는 편이 낫다.
 */
export function normalizeCategory(value: unknown): Category {
  if (typeof value !== 'string') return 'other';
  const v = value.trim().toLowerCase();
  return CATEGORY_SET.has(v) ? (v as Category) : 'other';
}

/** 감정도 같은 이유로 좁힌다. 모르면 중립 — 없는 분노를 지어내지 않는다. */
export function normalizeSentiment(value: unknown): Sentiment {
  if (typeof value !== 'string') return 'neutral';
  const v = value.trim().toLowerCase();
  return SENTIMENT_SET.has(v) ? (v as Sentiment) : 'neutral';
}

/**
 * 모든 분류 프롬프트가 그대로 얹는 기준 블록.
 *
 * 경계 4개는 실데이터를 사람이 라벨링하면서 확정했다(2026-09-11). 정의만 주면
 * 모델은 경계에서 흔들리므로 **판별 질문과 예시를 같이** 준다 — 정의는 읽고 나면
 * 잊히지만 "이 문장은 이쪽"은 남는다.
 *
 * ⚠️ 이 블록은 **무인증 위젯의 시스템 프롬프트로 나간다.** 방문자는 시스템 프롬프트를
 * 캐낼 수 있다고 봐야 한다 — 「내부 동작 질문은 답하지 마라」는 소프트 지시일 뿐이고,
 * 이 레포는 저가 모델이 프롬프트 규칙을 안 지키는 것을 이미 실측했다(2026-09-10).
 * 그러니 여기에는 **판별 기준만** 둔다. 「어떤 라벨이 자동 코드 수정을 깨우는지」,
 * 「근거가 없을 때 엔진이 환각한다」 같은 파이프라인 내부는 아래
 * `TAXONOMY_INTERNAL_NOTES` 로 — 그건 인증된 경로에서만 덧붙인다.
 */
export const TAXONOMY_BLOCK = `## Classification

Before the questions below: a breakdown of existing behavior that the user states is bug; an inconvenience with something that works is ux.
Even if the user also proposes a fix or a new button, the stated problem comes first. Do not infer an existing inconvenience or breakdown from a request for a new capability alone.
A follow-up that only asks about the progress of an earlier report is other, regardless of this priority.
Otherwise, ask these questions in order.

1. **Is it a question that ends once it is answered?** → cs
   - Asks how to use something, for information, or whether something is possible. "Is there ...?" "Can I ...?" "Does it ...?"
   - **Asking whether something is possible is also cs**, as in "Can I register more than one store?"
     Whether or not you know the answer, the question's category is cs. Do not turn a question into a feature request just because the feature does not exist.
2. **Does the user want a capability this app does not have now?** → feature_request
   - Integration with an external service, a new feature. "It would be nice if it saved to Google Calendar"
3. **Does something that should work not work as intended?** → bug
   - Errors, freezes, blank screens, **showing wrong or stale results**, **noticeably slow**,
     an expected notification not arriving
   - "I changed the region but the old region's list stays for 1–2 seconds" → a wrong result is shown, so bug
   - "Photo upload is too slow" → slow performance is bug
4. **Does it work but feel inconvenient or confusing?** → ux
   - Missing guidance, dead ends, hard to find, hard to take in at a glance
   - ⚠️ **If the user proposes a fix but the underlying issue is an inconvenience, it is ux.**
     "A message and a link in the empty coupon box would help" → the core of the report is the
     inconvenience "the empty screen is a dead end". The button or link is only the user's idea of a remedy.
     Classify a report **by the problem, not by the solution**. That way reports of the same symptom end up in one group.
5. **Is it praise or thanks?** → praise
6. **None of the above?** → other
   - ⚠️ **A follow-up asking about the progress of an earlier report is other.**
     "What happened to that problem?" is not a new report. Counting an issue that was already
     reported as a new bug records the same problem twice.
   - Small talk unrelated to the service, greetings, unintelligible input

## One line that separates bug and ux
**If something is broken, bug. If nothing is broken but it is bad to use, ux.**
Calling it bug when nothing is broken makes the next analysis look for a cause that does not exist.

## sentiment
- negative: dissatisfaction, disappointment or difficulty shows
- positive: satisfaction, thanks
- neutral: a calm report or question. **A politely written bug report can be neutral.**
  Judge category and sentiment separately — a question is not automatically negative,
  and a bug is not always negative.`;

/**
 * 한 줄 요약(summary)의 언어 규칙 — 즉답·배치 분류 두 프롬프트가 같이 싣는다.
 *
 * summary 는 사업자가 읽는 생성물이라 방문자 언어가 아니라 OWNER_CONTENT_LANGUAGE 로 쓴다.
 * 예시 하나는 «한국어 입력 → 영어 출력»으로 일부러 남긴다. 지시문·예시가 전부 영어면 한국어 제보를
 * 분류·요약하는 힘이 약해질 수 있다(이 레포 제보의 대부분이 한국어다).
 */
export const SUMMARY_LANGUAGE_RULE = `- Write summary in ${OWNER_CONTENT_LANGUAGE}, whatever language the user wrote in. Translate the meaning; do not copy the user's sentence.
- Example: the user wrote "쿠폰함 지난내역 탭 누르면 하얀 화면만 떠요" → category "bug", summary "White screen when opening the past-history tab in the coupon box"`;

/**
 * 분류가 여는 문 — **인증된 경로에서만** 프롬프트에 덧붙인다.
 *
 * 왜 가뒀나: 이 문장들은 방문자에게 ① 자동 코드 수정 엔진이 있다 ② 어떤 라벨이 그걸
 * 깨우는지 ③ 근거가 없으면 환각한다 — 를 알려준다. 셋을 합치면 조준 설명서가 된다.
 * 모델에게는 유용한 동기라서 지우지 않고, 나가는 문만 좁혔다.
 */
export const TAXONOMY_INTERNAL_NOTES = `## What this classification triggers
bug and ux go to an automatic code-fix PR; feature_request goes to a spec draft.
Calling something bug when nothing is broken makes the fix engine invent a cause — a PR that broke
the build has actually come out this way. Reading a follow-up question as bug opens a duplicate group
and a duplicate PR for a problem that is already being fixed.`;

/**
 * 묶기(grouping)·자동 PR 후보로 올릴 카테고리인가.
 *
 * cs·praise·other 는 제외한다. 인사이트로는 남는다 — 어떤 질문이 반복되는지는
 * 운영자가 봐야 할 신호다. 다만 **묶음까지 가면 안 된다**: `pr_mode='auto'` 크론이
 * "가장 큰 open 묶음"을 고르므로, 문의 묶음뿐인 봇에서는 그 묶음에 PR 이 열린다.
 * 리허설에서 후속 문의 묶음에 실제로 PR #4 가 열렸다(useCallback·주석뿐인 변경).
 *
 * `policy.ts` 의 `groupAction` 과 역할이 다르다 — 저쪽은 **이미 만들어진 묶음**에
 * 어떤 버튼을 띄울지, 이쪽은 **묶음을 만들지 말지**를 정한다.
 */
export const GROUPABLE_CATEGORIES = ['bug', 'ux', 'feature_request'] as const;

const GROUPABLE_SET = new Set<string>(GROUPABLE_CATEGORIES);

export function isGroupable(category: string): boolean {
  return GROUPABLE_SET.has(normalizeCategory(category));
}

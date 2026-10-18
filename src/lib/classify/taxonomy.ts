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
export const TAXONOMY_BLOCK = `## 분류 기준

아래 질문보다 먼저, 사용자가 명시한 기존 동작의 고장은 bug, 작동하지만 겪는 불편은 ux 로 판단하세요.
해결책·새 버튼을 함께 제안해도 명시된 문제를 우선합니다. 새 능력 요청만으로 기존 불편이나 고장을 추측하지 마세요.
이전에 접수한 건의 진행 상황만 묻는 후속 문의는 이 우선순위와 무관하게 other 입니다.
그 외에는 이 질문을 순서대로 던지세요.

1. **답만 주면 끝나는 질문인가?** → cs
   - 사용법·정보·가능 여부를 묻는 문장. "~있나요?" "~되나요?" "~인가요?"
   - "가게를 여러 개 등록할 수 있나요?" 처럼 **가능 여부를 묻는 것도 cs 다.**
     답을 알든 모르든 질문의 category 는 cs 다. 기능이 없다는 사실만으로 질문을 기능 요청으로 바꾸지 않는다.
2. **지금 이 앱에 없는 능력을 원하는가?** → feature_request
   - 외부 서비스 연동, 새로운 기능. "구글 캘린더에 저장되면 좋겠어요"
3. **작동해야 할 것이 의도대로 안 되는가?** → bug
   - 에러·먹통·빈 화면, **잘못되거나 낡은 결과를 보여줌**, **눈에 띄게 느림**,
     와야 할 알림이 안 옴
   - "지역을 바꿨는데 이전 지역 목록이 1~2초 남아요" → 틀린 결과 표시라 bug
   - "사진 업로드가 너무 느려요" → 성능 저하는 bug
4. **작동은 하는데 불편하거나 헷갈리는가?** → ux
   - 안내 부족, 막다른 길, 찾기 어려움, 한눈에 안 들어옴
   - ⚠️ **유저가 해결책을 제안해도 밑에 깔린 것이 불편이면 ux 다.**
     "빈 쿠폰함에 안내 문구랑 링크만 있어도 편하겠어요" → 제보의 본질은
     "빈 화면이 막다른 길"이라는 불편. 버튼·링크는 유저가 생각한 처방일 뿐이다.
     제보는 **해결책이 아니라 문제로** 분류한다. 그래야 같은 증상의 제보가 한 묶음이 된다.
5. **칭찬·감사인가?** → praise
6. **위 어디에도 아닌가?** → other
   - ⚠️ **이전에 제보한 건의 진행 상황을 묻는 후속 문의는 other 다.**
     "그때 그 문제 어떻게 됐나요?" 는 새로운 제보가 아니다. 이미 접수된 건을
     bug 로 다시 세면 같은 문제가 두 건으로 잡힌다.
   - 서비스와 무관한 잡담, 인사, 의미를 알 수 없는 입력

## bug 와 ux 를 가르는 한 줄
**무언가 고장났으면 bug, 고장난 건 없는데 쓰기 나쁘면 ux.**
고장이 없는데 bug 라고 하면, 뒤따르는 분석이 있지도 않은 원인을 찾게 된다.

## sentiment
- negative: 불만·실망·곤란함이 드러남
- positive: 만족·감사
- neutral: 담담한 제보나 질문. **정중하게 쓴 버그 제보는 neutral 일 수 있다.**
  분류(category)와 감정(sentiment)은 따로 판단한다 — 질문이라고 negative 가 아니고,
  버그라고 반드시 negative 인 것도 아니다.`;

/**
 * 분류가 여는 문 — **인증된 경로에서만** 프롬프트에 덧붙인다.
 *
 * 왜 가뒀나: 이 문장들은 방문자에게 ① 자동 코드 수정 엔진이 있다 ② 어떤 라벨이 그걸
 * 깨우는지 ③ 근거가 없으면 환각한다 — 를 알려준다. 셋을 합치면 조준 설명서가 된다.
 * 모델에게는 유용한 동기라서 지우지 않고, 나가는 문만 좁혔다.
 */
export const TAXONOMY_INTERNAL_NOTES = `## 이 분류가 여는 문
bug·ux 는 자동 코드 수정 PR 로, feature_request 는 스펙 초안으로 간다.
고장이 없는데 bug 로 부르면 수정 엔진이 없는 원인을 지어낸다 — 실제로 그렇게
빌드가 깨진 PR 이 나온 적이 있다. 후속 문의를 bug 로 읽으면 이미 고치는 중인
문제에 중복 묶음과 중복 PR 이 열린다.`;

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

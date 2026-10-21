# i18n 용어집 (한국어 → 영어)

화면 문구를 영어로 옮길 때 이 표의 영어 단어를 그대로 쓴다. 같은 대상을 화면마다 다르게 부르지 않기 위해서다.
이미 영어로 쓰인 코드(`src/lib/paypal/*`, `/pricing`, `public/widget.js` 주석)에서 쓰는 단어를 우선했다.

| 한국어 | 영어 | 메모 |
|---|---|---|
| 봇 | bot | 사업자가 만든 Feedloop 응대 봇 한 개. 화면에서는 「service」라고 쓰지 않고 bot 으로 통일(`service_name` 입력칸도 「Bot name」). 사업자의 제품·사이트는 product / site |
| 챗봇(방문자 쪽) · 위젯 | chat widget / widget | 사업자 사이트에 붙는 채팅창. 랜딩에서는 「Feedloop chat widget」 |
| 받은편지함 · 대화 | Inbox · conversation | 탭 이름 「대화」 = Inbox, 한 건 = conversation |
| 승인 카드 | approval card | 결제 처리(환불 등)를 승인자에게 묻는 카드 |
| 승인자 | approver | 승인 카드에 답하는 사람 |
| 사업자 · 주인 · 운영자 · 담당자 | owner | 봇을 가진 사람. 「담당자에게 넘긴다」 = hand off to the owner |
| 결제한 사람 | buyer | 결제 검사·승인 카드 문구에서 customer 대신 buyer |
| 입구 · 접수 경로 (웹 위젯·채널톡) | feedback channel | entrance / door 는 쓰지 않는다 |
| 연결됨 표시 | Connected status | 「mark」는 쓰지 않는다. 지우기 = Reset status |
| GitHub 앱 | GitHub App | 「GitHub app」·「Feedloop app」 대신 「GitHub App」·「Feedloop GitHub App」 |
| 방문자 | visitor | 위젯으로 말을 거는 사람. 결제한 사람은 buyer |
| 고객 | customer | 마케팅 문구(랜딩)에서만 |
| 피드백 | feedback | 탭 이름 「피드백」(분류 화면) = Feedback |
| AI 분류 | AI triage | 버그·불편·요청·문의로 나누는 일. 분류 결과 화면의 낱말은 classification |
| 그룹 · 묶음 | group | 비슷한 피드백 묶음(insight group) |
| 수정안 · 수정 PR · 자동 수정 | fix PR · auto-fix | 탭 「수정안」 = Fix PRs. 「자동 수정」 = auto-fix |
| 반영(됐어요) | fixed / shipped | 방문자에게 가는 알림은 「Fixed」, 사업자 화면은 「shipped」 |
| 반영 알림 | notification | 보낸 사람에게 가는 알림 |
| 환불 | refund | |
| 결제 | payment | PayPal 주문 한 건 = order |
| 장부 | ledger | 결제 기록(payment ledger) |
| 저장소 | repository | GitHub 저장소 |
| 지식 | knowledge | 봇이 답변에 쓰는 지식 |
| 연결 | connect / connection | 채널·GitHub·API 키 연결 |
| 대시보드 | dashboard | |
| 위젯 모양 | widget appearance | |
| 상담원 연결 | Talk to a person | 위젯 도구 버튼 |
| 화면에서 선택하기 | Pick on screen | 위젯 도구 버튼 |
| 예시 데이터 | sample data | |
| 로그인 / 로그아웃 | Log in / Log out | 「Sign in with Google」은 Google 버튼 문구에만 |

## 영어 문구 원칙

- SaaS 제품 문구처럼 짧고 분명하게. 직역하지 않는다.
- 버튼은 동사로 시작(Save, Connect, Try again). 문장 끝 마침표는 본문에만.
- 존댓말의 부드러움은 영어에서 「please」로 옮기지 않고 평서문으로 둔다. 사과·부탁이 꼭 필요한 곳만 Please.
- 숫자·날짜·통화는 `useFormatter` / ICU(`{count, plural, ...}`)로, 하드코딩하지 않는다.

## 2단계 범위

페이지: `src/app/[locale]/` 의 `page.tsx`(랜딩), `pricing`(+`receipt/[orderId]`), `login`, `inbox`, `bots`(`new`, `[id]/appearance`, `[id]/knowledge`, `[id]/connect`, `TryDemoBotButton`), `dashboard`, `error.tsx`, 그리고 `src/app/global-error.tsx`.

컴포넌트: `src/components/landing/*`, `layout/Navigation·BotScopeSelect·PageState`, `auth/*`, `pricing/*`, `demo/DemoBanner`, `inbox/PaymentActionCard`, `dashboard/*`, `bots/*`, `onboarding/*`, `groups/GroupingStatusLine`, `picked/PickedShot`.

이번에 건드리지 않는 것(다른 단계): `/monitor`·`/classify` 화면(6), `src/components/demo/guided/*`·`src/lib/demo/mock-data.ts`(6·7, 랜딩의 데모 구역은 이 때문에 한국어가 남는다), API 오류 문구(4), 위젯 `public/*.js`(3), AI 프롬프트(5).

사전 파일: `messages/<locale>/<namespace>.json` — `common`, `meta`, `notFound`, `landing`, `nav`, `auth`, `pricing` 등. 새 파일은 `src/i18n/namespaces.ts` 의 `MESSAGE_NAMESPACES` 에 넣는다.

## 4단계 범위 — 서버가 사람에게 보여 주는 문구

- 언어 고르기: `src/i18n/server-locale.ts` 의 `localeFromRequest(req, 'widget' | 'operator')`. 위젯 라우트는 쿼리 `?locale` → `Accept-Language`(첫 항목이 ko 로 시작하면 ko) → en. 운영자 화면이 부르는 API 는 쿠키 `NEXT_LOCALE` → `Accept-Language` → en.
- 사전: `messages/<locale>/errors.json`(`api` 운영자 API 오류, `widget` 위젯 오류, `validation`·`fields` 검증, `llmFailure`·`githubFailure`·`installLost` 사유), `server.json`(대시보드 활동 피드 등), `email.json`(메일 6종). 코드에서는 `apiText(req, key)`(`src/lib/http/api-text.ts`)·`serverT(locale, 'ns.path')`(`src/i18n/server-messages.ts`).
- 위젯 오류 응답은 `{ error: <코드>, message: <방문자 언어 문구> }`. 위젯은 코드가 자기 표(`e_<코드>`)에 있으면 그 문구, 없으면 `message`.
- 메일: 방문자에게 가는 메일은 `conversations.locale`, 사업자에게 가는 메일은 `OWNER_EMAIL_LOCALE`(`src/lib/email/notify.ts`, 지금 en).
- GitHub PR 본문·제목·댓글은 영어 고정. 옛 한국어 PR 은 `draft-markers.ts`·`explanation.ts`·`picked-targets.ts` 가 계속 읽는다.
- 5단계로 넘긴 것: LLM 프롬프트(`prompts.ts`, `ai-engine.ts` 의 지시문, `classify`, `groups`, `reply-context`, `bot/core.ts` 기본값), `HOLDING_MESSAGE` 비교, 요약 지시(`notify.ts` 의 「한국어 두 문장」), 위젯 맥락 요약(`widget/context.ts` 프롬프트용 줄).

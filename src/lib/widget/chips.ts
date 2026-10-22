// 위젯 첫 화면의 칩과 분류 힌트.
//
// 이 파일은 무거운 의존성이 0 이다. 서버(위젯 config·메시지 라우트)와 클라이언트(운영자
// 미리보기)가 같은 목록을 봐야 하기 때문이다 — 예전에는 운영자 화면이 라벨 사본을
// 따로 들고 있어서, 칩 문구를 고치면 미리보기가 옛 문구를 보여줬다.
// 유일한 import 인 `@/lib/text` 도 순수 문자열 함수 하나뿐이라 클라이언트 번들에 안전하다.
//
// 첫 화면에는 성격이 다른 두 줄이 있다:
//
//   자주 묻는 질문  — 운영자가 정한 실제 질문 문장. 누르면 «바로 전송»된다.
//                    분류 힌트는 question 하나로 고정이고 칩 목록에는 없다.
//   의견 남기기     — 아래 WIDGET_CHIPS. 누르면 입력창이 채워지고 방문자가 이어 쓴다.
//
// 힌트는 Gemini 프롬프트에 "우선 고려할 분류" 로만 들어간다 — 강제하지 않는다.
// 방문자가 칩 문장을 지우고 딴 얘기를 쓸 수 있기 때문이다.

import { collapseWhitespace } from '@/lib/text';

interface WidgetHintSpec {
  hint: string;
  /** 프롬프트에 「시작 지점」으로 들어가는 이름. 칩이면 칩에 쓰인 문구 그대로다. */
  label: string;
  /** 영어 위젯에 뜨는 칩 문구(messages/en/bots.json `chips.<hint>` 와 같다 — 테스트 대조). 칩이 아니면 없다. */
  labelEn?: string;
  /** insights.category 후보 */
  category: string;
  /** 첫 화면 「의견 남기기」 줄에 칩으로 뜨는가 */
  chip: boolean;
}

export const WIDGET_HINTS = [
  { hint: 'bug', label: '불편한 점이 있어요', labelEn: 'I have a problem', category: 'bug', chip: true },
  { hint: 'feature', label: '기능 제안이 있어요', labelEn: 'I have a suggestion', category: 'feature_request', chip: true },
  // 시작 질문 칩이 쓰는 힌트. 칩 목록에는 없지만 서버가 받아들이는 유효한 값이다.
  // 예전의 「문의할 게 있어요」 칩을 대신한다 — 이제는 방문자가 막연한 문의 대신
  // 실제 질문 문장을 눌러 시작한다.
  { hint: 'question', label: '자주 묻는 질문', category: 'cs', chip: false },
] as const satisfies readonly WidgetHintSpec[];

export type WidgetHint = (typeof WIDGET_HINTS)[number]['hint'];

type WidgetChip = Extract<(typeof WIDGET_HINTS)[number], { chip: true }>;

/**
 * 첫 화면 「의견 남기기」 줄에 뜨는 칩. 누르면 입력창이 채워진다.
 *
 * 타입을 명시하는 이유 둘: `filter` 결과는 `T[]` 라 그냥 두면 이 공유 배열에
 * 아무나 push 할 수 있고, 좁힘이 TS 의 술어 추론에 암묵적으로 기대게 된다 —
 * 추론이 빠지면 `question` 이 소리 없이 타입에 다시 들어오는데 런타임은
 * 멀쩡해서 못 알아챈다.
 */
export const WIDGET_CHIPS: readonly WidgetChip[] = WIDGET_HINTS.filter(
  (h): h is WidgetChip => h.chip,
);

/** 시작 질문 칩이 함께 보내는 힌트. */
export const STARTER_QUESTION_HINT: WidgetHint = 'question';

export function isWidgetHint(value: unknown): value is WidgetHint {
  return typeof value === 'string' && WIDGET_HINTS.some((h) => h.hint === value);
}

/**
 * 힌트를 LLM 유저 메시지 뒤에 붙일 한 줄로 바꾼다. 힌트가 없으면 빈 문자열.
 * 지시문이라 영어로 쓰고 칩 이름도 영어판(labelEn)을 싣는다 — 방문자가 한국어 칩을 눌렀어도 뜻은 같다.
 */
export function hintLine(hint: WidgetHint | null | undefined): string {
  if (!hint) return '';
  const spec = WIDGET_HINTS.find((h) => h.hint === hint);
  if (!spec) return '';
  return `\n\n(Note: the visitor started from "${'labelEn' in spec ? spec.labelEn : 'a starter question'}". Prefer insight.category "${spec.category}", but follow the content if it says otherwise.)`;
}

// ── 칩 문장만 누른 첫 턴 ─────────────────────────────
//
// 「의견 남기기」 칩은 입력창을 «채우기만» 한다 — 방문자가 이어 쓰라는 뜻이다.
// 그런데 실제로는 그대로 [보내기] 를 누르는 사람이 있다(셀프 QA I-05). 그러면
// 「불편한 점이 있어요」 라는 내용 없는 문장이 제보로 저장되고, 분류는 그걸 bug 로
// 읽어 **증상도 위치도 없는 인사이트 한 건**을 만든다. 그 조각이 묶음이 되고
// 자동 PR 후보가 된다 — 고칠 것이 적혀 있지 않은데.
//
// 그래서 칩 라벨 그대로인 턴은 «제보가 아니라 시작 신호»로 본다. 답(되묻기)은 하되
// 인사이트는 만들지 않는다. 방문자가 다음 턴에 실제 내용을 쓰면 그때가 첫 제보다.

/**
 * 「의견 남기기」 칩 라벨 목록. 배치 분류가 **스캔에서 제외**할 때 쓴다.
 *
 * 제외이지 미분류가 아니다 — 라우트가 이미 인사이트를 안 만들기로 판정한 메시지를
 * [분류] 버튼이 다시 주워 새 인사이트로 만들면 같은 문제가 뒷문으로 재발하고,
 * pending 에 세면 「분류할 게 남았다」가 영원히 0 이 되지 않는다.
 */
export const CHIP_ONLY_LABELS: readonly string[] = WIDGET_CHIPS.flatMap((c) => [c.label, c.labelEn]);

/**
 * 이 문장이 칩 라벨 «그대로» 인가.
 *
 * 공백 변형(앞뒤 공백·중간 여러 칸)은 같은 것으로 본다 — 위젯이 라벨을 입력창에
 * 넣어 주고 방문자가 커서만 움직이다 보내는 경로라 눈에 안 보이는 차이가 생긴다.
 * 라벨 뒤에 한 글자라도 «내용»이 붙으면 더 이상 칩만이 아니다.
 *
 * 시작 질문 칩은 여기 해당하지 않는다. 그건 운영자가 쓴 진짜 질문 문장이고,
 * 누르는 즉시 전송되며 그 자체로 답할 내용이 있다.
 */
export function isChipOnlyText(text: string): boolean {
  const collapsed = collapseWhitespace(text);
  return CHIP_ONLY_LABELS.includes(collapsed);
}

/**
 * 칩만 누른 턴에서 `hintLine` 대신 붙이는 한 줄.
 *
 * 서버가 어차피 `insight` 를 버리지만(라우트 §G-4) 모델에게도 말해 준다 — 그래야
 * 답이 「접수했어요」 가 아니라 «되묻기» 가 된다. 버리는 것은 지어낸 제보가 저장되는
 * 것을 막는 장치이지, 답변의 결을 정하는 장치가 아니다.
 */
export function chipOnlyLine(hint: WidgetHint | null | undefined): string {
  const spec = hint ? WIDGET_HINTS.find((h) => h.hint === hint) : undefined;
  const label = spec?.chip ? `"${spec.labelEn}" ` : '';
  return (
    `\n\n(Note: the visitor only tapped the ${label}chip and has not said anything yet. ` +
    `Set insight to null and ask one question about what happened.)`
  );
}

// 「모르는 사실」에 대한 대기 문구 — 단일 출처.
//
// 이 모듈은 의존성이 0 이다. 시스템 프롬프트(prompts.ts)·위젯 즉답 라우트·카카오/텔레그램
// 핸들러·운영자 화면 문구가 전부 «같은 문장»을 본다. 문장이 흩어지면 프롬프트는 A 를
// 시키고 서버는 B 로 판정하는 어긋남이 생긴다(셀프 QA I-08 의 뿌리 중 하나).
//
// 원칙(2026-09-12 사용자 결정): 봇은 근거 없는 사실을 절대 만들지 않는다. 답할 근거가
// 서비스 맥락·답변 지식에 없는 «사실 질문»이면 이 문구로만 답하고 사람에게 넘긴다.
// 피드백(불편·버그·기능 요청·칭찬)은 사실 답변이 아니므로 이 문구를 쓰지 않는다.

/** 방문자에게 나가는 대기 문구(한국어). 모델이 쓰지 않는다 — 모델은 `hold` 플래그만 켜고 서버가 이 문장을 넣는다. */
export const HOLDING_MESSAGE = '담당자가 확인하고 있어요. 조금만 기다려 주세요 🙏';

/** 같은 안내의 영어판(messages/en/common.json 의 holdingMessage 와 같은 문장 — 테스트가 대조). */
export const HOLDING_MESSAGE_EN = 'A person is checking. Please hold on a moment 🙏';

export type HoldingLocale = 'en' | 'ko';

/**
 * 방문자 언어의 대기 문구. 위젯은 대화 언어(`conversations.locale`)를, 카카오·텔레그램은 방문자 말의
 * 언어(`visitorTextLocale`)를 넘긴다. 위젯 응답 안내(lib/widget/strings.ts)도 같은 두 상수를 쓴다.
 */
export function holdingMessage(locale: HoldingLocale): string {
  return locale === 'en' ? HOLDING_MESSAGE_EN : HOLDING_MESSAGE;
}

/**
 * 대화 언어를 저장하지 않는 채널(카카오·텔레그램)에서 «방문자 말의 언어»를 고른다.
 * 한글이 있으면 ko, 한글 없이 라틴 문자만 있으면 en, 둘 다 없으면(이모지·숫자뿐) `fallback`.
 */
export function visitorTextLocale(text: string | null | undefined, fallback: HoldingLocale = 'ko'): HoldingLocale {
  const t = text ?? '';
  if (/[가-힣]/.test(t)) return 'ko';
  if (/[A-Za-z]/.test(t)) return 'en';
  return fallback;
}

/**
 * 위젯이 AI 답을 아예 못 냈을 때(출력 깨짐·설정 실패) 이번 응답에만 싣는 안내.
 * 저장하지 않는다(messages/route.ts 의 ESCALATED_NOTICE 자리). 카카오 폴백도 이 문장이다(한국어 채널).
 */
export const HOLDING_NOTICE = `말씀 잘 받았어요! ${HOLDING_MESSAGE}`;

/**
 * 유저 턴 끝에 한 줄로 붙이는 상기. 시스템 프롬프트에만 있는 규칙은 저가 모델이 자주
 * 놓친다(2026-09-10 실측: flash-lite 4/9 → 유저 턴 규칙 추가 7/9). 유저 입력 «뒤»에 붙는다.
 * 대기 문장을 직접 쓰게 하지 않는다 — `hold` 플래그를 켜면 서버가 방문자 언어로 넣는다.
 */
export const GROUNDING_REMINDER =
  '(Rule: if the message above asks for a fact about the service — policy, quantity, price, period, ' +
  'whether a feature exists, procedure — and neither the service context nor the answer knowledge supports an answer, ' +
  'set "hold" to true and "escalate" to true. ' +
  'If it is feedback, empathize as usual and ask one follow-up question. ' +
  'Otherwise always write a reply in "response" — thanks and greetings get a short one.)';

/** 정책이 보는 결과 모양. handler.ts 의 LlmResult 부분집합 — 순환 import 를 피하려고 구조적으로 둔다. */
export interface HoldingCandidate {
  response: string | null;
  insight: { category?: string | null } | null;
  escalate?: boolean;
  /** 모델이 「근거가 없어 답하지 않는다」고 표시했다(응답 JSON 의 `hold`). `extractResult` 가 escalate 도 같이 켠다. */
  hold?: boolean;
}

/**
 * 대기 문구를 넣는 곳 — 두 경우다.
 *
 *  1. 모델이 `hold: true` 를 냈다 → response 를 방문자 언어의 대기 문구로 채우고 escalate 를 켠다.
 *     예전에는 프롬프트가 «정확히 이 한국어 문장으로 답하라»고 시켰다. 문장 비교는 언어가 늘면 깨지고
 *     모델이 한 글자만 바꿔도 어긋나서, 이제 모델은 플래그만 켜고 문장은 서버가 고른다.
 *  2. 서버측 방어. 모델이 «자신 없다»(escalate) 고 하면서 «질문»(cs) 에 답 텍스트를 냈으면
 *     그 텍스트를 버리고 대기 문구로 바꾼다 — 근거가 없다고 스스로 표시한 답변에 숫자·정책이
 *     섞여 나가는 경로를 닫는다.
 *
 * 2 에서 건드리지 않는 경우:
 *  - response 가 null → 호출부가 미저장 안내(HOLDING_NOTICE)를 쓴다. 저장하면 사람 답장과 말풍선이 둘로 남는다
 *    (예외: 위젯의 «늦은 답» 경로는 응답이 이미 나가 안내를 실을 곳이 없어 대기 문구를 'ai' 로 저장한다)
 *  - cs 가 아닌 escalate(버그 제보 「팀에 전달해서 확인할게요」) → 공감 문장을 살린다
 *  - escalate 가 아닌 cs → 모델이 근거 있다고 답한 것. 지식 안 정답이 여기다
 *
 * @param locale 대기 문구 언어. 기본 ko 는 한국어 채널(카카오)의 종전 동작이다 — 위젯은 대화 언어를 넘긴다.
 * 같은 객체를 돌려준다(호출부가 그대로 저장·전송).
 */
export function applyHoldingPolicy<T extends HoldingCandidate>(result: T, botId?: string, locale: HoldingLocale = 'ko'): T {
  const message = holdingMessage(locale);
  if (result.hold === true) {
    result.response = message;
    result.escalate = true;
    return result;
  }
  // 카테고리는 정규화해서 본다. saveInsight 는 normalizeCategory(trim+소문자)를 거치므로 "CS" 도
  // DB 에는 cs 로 들어간다 — 모델이 지시를 어겼을 때 쓰라고 만든 장치가 모델의 대소문자에 기대면 안 된다.
  // (taxonomy.ts 를 import 하지 않는 이유: 이 모듈은 의존성 0 이어야 UI 가 같이 본다)
  const category = String(result.insight?.category ?? '').trim().toLowerCase();
  if (result.escalate === true && category === 'cs' && result.response) {
    // 이미 대기 문장(어느 언어든)이면 경고 없이 방문자 언어로만 맞춘다
    if (result.response !== HOLDING_MESSAGE && result.response !== HOLDING_MESSAGE_EN) {
      // 발동 흔적을 남긴다 — 「지식 안 정답인데 escalate 를 켠」 과잉 발동은 이 로그로만 셀 수 있다.
      // 원문 앞부분만(운영자 쪽 로그, 방문자에게는 안 간다).
      console.warn(
        `[holding] replaced cs+escalate reply${botId ? ` bot=${botId}` : ''}: "${result.response.replace(/\s+/g, ' ').slice(0, 60)}"`,
      );
    }
    result.response = message;
  }
  return result;
}

// ── I-20 — 물러난 질문은 «항상» 흔적을 남긴다 ─────────────────────────────

/** 서버가 만든 대체 인사이트의 summary 길이. 「최근 대화」 한 턴(300자)보다 짧게 잡는다. */
export const ESCALATED_SUMMARY_CHARS = 200;

/** `ensureEscalationInsight` 가 보는 결과 모양. `HoldingCandidate` 보다 insight 를 좁게 본다. */
export interface EscalationCandidate {
  response: string | null;
  insight: { category: string; summary: string; sentiment: string } | null;
  extends?: string | null;
  escalate?: boolean;
  parsed?: boolean;
}

/**
 * AI 가 물러난(escalate) 턴인데 인사이트가 없으면 **서버가** `cs` 인사이트를 만든다.
 *
 * 왜(셀프 QA I-20): I-05 프롬프트가 「제보할 내용이 아닌 턴은 insight null」 이라고 시킨
 * 뒤로 인사이트 생성이 모델 재량이 됐다. 같은 성격의 사실 질문 6건 중 2건만 `cs` 로
 * 남고 4건은 흔적이 0 이었다 — 「AI 가 못 답한 질문」은 운영자가 FAQ 로 보충할 재료인데
 * 목록 어디에도 안 보였다(`/inbox` 배지는 대화당 1개라 어떤 질문이었는지 모른다).
 *
 * 만들지 «않는» 경우:
 *  - 모델이 이미 인사이트를 냈다 — 우리가 덮을 이유가 없다
 *  - `parsed === false` — 출력이 깨진 경우다. `extractResult` 가 이미 흔적을 남겼고,
 *    거기서 한 번 더 지어내면 깨진 raw 가 두 벌이 된다
 *  - `extends` 가 **실제로 해석되는** ref 다 — 이 턴은 앞 제보의 보충이라 그쪽에 근거로
 *    붙는다(흔적이 이미 있다). 여기서 인사이트를 만들면 `planInsightWrite` 가 **update** 로
 *    가 앞 제보의 summary 를 방문자 원문으로 덮는다.
 *    ⚠️ 목록에 «없는» ref(모델이 지어낸 것)는 제외 사유가 아니다 — 그 턴은 아무 제보에도
 *    안 붙어서 흔적이 0 이 된다. 그래서 문자열 유무가 아니라 `refMap` 해석으로 가른다.
 *  - 칩만 누른 턴·빈 문장 — 담을 내용이 없다
 *
 * summary 는 방문자가 «한 말 그대로»다. 모델이 요약을 안 준 상황이라 지어내지 않는다.
 * 개행은 접는다 — 이 값은 나중에 분류·묶기 프롬프트에 한 줄로 실린다.
 * (`@/lib/text` 의 collapseWhitespace 와 같은 일을 인라인으로 한다. 이 모듈은 UI 도
 *  같이 보므로 의존성 0 을 지킨다 — 파일 머리 주석 참고.)
 */
export function ensureEscalationInsight<T extends EscalationCandidate>(
  result: T,
  text: string,
  opts: { chipOnly?: boolean; refMap?: ReadonlyMap<string, unknown> } = {},
): T {
  if (opts.chipOnly) return result;
  if (result.escalate !== true) return result;
  if (result.insight) return result;
  if (result.parsed === false) return result;
  // classify/ref.ts 의 normalizeRef 와 같은 규칙(대소문자 무시, 앞뒤 공백·대괄호·따옴표 벗김).
  // 그 모듈은 node:crypto 를 쓰므로 의존성 0 인 여기서는 import 하지 않고 같은 식을 둔다.
  const ref = typeof result.extends === 'string' ? result.extends.replace(/^[\s[\]"'`]+|[\s[\]"'`]+$/g, '').toLowerCase() : '';
  if (ref && opts.refMap?.has(ref)) return result;

  const summary = text.replace(/\s+/g, ' ').trim().slice(0, ESCALATED_SUMMARY_CHARS);
  if (!summary) return result;

  result.insight = { category: 'cs', summary, sentiment: 'neutral' };
  return result;
}

/** 응답이 대기 문구(또는 그걸 품은 문장)인지. 두 언어를 다 본다 — 이미 저장된 옛 대화(ko)도 같은 판정이다. */
export function isHoldingResponse(text: string | null | undefined): boolean {
  return typeof text === 'string' && (text.includes(HOLDING_MESSAGE) || text.includes(HOLDING_MESSAGE_EN));
}

// ── 「상담원 연결」 (백로그 B2, 2026-09-13 v2) ─────────────────
//
// 위 대기 문구는 «AI 가» 모른다고 물러날 때 쓰고, 아래는 «방문자가» 상담원을 부를 때 쓴다.
// 조사(docs/14-셀프QA/리서치-AI→상담원-연결-패턴-2026-09-13.md): 국내는 「상담원 연결」 4글자가 표준이고,
// 넘기는 순간 «무엇을» 넘겼는지 문장으로 말하며, 상주가 없으면 기대치(언제 답하는지)를 같이 건다.
//
// 위젯(widget.js)은 import 를 못 하므로 같은 리터럴을 박아 두고 __tests__/widget-escalate.test.ts 가
// «이 상수와 같은지» 대조한다. 운영자 미리보기는 상수를 직접 쓴다.

/** 위젯 하단 버튼·AI 대기 문구 밑 칩의 라벨. */
export const ASK_HUMAN_LABEL = '상담원 연결';
/** 넘어간 동안 버튼 자리에 보이는 상태 줄의 머리. 위젯이 뒤에 ` · <봇 status_text>` 를 붙인다. */
export const ESCALATED_STATUS = '상담원에게 전달됐어요';
/** 상담원 연결 폼의 제목·안내·전송 버튼. */
export const HANDOFF_FORM_TITLE = '상담원에게 남길 말';
export const HANDOFF_SUBMIT_LABEL = '상담원에게 보내기';

/** 안내 칩에 인용할 때 자르는 길이. 한 줄 칩이라 길면 화면을 먹는다. */
export const HANDOFF_QUOTE_CHARS = 60;

/**
 * 「상담원 연결」 직후 타임라인에 저장되는 안내(responses.response_type='system').
 * «무엇을» 넘겼는지(인용) · «언제» 답하는지(봇 status_text) · «어디로» 알리는지를 한 문장에 담는다.
 * 이메일을 남긴 방문자에게만 「이메일」을 약속한다 — 운영자 답장 메일은 contact_email 이 있을 때만
 * 나가므로(lib/email/notify.ts), 없는 사람에게 메일을 약속하면 거짓이 된다.
 */
export function escalationNotice(opts: {
  /** 방문자 언어(위젯 요청의 ?locale=). 안내 문장을 그 언어로 쓴다. */
  locale: 'en' | 'ko';
  quote: string | null;
  hasEmail: boolean;
  /** 봇의 status_text(「보통 몇 분 안에 답해요」). 없으면 기대치 문장을 뺀다. */
  statusText?: string | null;
}): string {
  const q = (opts.quote ?? '').replace(/\s+/g, ' ').trim();
  // 코드포인트 단위로 자른다 — 이모지(서로게이트 쌍) 가운데를 쪼개면 깨진 글자가 칩에 남는다
  const cps = Array.from(q);
  const cut = cps.length > HANDOFF_QUOTE_CHARS ? cps.slice(0, HANDOFF_QUOTE_CHARS).join('') + '…' : q;
  const when = (opts.statusText ?? '').trim();
  if (opts.locale === 'en') {
    const quotedEn = q ? `"${cut}" ` : 'Your request ';
    return `${quotedEn}was passed to a person.${when ? ` ${when}.` : ''} We'll let you know here${opts.hasEmail ? ' and by email' : ''} when they reply 🙏`;
  }
  const quoted = q ? `"${cut}" 를 ` : '';
  const where = opts.hasEmail ? '여기와 이메일로' : '여기로';
  return `${quoted}상담원에게 전달했어요.${when ? ` ${when}.` : ''} 답이 오면 ${where} 알려드려요 🙏`;
}

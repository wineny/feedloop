// 봇 설정 › 위젯 모양 — 입력 검증과 폴백 문구.
//
// 이 모듈은 의존성이 없다(서버 클라이언트를 끌어오지 않는다). PATCH 라우트와
// 운영자용 폼·미리보기가 같은 규칙을 쓰기 위해서다. 여기서 서버 전용 모듈을
// import 하는 순간 클라이언트 컴포넌트가 이걸 못 쓰게 되니 그대로 둘 것.

import { collapseWhitespace } from '@/lib/text';

/**
 * 문자열 한 줄짜리 모양 값. DB 컬럼명 그대로.
 * 마이그레이션 20260906_03_widget_appearance.sql · 20260910_06_widget_colors.sql
 *
 * 배열인 starter_questions 는 여기 없다 — 아래에서 따로 검증한다.
 */
export const APPEARANCE_FIELDS = [
  'display_name',
  'status_text',
  'greeting',
  'operator_display_name',
  'profile_image_url',
  'accent_color',
  'visitor_bubble_color',
] as const;

export type AppearanceField = (typeof APPEARANCE_FIELDS)[number];

/**
 * 검증을 통과한 값. 빈 값은 null 로 정규화된다(= 폴백을 쓰겠다는 뜻).
 * starter_questions 만 배열이고, 빈 배열이 「FAQ 폴백을 쓰겠다」는 뜻이다.
 */
export type AppearanceValues = Partial<Record<AppearanceField, string | null>> & {
  starter_questions?: string[];
  starter_faq_fallback?: boolean;
};

export type AppearanceResult =
  | { ok: true; values: AppearanceValues }
  | { ok: false; error: string; code: string; vars?: Record<string, string | number> };

const LIMITS: Record<AppearanceField, number> = {
  display_name: 40,
  status_text: 60,
  greeting: 300,
  operator_display_name: 40,
  profile_image_url: 500,
  // #rrggbb 7자. #rgb(4자)도 받아서 여기서 펼친다.
  // 색은 정규식이 실질 방어선이라 이 값은 쓰이지 않는다 — 필드 목록을 채우기 위해 둔다.
  accent_color: 7,
  visitor_bubble_color: 7,
};

const LABELS: Record<AppearanceField, string> = {
  display_name: '표시 이름',
  status_text: '상태 문구',
  greeting: '첫 인사말',
  operator_display_name: '운영자 답장 이름',
  profile_image_url: '프로필 이미지 URL',
  accent_color: '강조색',
  visitor_bubble_color: '내 말풍선색',
};

/** 오류 문구의 입력칸 이름 — 사전 `errors.fields.<키>`(`apiValidation` 이 `vars.field` 를 이 이름으로 바꿔 끼운다). */
const FIELD_KEYS: Record<AppearanceField, string> = {
  display_name: 'displayName',
  status_text: 'statusText',
  greeting: 'greeting',
  operator_display_name: 'operatorDisplayName',
  profile_image_url: 'profileImageUrl',
  accent_color: 'accentColor',
  visitor_bubble_color: 'visitorBubbleColor',
};

/**
 * PATCH body 를 위젯 모양 값으로 정규화한다.
 *
 * - 알 수 없는 필드는 조용히 버린다 — 나중에 컬럼이 늘어도 옛 클라이언트가 안 깨진다
 * - 문자열(과 명시적 null)만 받는다. 숫자·객체는 거절 — 조용히 문자열로 바꾸면
 *   DB 에 "[object Object]" 같은 게 들어간다
 * - 빈 문자열은 null. 위젯 config 라우트가 null 을 보고 service_name 폴백을 쓴다
 */
export function validateAppearanceInput(body: unknown): AppearanceResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '잘못된 요청 형식입니다', code: 'badRequest' };
  }

  const input = body as Record<string, unknown>;
  const values: AppearanceValues = {};

  for (const field of APPEARANCE_FIELDS) {
    if (!(field in input)) continue;

    const raw = input[field];
    if (raw === null || raw === undefined) {
      values[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `${LABELS[field]} 은(는) 문자열이어야 합니다`, code: 'notString', vars: { field: FIELD_KEYS[field] } };
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      values[field] = null;
      continue;
    }
    // 색 필드는 형식을 «길이보다 먼저» 본다. 순서가 뒤면 `rgb(242,100,92)` 를
    // 붙여넣은 운영자가 「7자까지 입력할 수 있습니다」를 보게 된다 —
    // 자릿수가 문제가 아니라 표기법이 문제인데 엉뚱한 곳을 고치게 만든다.
    if (COLOR_FIELDS.has(field)) {
      // 이 값은 위젯 CSS 변수로 그대로 들어간다. 자유 문자열을 허용하면
      // `red;background:url(...)` 같은 걸 넣어 방문자 화면의 스타일을 비틀 수 있다.
      // #rrggbb 만 받고, 그 외는 전부 거절한다.
      const hex = normalizeHexColor(trimmed);
      if (!hex) {
        return {
          ok: false,
          error: `${LABELS[field]} 은(는) #RRGGBB 형식의 색상 코드여야 합니다`,
          code: 'colorFormat',
          vars: { field: FIELD_KEYS[field] },
        };
      }
      values[field] = hex;
      continue;
    }
    if (trimmed.length > LIMITS[field]) {
      return {
        ok: false,
        error: `${LABELS[field]} 은(는) ${LIMITS[field]}자까지 입력할 수 있습니다`,
        code: 'tooLong',
        vars: { field: FIELD_KEYS[field], max: LIMITS[field] },
      };
    }
    if (field === 'profile_image_url' && !isHttpsUrl(trimmed)) {
      // 위젯은 대부분 https 사이트에 붙는다. http 이미지는 혼합 콘텐츠로 차단돼
      // 저장은 됐는데 방문자 화면에는 안 보이는 상태가 된다 — 여기서 막는다.
      return { ok: false, error: '프로필 이미지는 https:// 로 시작하는 주소만 넣을 수 있습니다', code: 'profileImageHttps' };
    }

    values[field] = trimmed;
  }

  if ('starter_questions' in input) {
    const questions = validateStarterQuestions(input.starter_questions);
    if (!questions.ok) return questions;
    values.starter_questions = questions.value;
  }

  if ('starter_faq_fallback' in input) {
    // 문자열 'false' 를 참으로 삼키지 않도록 boolean 만 받는다. 다른 필드가
    // 숫자·객체를 거절하는 것과 같은 이유다 — 조용히 변환하면 운영자가 끈 줄 알고
    // 있는데 방문자 화면에는 계속 FAQ 질문이 뜬다.
    // 불리언 컬럼에는 「비우겠다」는 상태가 없다 — 다른 필드에서 null 이 「폴백을 쓰겠다」인
    // 것과 규칙이 다르다. 통일하려다 null 을 통과시키면 NOT NULL 제약에 걸려 500 이 된다.
    if (typeof input.starter_faq_fallback !== 'boolean') {
      return { ok: false, error: '시작 질문 자동 채우기는 true/false 여야 합니다', code: 'starterFallbackBoolean' };
    }
    values.starter_faq_fallback = input.starter_faq_fallback;
  }

  if (Object.keys(values).length === 0) {
    return { ok: false, error: '변경할 항목이 없습니다', code: 'nothingToChange' };
  }

  return { ok: true, values };
}

// ── 시작 질문 ───────────────────────────────────────
//
// 위젯 첫 화면의 「자주 묻는 질문」 칩. 누르면 그 문장이 그대로 전송돼 방문자가
// 첫 답을 바로 받는다 — 그래서 문장은 짧고, 하나의 질문이어야 한다.
//
// 이 값은 무인증 위젯 config 로 방문자 브라우저에 나간다. 운영자만 쓸 수 있지만
// 읽는 쪽은 아무나라서, 길이·개수를 여기서 확실히 자른다.

export const MAX_STARTER_QUESTIONS = 4;
export const MAX_STARTER_QUESTION_CHARS = 40;

/** FAQ 에서 질문만 뽑아 폴백으로 쓸 때의 개수. 운영자 상한(4)보다 하나 적다 — §폴백 주석 참고. */
export const STARTER_FAQ_FALLBACK_COUNT = 3;

export type StarterQuestionsResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string; code: string; vars?: Record<string, string | number> };

/**
 * PATCH body 의 starter_questions 를 정규화한다.
 *
 * - 배열이 아니면 거절. null 은 「비우겠다」는 뜻이라 빈 배열로 받는다
 * - 빈 문자열·공백만인 항목은 버린다 (폼에서 칸을 비워 지우는 경로)
 * - 줄바꿈은 공백으로 접는다 — 칩은 한 줄짜리 알약이라 개행이 들어가면 모양이 깨진다
 * - 중복은 버린다. 같은 칩이 두 개 뜨면 방문자는 둘 중 뭐가 다른지 찾느라 멈춘다
 */
export function validateStarterQuestions(raw: unknown): StarterQuestionsResult {
  if (raw === null || raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: '시작 질문은 목록이어야 합니다', code: 'starter.notList' };
  }

  // 일하기 «전에» 거절한다. 빈 줄을 버리는 관용 때문에 항목 수와 결과 수가 다를 수
  // 있어 넉넉히 잡지만, 20만 줄을 다 훑고 나서 「4개까지」를 말하지는 않는다 —
  // 보안 리뷰 실측으로 5만 항목에 1.9초가 걸렸다(서버리스 함수 CPU).
  if (raw.length > MAX_STARTER_QUESTIONS * 10) {
    return { ok: false, error: `시작 질문은 ${MAX_STARTER_QUESTIONS}개까지 넣을 수 있습니다`, code: 'starter.tooMany', vars: { max: MAX_STARTER_QUESTIONS } };
  }

  // 중복 검사는 Set 으로. 배열 includes 면 항목 수의 제곱만큼 비교한다.
  const seen = new Set<string>();
  const value: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, error: '시작 질문은 문장이어야 합니다', code: 'starter.notString' };
    }
    const text = collapseWhitespace(item);
    if (!text) continue;
    if (text.length > MAX_STARTER_QUESTION_CHARS) {
      return {
        ok: false,
        error: `시작 질문은 ${MAX_STARTER_QUESTION_CHARS}자까지 입력할 수 있습니다`,
        code: 'starter.tooLong',
        vars: { max: MAX_STARTER_QUESTION_CHARS },
      };
    }
    if (seen.has(text)) continue;
    seen.add(text);
    value.push(text);
  }

  if (value.length > MAX_STARTER_QUESTIONS) {
    return { ok: false, error: `시작 질문은 ${MAX_STARTER_QUESTIONS}개까지 넣을 수 있습니다`, code: 'starter.tooMany', vars: { max: MAX_STARTER_QUESTIONS } };
  }

  return { ok: true, value };
}


/**
 * 쓸 만한 질문만 골라 limit 까지 담는다 — 읽기 경로의 관대한 정규화.
 *
 * validateStarterQuestions 와 달리 «거절하지 않는다». 쓰기(PATCH)는 운영자에게
 * 무엇이 틀렸는지 말해줘야 하지만, 읽기는 그럴 상대가 없다 — 방문자 화면에서
 * 조용히 최선을 그리는 게 맞다.
 *
 * 긴 질문은 잘라 넣지 않고 건너뛴다. 자르면 뜻이 잘린 칩("쿠폰은 한 사람이 하루에
 * 몇 장까지 받을 수")이 남는데, 그건 안 보여주느니만 못하다.
 */
function pickQuestions(list: unknown, limit: number, read: (entry: unknown) => unknown): string[] {
  if (!Array.isArray(list)) return [];

  const out: string[] = [];
  for (const entry of list) {
    if (out.length >= limit) break;
    const raw = read(entry);
    if (typeof raw !== 'string') continue;

    const text = collapseWhitespace(raw);
    if (!text || text.length > MAX_STARTER_QUESTION_CHARS) continue;
    if (out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * 방문자에게 실제로 보일 시작 질문을 고른다 — 운영자 지정이 우선, 없으면 FAQ.
 *
 * `faqFallback` 이 false 면 «칸이 비었을 때 아무것도 안 띄운다». 끄는 스위치가 없으면
 * 운영자가 동의한 적 없는 FAQ 질문이 공개 첫 화면에 뜬다(20260911_02 주석 참고).
 * 직접 쓴 시작 질문이 있으면 이 값과 무관하게 그게 이긴다 — 띄우겠다는 의사가 명시적이다.
 *
 * FAQ 폴백을 더 적게(3개) 쓰는 이유: 운영자가 고른 질문은 그 서비스에서 실제로 많이
 * 묻는 것이지만, FAQ 앞쪽은 그냥 문서 순서라 첫 화면에 걸맞은 질문이라는 보장이 없다.
 * 확신이 낮은 쪽을 덜 보여준다.
 *
 * 답변(a)은 절대 꺼내지 않는다. 이 반환값은 무인증 config 응답에 그대로 실린다 —
 * FAQ 본문까지 나가면 봇 지식이 통째로 공개된다.
 */
export function resolveStarterQuestions(
  starterQuestions: unknown,
  faq: unknown,
  faqFallback: boolean,
): string[] {
  const picked = pickQuestions(starterQuestions, MAX_STARTER_QUESTIONS, (entry) => entry);
  if (picked.length > 0) return picked;
  if (!faqFallback) return [];

  // hasOwnProperty 로 «그 객체가 실제로 가진» q 만 읽는다. 체인을 타면 누군가
  // Object.prototype.q 를 오염시켰을 때 그 값이 모든 봇의 무인증 config 에 칩으로 뜬다.
  return pickQuestions(faq, STARTER_FAQ_FALLBACK_COUNT, (entry) =>
    typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, 'q')
      ? (entry as Record<string, unknown>).q
      : undefined,
  );
}

/**
 * DB 의 `starter_faq_fallback` 값을 읽는다.
 *
 * 컬럼은 `BOOLEAN NOT NULL DEFAULT true`(20260911_02)라 실제로 도달하는 값은
 * true/false 뿐이다 — **그 제약이 이 함수의 전제다.** 컬럼이 아예 없는 경우는
 * 여기로 오지 않는다. 그러면 `resolveWidgetBot` 의 SELECT 가 통째로 실패해
 * 봇이 null 이 되고, 위젯은 그걸 「없는 봇」으로 읽어 스스로를 지운다.
 *
 * 인자를 `unknown` 이 아니라 `boolean | null` 로 좁힌 이유: 이 함수가 틀리면
 * «공개되는 쪽»으로 틀린다. 누가 resolveWidgetBot 의 select 에서 이 컬럼을 지우면
 * 값이 undefined 가 되는데, unknown 을 받으면 쿼리도 타입 검사도 테스트도 전부
 * 초록인 채로 «운영자가 끈 스위치만 조용히 무시»된다. 좁혀 두면 그 순간 tsc 가 잡는다.
 * (null 은 스키마상 오지 않지만, 컬럼 제약이 바뀌는 날을 위해 받아 둔다.)
 */
export function readFaqFallback(value: boolean | null): boolean {
  return value ?? true;
}

const COLOR_FIELDS: ReadonlySet<AppearanceField> = new Set([
  'accent_color',
  'visitor_bubble_color',
]);

const HEX_LONG = /^#[0-9a-f]{6}$/i;
const HEX_SHORT = /^#[0-9a-f]{3}$/i;

/**
 * #RRGGBB 로 정규화한다. #RGB 는 펼치고, 대문자는 내린다.
 * 형식이 아니면 null — 색 이름(`red`)·`rgb()`·CSS 변수는 전부 여기서 걸린다.
 *
 * 소문자로 고정하는 이유: DB 에 `#F2645C` 와 `#f2645c` 가 섞이면
 * "기본색과 같은지" 비교가 문자열로 안 된다.
 */
export function normalizeHexColor(value: string): string | null {
  const raw = value.trim();
  if (HEX_LONG.test(raw)) return raw.toLowerCase();
  if (HEX_SHORT.test(raw)) {
    const [, r, g, b] = raw.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:';
}

// ── 폴백 ────────────────────────────────────────────
//
// 비어 있는 상태 문구·인사말·운영자 이름의 기본 문구는 사전 `messages/<locale>/bots.json` 의 `defaults` 한 곳에 있다
// (위젯 config 라우트는 lib/widget/strings.ts 로, 운영자 미리보기는 번역 훅으로 읽는다).

// 색 기본값. widget.js 의 CSS 폴백(`var(--fl-accent, #F2645C)`)과 같은 값이어야 한다.
// 한쪽만 고치면 운영자 미리보기와 실제 위젯이 다른 색으로 뜬다.
export const DEFAULT_ACCENT_COLOR = '#f2645c';
export const DEFAULT_VISITOR_BUBBLE_COLOR = '#191d1b';

// ── 파생 색 ─────────────────────────────────────────
//
// 강조색 하나에서 나머지를 만든다 — 위에 올릴 글자색, 글자·테두리용 강조색,
// 틴트(카드 배경·AI 배지 배경)와 그 테두리.
// widget.js 도 같은 계산을 한다(의존성 0 이라 import 를 못 한다) — 값을 고치면 양쪽을 같이.
// 두 구현이 어긋나지 않는지는 __tests__/appearance.test.ts 가 위젯 소스에서
// 함수를 떼어내 실행으로 대조한다.
// color-mix() 를 안 쓰는 이유: 위젯은 아무 고객 사이트에나 붙고 브라우저를 고를 수 없다.

const WHITE = '#ffffff';
const INK = '#191d1b';

/** WCAG 상대 명도 (0=검정, 1=흰색). hex 가 아니면 null. */
export function relativeLuminance(hex: string): number | null {
  const c = normalizeHexColor(hex);
  if (!c) return null;
  const channel = (i: number) => {
    const v = parseInt(c.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * 밝은 색 위에 흰 글씨가 얹혀 안 읽히는 걸 막는 임계값.
 *
 * "대비가 더 큰 쪽"이 아니라 명도 임계값을 쓴다. 대비 최대화로 고르면
 * 중간 파랑(#0a7cff, 흰색 3.93 : 잉크 4.40)에서 검은 글씨가 나온다 —
 * 말풍선으로는 아무도 그렇게 안 쓴다. 위젯 기본값이 흰 글씨이므로
 * 흰색 쪽으로 기울여 두고, 정말 밝은 색에서만 잉크로 넘어간다.
 */
export const LIGHT_BACKGROUND_LUMINANCE = 0.5;

/** 두 색을 섞는다. ratio = 첫 색의 비율(0~1). */
export function mixColors(hex: string, other: string, ratio: number): string {
  const a = normalizeHexColor(hex);
  const b = normalizeHexColor(other);
  if (!a || !b) return WHITE;
  const byte = (c: string, i: number) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = (i: number) => Math.round(byte(a, i) * ratio + byte(b, i) * (1 - ratio));
  return `#${[0, 1, 2].map((i) => mixed(i).toString(16).padStart(2, '0')).join('')}`;
}

/** hex 를 흰색과 섞는다. ratio = 원색 비율(0~1). */
export function mixWithWhite(hex: string, ratio: number): string {
  return mixColors(hex, WHITE, ratio);
}

/** 그 색 위에 올릴 글자색. 흰색 또는 잉크. */
export function readableTextOn(hex: string): string {
  const lum = relativeLuminance(hex);
  if (lum === null) return WHITE;
  return lum > LIGHT_BACKGROUND_LUMINANCE ? INK : WHITE;
}

/**
 * 흰 바탕 위의 «글자·선»으로 써도 보이는 명도 상한.
 *
 * LIGHT_BACKGROUND_LUMINANCE(0.5)를 쓰면 안 된다 — 그건 "이 색 위에 흰 글씨를
 * 얹을까"의 기준이고, 명도 0.5 인 색은 흰 바탕 대비가 1.9:1 밖에 안 돼
 * 링크로는 안 읽힌다. 여기 기준은 흰색 대비 3:1(= 명도 0.30)이다.
 *
 * 왜 3:1 인가: 지금 쓰는 코랄 #F2645C 의 명도가 0.288(대비 3.1:1)이다.
 * 즉 이 상한은 «이미 배포된 화면과 같은 바»이고, 기존 봇의 강조색은
 * 한 번도 깎이지 않는다.
 */
export const ACCENT_ON_WHITE_MAX_LUMINANCE = 0.3;

/**
 * 흰 바탕에서 글자·테두리로 쓸 수 있을 만큼 어두운 강조색.
 *
 * 왜 필요한가: 강조색은 두 가지로 쓰인다 — 꽉 찬 배경(플로팅 버튼·보내기)과
 * 흰 바탕 위의 글자·선(AI 배지 글자, 되돌림 카드 링크, 칩 hover 테두리).
 * 배경 쪽은 글자색만 뒤집으면 되지만, 글자 쪽은 색 자체가 안 보이게 된다 —
 * `#ffe066` 링크는 흰 카드 위에서 읽히지 않는다.
 *
 * 충분히 어두운 강조색(코랄 포함)은 «그대로 돌려준다» — 기존 봇의 픽셀이 안 바뀐다.
 * 밝은 색만 잉크 쪽으로 5%씩 당겨 상한 아래로 내린다. 고정 비율로 한 번에
 * 깎지 않는 이유는 경계에 살짝 걸친 색을 과하게 어둡게 만들지 않기 위해서다.
 */
export function readableAccent(hex: string): string {
  const c = normalizeHexColor(hex);
  if (!c) return DEFAULT_ACCENT_COLOR;

  // 정수 퍼센트로 훑는다 — widget.js 와 부동소수 연산 순서를 똑같이 맞추기 위해서다.
  for (let percent = 100; percent > 0; percent -= 5) {
    const candidate = mixColors(c, INK, percent / 100);
    const lum = relativeLuminance(candidate);
    if (lum !== null && lum <= ACCENT_ON_WHITE_MAX_LUMINANCE) return candidate;
  }
  return INK;
}

/**
 * 틴트 = 12%(카드·배지 배경), 테두리 = 20%.
 * 어두운 강조색에서는 기존 코랄 틴트(#FDF1F0·#FBE2E2)와 같은 농도가 나온다.
 */
export const ACCENT_TINT_RATIO = 0.12;
export const ACCENT_TINT_BORDER_RATIO = 0.2;

/**
 * 카드 배경·테두리에 쓰는 틴트.
 *
 * 원색이 아니라 readableAccent 를 흰색과 섞는다. 밝은 강조색을 그대로 12%
 * 섞으면 결과가 흰색과 구별되지 않아 되돌림 카드가 통째로 사라진다
 * (`#ffe066` → `#fffbed`). 리뷰가 제안한 «잉크와 섞기»는 반대로 카드가
 * 거의 검게 나오는데 카드 안의 글자색이 잉크로 박혀 있어 못 읽는다 —
 * 그래서 «어둡게 만든 강조색을 흰색과 섞는» 쪽으로 갔다.
 */
export function accentTint(hex: string, ratio: number): string {
  return mixWithWhite(readableAccent(hex), ratio);
}

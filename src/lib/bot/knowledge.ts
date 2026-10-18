// 봇 설정 › 답변 지식 — 입력 검증과 프롬프트 직렬화.
//
// 이 모듈은 의존성이 없다(서버 클라이언트를 끌어오지 않는다). PATCH 라우트와
// 운영자용 폼이 같은 규칙 — 특히 같은 «글자 수 상한» — 을 쓰기 위해서다.
// appearance.ts 와 같은 이유이므로 여기서 서버 전용 모듈을 import 하지 말 것.
//
// 지식은 검색하지 않고 시스템 프롬프트에 통째로 실린다(계획 §3-A 스터핑).
// 그래서 상한이 곧 «호출 1건의 입력 토큰 최악값»이고, 그 값이 일일 상한 계산의
// 근거가 된다(계획 §3-C). 상한을 올리려면 상한 건수도 같이 봐야 한다.

/** DB 컬럼명 그대로. 마이그레이션 20260910_01_bot_knowledge_byok.sql */
export const KNOWLEDGE_LIMITS = {
  text: 20_000,
  faqItems: 50,
  faqQuestion: 200,
  faqAnswer: 1_000,
} as const;

export type FaqItem = { q: string; a: string };

/** 검증을 통과한 값. 보내지 않은 필드는 키 자체가 없다(부분 수정 허용). */
export type KnowledgeValues = {
  knowledge_text?: string | null;
  knowledge_faq?: FaqItem[];
};

export type KnowledgeResult =
  | { ok: true; values: KnowledgeValues }
  | { ok: false; error: string };

/**
 * PATCH body 를 답변 지식 값으로 정규화한다.
 *
 * - 알 수 없는 필드는 조용히 버린다 (appearance.ts 와 같은 규칙)
 * - 상한 초과는 «거절»한다. 자르지 않는다 — 조용히 잘리면 운영자는 봇이 왜
 *   그 부분을 모르는지 영원히 알 수 없다(계획 §3-A)
 * - 빈 문자열은 null. FAQ 는 빈 배열이 정상값이라 null 로 바꾸지 않는다
 * - FAQ 항목 중 q 나 a 가 비면 «그 항목만» 버린다. 화면이 [항목 추가] 로 만든
 *   빈 행이 그대로 올라오므로, 그걸 에러로 돌려주면 저장이 안 되는 것처럼 보인다
 */
export function validateKnowledgeInput(body: unknown): KnowledgeResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '잘못된 요청 형식입니다' };
  }

  const input = body as Record<string, unknown>;
  const values: KnowledgeValues = {};

  if ('knowledge_text' in input) {
    const raw = input.knowledge_text;
    if (raw === null || raw === undefined) {
      values.knowledge_text = null;
    } else if (typeof raw !== 'string') {
      return { ok: false, error: '답변 지식은 문자열이어야 합니다' };
    } else {
      const trimmed = raw.trim();
      if (!trimmed) {
        values.knowledge_text = null;
      } else if (trimmed.length > KNOWLEDGE_LIMITS.text) {
        return {
          ok: false,
          error: `답변 지식은 ${KNOWLEDGE_LIMITS.text.toLocaleString('en-US')}자까지 입력할 수 있습니다 (지금 ${trimmed.length.toLocaleString('en-US')}자)`,
        };
      } else {
        values.knowledge_text = trimmed;
      }
    }
  }

  if ('knowledge_faq' in input) {
    const raw = input.knowledge_faq;
    if (raw === null || raw === undefined) {
      values.knowledge_faq = [];
    } else if (!Array.isArray(raw)) {
      return { ok: false, error: 'FAQ 는 목록이어야 합니다' };
    } else {
      const items: FaqItem[] = [];

      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return { ok: false, error: 'FAQ 항목은 질문과 답변을 가진 객체여야 합니다' };
        }
        const { q, a } = entry as Record<string, unknown>;

        // 아직 안 채운 행은 에러가 아니다 — 버리고 넘어간다.
        if (q === null || q === undefined) continue;
        if (a === null || a === undefined) continue;
        if (typeof q !== 'string' || typeof a !== 'string') {
          return { ok: false, error: 'FAQ 의 질문과 답변은 문자열이어야 합니다' };
        }

        const question = q.trim();
        const answer = a.trim();
        if (!question || !answer) continue;

        if (question.length > KNOWLEDGE_LIMITS.faqQuestion) {
          return { ok: false, error: `FAQ 질문은 ${KNOWLEDGE_LIMITS.faqQuestion}자까지 입력할 수 있습니다` };
        }
        if (answer.length > KNOWLEDGE_LIMITS.faqAnswer) {
          return { ok: false, error: `FAQ 답변은 ${KNOWLEDGE_LIMITS.faqAnswer.toLocaleString('en-US')}자까지 입력할 수 있습니다` };
        }

        items.push({ q: question, a: answer });
      }

      // 빈 행을 «버린 뒤» 센다. 화면이 만든 빈 행이 상한을 잡아먹지 않게.
      if (items.length > KNOWLEDGE_LIMITS.faqItems) {
        return {
          ok: false,
          error: `FAQ 는 ${KNOWLEDGE_LIMITS.faqItems}개까지 넣을 수 있습니다 (지금 ${items.length}개)`,
        };
      }

      values.knowledge_faq = items;
    }
  }

  if (Object.keys(values).length === 0) {
    return { ok: false, error: '변경할 항목이 없습니다' };
  }

  return { ok: true, values };
}

/**
 * 프롬프트에 실을 문자열로 직렬화한다.
 *
 * 빈 값이면 «빈 문자열»을 준다. 호출부(prompts.ts)가 그걸 보고 「## 답변 지식」
 * 섹션과 규칙을 통째로 지운다 — 빈 섹션을 남기면 모델이 그 공백을 채우려 들고,
 * 지식이 아직 0인 봇에게 "지식에 있는 것만 답해라"를 걸면 아무 말도 못 하게 된다.
 */
export function renderKnowledge(text: string | null | undefined, faq: FaqItem[] | null | undefined): string {
  const parts: string[] = [];

  const body = text?.trim();
  if (body) parts.push(body);

  const items = (faq ?? []).filter((f) => f && f.q?.trim() && f.a?.trim());
  if (items.length > 0) {
    const rendered = items.map((f) => `Q: ${f.q.trim()}\nA: ${f.a.trim()}`).join('\n\n');
    parts.push(`### 자주 묻는 질문\n${rendered}`);
  }

  return parts.join('\n\n');
}

/** 프롬프트에 실리는 크기. 운영자 화면이 "≈ N자" 로 보여준다. */
export function knowledgeSize(text: string | null | undefined, faq: FaqItem[] | null | undefined): number {
  return renderKnowledge(text, faq).length;
}

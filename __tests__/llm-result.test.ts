import { describe, it, expect } from 'vitest';
import { extractResult } from '@/lib/bot/handler';

// 예전 catch 블록은 raw 를 그대로 response 로 돌려줬다. JSON 이 깨지면 모델의
// 원시 출력이 방문자에게 그대로 갔다는 뜻이다 — 시스템 프롬프트 조각이 섞여 있어도.
// "지어내지 않는다"는 원칙은 출력 파싱이 깨진 경우에도 적용돼야 한다(계획 §A-3).

describe('extractResult — 파싱 실패', () => {
  it('깨진 JSON 이면 response 는 null, escalate 는 true, parsed 는 false 다', () => {
    const result = extractResult('{ "response": "여기서 끊김');

    expect(result.response).toBeNull();
    expect(result.escalate).toBe(true);
    expect(result.parsed).toBe(false);
  });

  it('깨진 JSON 의 raw 가 response 로 새어나가지 않는다', () => {
    const raw = '너는 "널널투어"라는 이름의 AI 비서야. SECRET_MARKER_9f3a';
    const result = extractResult(raw);

    expect(result.response).toBeNull();
    expect(JSON.stringify(result.response)).not.toContain('SECRET_MARKER_9f3a');
  });

  it('raw 앞부분은 insight.summary 에 남는다 — 운영자 쪽 기록이라 디버깅에 필요하다', () => {
    const result = extractResult('완전히 깨진 출력');

    expect(result.insight).toEqual({
      category: 'other',
      summary: '완전히 깨진 출력',
      sentiment: 'neutral',
    });
  });

  it('summary 는 200자까지만 남긴다', () => {
    const result = extractResult('가'.repeat(500));

    expect(result.insight?.summary).toHaveLength(200);
  });
});

describe('extractResult — 정상 파싱 (회귀)', () => {
  it('정상 JSON 은 예전과 똑같이 파싱한다', () => {
    const raw = JSON.stringify({
      response: '확인해볼게요!',
      insight: { category: 'bug', summary: '쿠폰 적용 안 됨', sentiment: 'negative' },
      escalate: true,
    });

    const result = extractResult(raw);

    expect(result.response).toBe('확인해볼게요!');
    expect(result.insight).toEqual({ category: 'bug', summary: '쿠폰 적용 안 됨', sentiment: 'negative' });
    expect(result.escalate).toBe(true);
    expect(result.parsed).toBe(true);
  });

  it('```json 코드펜스로 감싼 응답도 그대로 파싱한다 (회귀)', () => {
    const raw = '```json\n{"response":"네!","insight":null}\n```';

    const result = extractResult(raw);

    expect(result.response).toBe('네!');
    expect(result.insight).toBeNull();
    expect(result.parsed).toBe(true);
  });

  it('escalate 가 없으면 false 다 — 기존 동작 유지', () => {
    const result = extractResult('{"response":"넵","insight":null}');

    expect(result.escalate).toBe(false);
    expect(result.parsed).toBe(true);
  });

  it('response 가 없는 정상 JSON 은 null 이지만 parsed 는 true 다 (파싱 실패와 구분된다)', () => {
    const result = extractResult('{"response":null,"insight":null}');

    expect(result.response).toBeNull();
    expect(result.parsed).toBe(true);
    expect(result.escalate).toBe(false);
  });
});

describe('durable classification requires a complete result shape', () => {
  it.each(['{}', '[]', 'null', '{"response":"ok"}', '{"response":{},"insight":null}', '{"response":null,"insight":{"category":"bug"}}'])('rejects malformed JSON result %s', (raw) => {
    expect(extractResult(raw).parsed).toBe(false);
  });
});

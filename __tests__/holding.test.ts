import { describe, it, expect, vi } from 'vitest';
import {
  ESCALATED_SUMMARY_CHARS,
  GROUNDING_REMINDER,
  HOLDING_MESSAGE,
  HOLDING_NOTICE,
  applyHoldingPolicy,
  ensureEscalationInsight,
  isHoldingResponse,
} from '@/lib/bot/holding';

// 모델이 「자신 없다」(escalate) 고 표시한 «사실 답변»의 텍스트는 방문자에게 나가면 안 된다.
// 프롬프트가 시키는 것과 별개로 서버가 한 겹 더 막는다 — 프롬프트는 저가 모델이 놓칠 수 있고,
// 그때 나가는 문장이 바로 지어낸 숫자다(셀프 QA I-08).
describe('applyHoldingPolicy', () => {
  it('escalate + cs + 답 텍스트 → 대기 문구로 바꾼다', () => {
    const result = applyHoldingPolicy({
      response: '쿠폰은 하루 최대 3장까지 받으실 수 있어요!',
      insight: { category: 'cs', summary: '쿠폰 일일 발급 수 문의', sentiment: 'neutral' },
      escalate: true,
    });

    expect(result.response).toBe(HOLDING_MESSAGE);
    // 인사이트는 그대로 — 운영자가 무슨 질문이었는지 알아야 답할 수 있다
    expect(result.insight?.summary).toBe('쿠폰 일일 발급 수 문의');
  });

  it('cs 가 아닌 escalate 는 건드리지 않는다 — 버그 제보의 공감 문장은 살린다', () => {
    const body = '불편하셨겠어요. 팀에 전달해서 확인할게요!';
    const result = applyHoldingPolicy({
      response: body,
      insight: { category: 'bug', summary: '쿠폰함 흰 화면', sentiment: 'negative' },
      escalate: true,
    });

    expect(result.response).toBe(body);
  });

  it('escalate 가 아닌 cs 는 건드리지 않는다 — 지식 안 정답이 여기다', () => {
    const body = '쿠폰은 같은 가게에서 하루 한 장이에요.';
    const result = applyHoldingPolicy({
      response: body,
      insight: { category: 'cs', summary: '쿠폰 수량 문의', sentiment: 'neutral' },
      escalate: false,
    });

    expect(result.response).toBe(body);
  });

  it('response 가 null 이면 null 로 둔다 — 호출부의 미저장 안내 경로를 빼앗지 않는다', () => {
    const result = applyHoldingPolicy({
      response: null,
      insight: { category: 'cs', summary: '문의', sentiment: 'neutral' },
      escalate: true,
    });

    expect(result.response).toBeNull();
  });

  it('insight 가 null 이면 카테고리를 알 수 없으므로 건드리지 않는다', () => {
    const result = applyHoldingPolicy({
      response: '안녕하세요!',
      insight: null,
      escalate: true,
    });

    expect(result.response).toBe('안녕하세요!');
  });
});

describe('isHoldingResponse', () => {
  it('대기 문구를 품고 있으면 참', () => {
    expect(isHoldingResponse(HOLDING_MESSAGE)).toBe(true);
    expect(isHoldingResponse(HOLDING_NOTICE)).toBe(true);
    expect(isHoldingResponse(`네! ${HOLDING_MESSAGE}`)).toBe(true);
  });

  it('다른 답변과 빈 값은 거짓', () => {
    expect(isHoldingResponse('쿠폰은 하루 한 장이에요')).toBe(false);
    expect(isHoldingResponse(null)).toBe(false);
    expect(isHoldingResponse(undefined)).toBe(false);
    expect(isHoldingResponse('')).toBe(false);
  });
});

// 유저 턴에 얹는 상기가 프롬프트와 다른 문장을 시키면, 모델은 둘 중 하나를 고르게 된다.
describe('GROUNDING_REMINDER', () => {
  it('프롬프트가 시키는 것과 같은 문장을 인용한다', () => {
    expect(GROUNDING_REMINDER).toContain(HOLDING_MESSAGE);
    expect(GROUNDING_REMINDER).toContain('escalate');
  });
});

describe('applyHoldingPolicy — 리뷰 반영', () => {
  it('카테고리는 정규화해서 본다 — "CS"·" cs " 도 치환된다 (saveInsight 의 normalizeCategory 와 같은 눈)', () => {
    for (const category of ['CS', ' cs ', 'Cs']) {
      const r = applyHoldingPolicy({ response: '하루 3장이요', insight: { category }, escalate: true });
      expect(r.response).toBe(HOLDING_MESSAGE);
    }
  });

  it('이미 대기 문구면 다시 치환하지 않는다 (경고 로그도 안 남긴다)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = applyHoldingPolicy({ response: HOLDING_MESSAGE, insight: { category: 'cs' }, escalate: true }, 'bot-1');
    expect(r.response).toBe(HOLDING_MESSAGE);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('치환할 때는 봇 id 와 원문 앞부분을 경고 로그로 남긴다 (과잉 발동을 셀 유일한 흔적)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyHoldingPolicy({ response: '쿠폰은 하루 3장까지예요', insight: { category: 'cs' }, escalate: true }, 'bot-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('bot=bot-1');
    expect(String(warn.mock.calls[0][0])).toContain('쿠폰은 하루 3장');
    warn.mockRestore();
  });
});

// ── I-20 — 물러난 질문은 «항상» 흔적을 남긴다 ─────────────────────────────
//
// I-05 뒤로 인사이트 생성이 모델 재량이 됐다. 같은 성격의 사실 질문 6건 중 2건만 `cs` 로
// 남고 「AI 가 못 답한 질문」(주차·인기)은 흔적이 0 이었다 — 운영자가 FAQ 로 보충할 재료다.

describe('ensureEscalationInsight', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    response: HOLDING_MESSAGE,
    insight: null as { category: string; summary: string; sentiment: string } | null,
    escalate: true,
    parsed: true,
    ...over,
  });

  it('물러났는데 인사이트가 없으면 방문자 말 그대로 cs 인사이트를 만든다', () => {
    const out = ensureEscalationInsight(base(), '주차 되나요?');
    expect(out.insight).toEqual({ category: 'cs', summary: '주차 되나요?', sentiment: 'neutral' });
  });

  it('모델이 이미 인사이트를 냈으면 덮지 않는다', () => {
    const kept = { category: 'bug', summary: '쿠폰함 흰 화면', sentiment: 'negative' };
    const out = ensureEscalationInsight(base({ insight: kept }), '주차 되나요?');
    expect(out.insight).toBe(kept);
  });

  it('물러나지 않은 턴은 건드리지 않는다 — 답한 잡담까지 문의로 남기지 않는다', () => {
    expect(ensureEscalationInsight(base({ escalate: false }), '안녕하세요').insight).toBeNull();
  });

  it('출력이 깨진 턴은 건드리지 않는다 — extractResult 가 이미 흔적을 남겼다', () => {
    expect(ensureEscalationInsight(base({ parsed: false }), '주차 되나요?').insight).toBeNull();
  });

  it('앞 제보의 보충이면 만들지 않는다 — 만들면 그 제보의 summary 를 덮는다', () => {
    const refMap = new Map([['a1b2c3d4', { id: 'i1' }]]);
    expect(ensureEscalationInsight(base({ extends: 'a1b2c3d4' }), 'PC 크롬이요', { refMap }).insight).toBeNull();
  });

  it('대소문자가 달라도 같은 ref 로 본다', () => {
    const refMap = new Map([['a1b2c3d4', { id: 'i1' }]]);
    expect(ensureEscalationInsight(base({ extends: 'A1B2C3D4' }), 'PC 크롬이요', { refMap }).insight).toBeNull();
  });

  // 모델이 지어낸 ref 는 어느 제보에도 «안 붙는다». 그 턴을 건너뛰면 흔적이 0 이 된다 —
  // I-20 이 닫으려던 구멍이 정확히 이 모양이다.
  it('목록에 없는 ref 면 만든다 — 그 턴은 아무 제보에도 안 붙는다', () => {
    const out = ensureEscalationInsight(base({ extends: '지어낸ref' }), '주차 되나요?', { refMap: new Map() });
    expect(out.insight?.category).toBe('cs');
  });

  it('refMap 을 안 주면 ref 가 있어도 만든다 — 해석할 근거가 없다', () => {
    expect(ensureEscalationInsight(base({ extends: 'a1b2c3d4' }), '주차 되나요?').insight?.category).toBe('cs');
  });

  it('칩만 누른 턴은 만들지 않는다 — 아직 아무 내용도 없다', () => {
    expect(ensureEscalationInsight(base(), '불편한 점이 있어요', { chipOnly: true }).insight).toBeNull();
  });

  it('빈 문장이면 만들지 않는다', () => {
    expect(ensureEscalationInsight(base(), '   \n  ').insight).toBeNull();
  });

  it('개행을 접고 상한까지만 남긴다 — 이 값은 나중에 프롬프트에 한 줄로 실린다', () => {
    const out = ensureEscalationInsight(base(), `줄1\n줄2   줄3${'가'.repeat(400)}`);
    expect(out.insight!.summary.length).toBe(ESCALATED_SUMMARY_CHARS);
    expect(out.insight!.summary).not.toContain('\n');
    expect(out.insight!.summary.startsWith('줄1 줄2 줄3')).toBe(true);
  });

  it('같은 결과 객체를 돌려준다 — 호출부가 그대로 이어 쓴다', () => {
    const r = base();
    expect(ensureEscalationInsight(r, '주차 되나요?')).toBe(r);
  });
});

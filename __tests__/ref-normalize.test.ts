// i18n 5d — 모델이 목록의 ref 를 대괄호째(`[8f7cb09f]`) 옮겨 적어도 같은 항목을 가리켜야 한다.
// 영어 프롬프트로 바꾼 뒤 실측 4/4 가 대괄호째 적어서 extends·Known issues 대조가 전부 빗나갔다.
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({}) }));
import { normalizeRef } from '@/lib/classify/ref';
import { planInsightWrite } from '@/lib/bot/db';
import { ensureEscalationInsight } from '@/lib/bot/holding';

describe('normalizeRef', () => {
  it.each([
    ['8f7cb09f', '8f7cb09f'],
    ['[8f7cb09f]', '8f7cb09f'],
    [' [8F7CB09F] ', '8f7cb09f'],
    ['"[8f7cb09f]"', '8f7cb09f'],
    ["'8f7cb09f'", '8f7cb09f'],
    ['`8f7cb09f`', '8f7cb09f'],
    ['[]', ''],
    ['', ''],
  ])('%j → %j', (input, want) => expect(normalizeRef(input)).toBe(want));

  it('문자열이 아니면 빈 문자열', () => {
    expect(normalizeRef(null)).toBe('');
    expect(normalizeRef(123)).toBe('');
  });

  it('가운데 글자는 건드리지 않는다 — 다른 ref 로 바뀌지 않는다', () => {
    expect(normalizeRef('[8f7c b09f]')).toBe('8f7c b09f');
  });
});

describe('대괄호째 적은 ref 도 같은 항목으로 대조한다', () => {
  const refMap = new Map([['ab12cd34', { id: 'i1' }]]);
  const insight = { category: 'bug', summary: '쿠폰함 흰 화면 (아이폰 사파리)', sentiment: 'negative' };

  it('planInsightWrite — 보충 제보가 새 행이 아니라 앞 제보 갱신으로 간다', () => {
    expect(planInsightWrite({ insight, extends: '[AB12CD34]', refMap })).toEqual({ action: 'update', id: 'i1' });
  });

  it('ensureEscalationInsight — 해석되는 ref 면 대체 인사이트를 만들지 않는다(앞 제보 summary 를 덮지 않는다)', () => {
    const out = ensureEscalationInsight(
      { response: null, insight: null, extends: '[ab12cd34]', escalate: true, parsed: true },
      '아이폰 사파리요',
      { refMap },
    );
    expect(out.insight).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_LIMITS, renderKnowledge, validateKnowledgeInput } from '@/lib/bot/knowledge';
import { getCsAnswerPrompt, getSystemPrompt, type ServiceProfile } from '@/lib/bot/prompts';
import { HOLDING_MESSAGE } from '@/lib/bot/holding';

// 이 값은 검색 없이 시스템 프롬프트에 통째로 실린다. 그래서 상한이 곧 호출 1건의
// 입력 토큰 최악값이고, 그게 일일 상한 계산의 근거다 — 조용히 잘라내면 안 된다.

describe('validateKnowledgeInput', () => {
  it('상한을 넘는 텍스트는 거절한다 (자르지 않는다). 에러 문구에 상한이 들어간다', () => {
    const result = validateKnowledgeInput({ knowledge_text: 'ㄱ'.repeat(KNOWLEDGE_LIMITS.text + 1) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('20,000');
  });

  it('상한과 정확히 같은 길이는 통과한다', () => {
    const text = 'ㄱ'.repeat(KNOWLEDGE_LIMITS.text);
    const result = validateKnowledgeInput({ knowledge_text: text });

    expect(result).toEqual({ ok: true, values: { knowledge_text: text } });
  });

  it('FAQ 가 상한 개수를 넘으면 거절한다', () => {
    const faq = Array.from({ length: KNOWLEDGE_LIMITS.faqItems + 1 }, (_, i) => ({
      q: `질문 ${i}`,
      a: `답변 ${i}`,
    }));

    const result = validateKnowledgeInput({ knowledge_faq: faq });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('50');
  });

  it('q 만 있고 a 가 빈 항목은 그 항목만 버리고 나머지는 통과시킨다', () => {
    const result = validateKnowledgeInput({
      knowledge_faq: [
        { q: '환불되나요?', a: '7일 안에 가능해요' },
        { q: '아직 안 채운 질문', a: '   ' },
        { q: '배송은요?', a: '2~3일 걸려요' },
      ],
    });

    expect(result).toEqual({
      ok: true,
      values: {
        knowledge_faq: [
          { q: '환불되나요?', a: '7일 안에 가능해요' },
          { q: '배송은요?', a: '2~3일 걸려요' },
        ],
      },
    });
  });

  it('빈 행은 상한 개수에 안 들어간다 — 화면이 만든 빈 행 때문에 저장이 막히면 안 된다', () => {
    const faq = [
      ...Array.from({ length: KNOWLEDGE_LIMITS.faqItems }, (_, i) => ({ q: `질문 ${i}`, a: `답변 ${i}` })),
      { q: '', a: '' },
    ];

    const result = validateKnowledgeInput({ knowledge_faq: faq });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.knowledge_faq).toHaveLength(KNOWLEDGE_LIMITS.faqItems);
  });

  it('문자열이 아닌 knowledge_text 는 거절한다 (숫자·객체)', () => {
    expect(validateKnowledgeInput({ knowledge_text: 42 }).ok).toBe(false);
    expect(validateKnowledgeInput({ knowledge_text: { a: 1 } }).ok).toBe(false);
    expect(validateKnowledgeInput({ knowledge_text: ['a'] }).ok).toBe(false);
  });

  it('배열이 아닌 knowledge_faq 와, 객체가 아닌 FAQ 항목은 거절한다', () => {
    expect(validateKnowledgeInput({ knowledge_faq: '질문답변' }).ok).toBe(false);
    expect(validateKnowledgeInput({ knowledge_faq: [['q', 'a']] }).ok).toBe(false);
    expect(validateKnowledgeInput({ knowledge_faq: [{ q: 1, a: 2 }] }).ok).toBe(false);
  });

  it('FAQ 질문·답변 각각의 길이 상한을 넘으면 거절한다', () => {
    const longQ = validateKnowledgeInput({
      knowledge_faq: [{ q: 'ㄱ'.repeat(KNOWLEDGE_LIMITS.faqQuestion + 1), a: '답' }],
    });
    expect(longQ.ok).toBe(false);
    if (!longQ.ok) expect(longQ.error).toContain('질문');

    const longA = validateKnowledgeInput({
      knowledge_faq: [{ q: '질문', a: 'ㄱ'.repeat(KNOWLEDGE_LIMITS.faqAnswer + 1) }],
    });
    expect(longA.ok).toBe(false);
    if (!longA.ok) expect(longA.error).toContain('답변');
  });

  it('빈 문자열과 공백만 있는 텍스트는 null 로 정규화한다', () => {
    expect(validateKnowledgeInput({ knowledge_text: '' })).toEqual({
      ok: true,
      values: { knowledge_text: null },
    });
    expect(validateKnowledgeInput({ knowledge_text: '   \n  ' })).toEqual({
      ok: true,
      values: { knowledge_text: null },
    });
    expect(validateKnowledgeInput({ knowledge_text: null })).toEqual({
      ok: true,
      values: { knowledge_text: null },
    });
  });

  it('알 수 없는 필드는 조용히 버리고, 남는 게 없으면 거절한다', () => {
    const result = validateKnowledgeInput({ knowledge_text: '본문', llm_api_key_encrypted: '탈취시도' });
    expect(result).toEqual({ ok: true, values: { knowledge_text: '본문' } });

    expect(validateKnowledgeInput({ nope: 1 }).ok).toBe(false);
    expect(validateKnowledgeInput(null).ok).toBe(false);
    expect(validateKnowledgeInput([]).ok).toBe(false);
  });
});

describe('renderKnowledge', () => {
  it('둘 다 비면 빈 문자열 — 섹션 자체가 안 생긴다', () => {
    expect(renderKnowledge('', [])).toBe('');
    expect(renderKnowledge(null, null)).toBe('');
    expect(renderKnowledge('   ', [{ q: '', a: '' }])).toBe('');
  });

  it('FAQ 만 있고 텍스트가 없어도 정상 직렬화한다', () => {
    const rendered = renderKnowledge(null, [{ q: '환불되나요?', a: '7일 안에 가능해요' }]);

    expect(rendered).toContain('### FAQ');
    expect(rendered).toContain('Q: 환불되나요?');
    expect(rendered).toContain('A: 7일 안에 가능해요');
  });

  it('텍스트만 있으면 FAQ 머리말 없이 본문만 낸다', () => {
    expect(renderKnowledge('배송은 2~3일 걸립니다.', [])).toBe('배송은 2~3일 걸립니다.');
  });

  it('텍스트와 FAQ 가 둘 다 있으면 한 문자열로 합친다', () => {
    const rendered = renderKnowledge('배송은 2~3일.', [{ q: '환불?', a: '7일 안에' }]);

    expect(rendered).toContain('배송은 2~3일.');
    expect(rendered).toContain('Q: 환불?');
  });
});

// 규칙은 «어느 쪽이든 반드시» 있다. 지식이 있으면 「## 답변 지식」+ 규칙, 없으면
// 「## 답변 규칙 (지식 없음)」. 예전에는 지식이 비면 규칙이 통째로 빠졌고, 그래서
// 지식 0 인 새 봇이 없는 숫자를 지어냈다(셀프 QA I-08). 반대로 규칙을 지식 있는 봇의
// 것으로 그대로 켜면 「모든 질문에 팀 확인」 회귀가 난다 — 그래서 사실과 피드백을
// 가르는 문장이 들어 있는지까지 프롬프트 조립으로 단언한다.
/** 프롬프트에서 `## 제목` 섹션 본문만 잘라낸다 — 다음 `## ` 앞까지. */
function sectionOf(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start < 0) return '';
  const rest = prompt.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('getSystemPrompt — 지식 유무에 따라 다른 답변 규칙이 들어간다', () => {
  const baseProfile: ServiceProfile = {
    botName: '널널투어',
    botTone: '친근하게',
    serviceName: '널널투어',
    serviceUrl: 'https://example.com',
    serviceDescription: '느긋한 여행 추천',
    serviceCompany: '',
    targetUsers: '베타 테스터',
    serviceFeatures: [],
    loginMethod: '',
    faq: [],
    knowledge: '',
  };

  it('지식이 비면 「지식 없음」 규칙이 대신 들어간다 — hold 지시와 서비스 이름을 담고, 지식 섹션은 없다', () => {
    const prompt = getSystemPrompt(baseProfile);

    expect(prompt).toContain('## Answer rules (no knowledge)');

    // 섹션 «안»만 본다. 서비스 이름도 「피드백」도 프롬프트 다른 곳에 이미 있어서,
    // 전체 문자열로 재면 이 섹션이 통째로 비어 있어도 초록이 된다.
    const section = sectionOf(prompt, '## Answer rules (no knowledge)');
    // 대기 문장은 모델이 쓰지 않는다 — 플래그를 켜라고 시키고, 문장은 서버가 방문자 언어로 넣는다(holding.ts)
    expect(section).toContain('"hold" to true');
    expect(section).not.toContain(HOLDING_MESSAGE);
    // 「너는 널널투어 의 정책·수량…을 모른다」 — 서비스 이름이 그 문장 «안에» 들어간다.
    // 자리표시자를 썼다면 단일 패스 fillTemplate 때문에 리터럴로 남는다.
    expect(section).toContain('널널투어');
    expect(section).not.toContain('{{service_name}}');
    // 피드백까지 대기 문구로 넘기면 「모든 질문에 팀 확인」 회귀다 — 가르는 문장이 있어야 한다
    expect(section).toContain('Feedback');

    expect(prompt).not.toContain('## Answer knowledge');
    expect(prompt).not.toContain('{{knowledge}}');
  });

  it('지식이 있으면 본문과 규칙 3줄이 함께 들어간다 — 근거가 없으면 hold 를 켜라고 시킨다', () => {
    const prompt = getSystemPrompt({
      ...baseProfile,
      knowledge: renderKnowledge('쿠폰은 결제 화면에서 적용됩니다.', [{ q: '환불?', a: '7일 안에' }]),
    });

    expect(prompt).toContain('## Answer knowledge');
    expect(prompt).toContain('쿠폰은 결제 화면에서 적용됩니다.');
    expect(prompt).toContain('Q: 환불?');
    expect(prompt).toContain('never make it up');
    expect(prompt).toContain('escalate');
    expect(sectionOf(prompt, '## Answer rules (knowledge)')).toContain('"hold" to true');
    // 두 규칙이 동시에 들어가면 모델이 상반된 지시를 받는다
    expect(prompt).not.toContain('(no knowledge)');
  });
});

// 지식은 운영자 자유 입력 20,000자다. 자리표시자처럼 생긴 문자열이 우연히든
// 의도적이든 들어올 수 있는 유일한 자리라, 넣은 값이 다시 치환되면 안 된다.
describe('applyServiceProfile — 넣은 값은 다시 치환되지 않는다', () => {
  const profile: ServiceProfile = {
    botName: '널널봇',
    botTone: '친근하게',
    serviceName: '널널투어',
    serviceUrl: 'https://example.com',
    serviceDescription: '느긋한 여행 추천',
    serviceCompany: '',
    targetUsers: '베타 테스터',
    serviceFeatures: [],
    loginMethod: '',
    faq: [],
    knowledge: '',
  };

  it('지식 안의 {{service_name}} 리터럴은 그대로 남는다', () => {
    const prompt = getSystemPrompt({
      ...profile,
      knowledge: renderKnowledge('문의 양식에 {{service_name}} 이라고 적어 보내주세요.', []),
    });

    expect(prompt).toContain('{{service_name}}');
    expect(prompt).not.toContain('널널투어 이라고 적어 보내주세요');
  });

  it('FAQ 안의 자리표시자도 그대로 남는다', () => {
    const prompt = getSystemPrompt({
      ...profile,
      knowledge: renderKnowledge(null, [{ q: '{{bot_name}} 이 뭔가요?', a: '{{login_method}} 참고' }]),
    });

    expect(prompt).toContain('{{bot_name}} 이 뭔가요?');
    expect(prompt).toContain('{{login_method}} 참고');
  });

  it('서비스 설명 안의 자리표시자도 그대로 남는다 (같은 결함, 다른 필드)', () => {
    const prompt = getSystemPrompt({ ...profile, serviceDescription: '{{service_url}} 을 참고' });

    expect(prompt).toContain('{{service_url}} 을 참고');
  });

  it('진짜 자리표시자는 여전히 치환된다 (회귀)', () => {
    const prompt = getSystemPrompt(profile);

    expect(prompt).toContain('널널투어');
    expect(prompt).toContain('널널봇');
    expect(prompt).not.toContain('{{service_name}}');
    expect(prompt).not.toContain('{{knowledge}}');
  });

  // 예전 코드는 applyServiceProfile 로 프로필 값을 넣은 «뒤에» {{message}} 를 따로
  // replace 해서, 프로필 안에 적힌 {{message}} 가 유저 입력으로 바뀌었다. CS 프롬프트가
  // FAQ 를 더 이상 싣지 않으므로(아래 describe) 이제 그 경로는 서비스 이름이다 —
  // 운영자 자유 입력 60자라 자리표시자 문자열이 들어올 수 있는 건 똑같다.
  it('getCsAnswerPrompt — 프로필에 적힌 {{message}} 가 유저 입력으로 바뀌지 않는다', () => {
    const prompt = getCsAnswerPrompt({ ...profile, serviceName: '{{message}} 투어' }, '환불 되나요?');

    // 템플릿의 진짜 {{message}} 자리에는 들어가고
    expect(prompt).toContain('환불 되나요?');
    // 프로필 안에 적힌 {{message}} 는 리터럴로 남는다
    expect(prompt).toContain('{{message}} 투어');
  });
});

// handler.ts 의 질문 분기는 callLlm(config, systemPrompt, csPrompt) 로 «두 문자열을 함께»
// 보낸다. 그래서 중복은 프롬프트 하나만 봐서는 안 보이고, 합쳐야 보인다.
describe('CS 답변 프롬프트는 시스템이 이미 실은 것을 다시 싣지 않는다', () => {
  const faq = [{ q: '쿠폰은 언제까지 쓸 수 있나요?', a: '발급일로부터 30일 안에 쓰셔야 합니다' }];
  const profile: ServiceProfile = {
    botName: '널널봇',
    botTone: '친근하게',
    serviceName: '널널투어',
    serviceUrl: 'https://example.com',
    serviceDescription: '느긋한 여행 추천',
    serviceCompany: '',
    targetUsers: '베타 테스터',
    serviceFeatures: [],
    loginMethod: '',
    faq,
    knowledge: renderKnowledge(null, faq),
  };

  it('FAQ 답변은 한 호출에 한 번만 등장한다 (예전엔 두 벌이었다)', () => {
    const system = getSystemPrompt(profile);
    const cs = getCsAnswerPrompt(profile, '쿠폰 유효기간이 어떻게 되나요?');

    expect(system).toContain('발급일로부터 30일');
    expect(cs).not.toContain('발급일로부터 30일');

    const combined = `${system}\n${cs}`;
    expect(combined.split('발급일로부터 30일').length - 1).toBe(1);
  });

  it('서비스 정보도 시스템에만 있다 — CS 프롬프트에 제 섹션을 만들지 않는다', () => {
    const cs = getCsAnswerPrompt(profile, '환불 되나요?');

    expect(cs).not.toContain('## FAQ');
    expect(cs).not.toContain('## Service context');
    expect(getSystemPrompt(profile)).toContain('## Service context');
  });

  // 지식이 0 인 봇의 기존 동작을 깨지 않는 것이 이 변경의 조건이다. CS 프롬프트가
  // 근거 범위를 스스로 좁히면(예: "답변 지식에 있는 것만") 지식을 아직 안 넣은 봇이
  // 모든 질문에 답을 못 하게 된다 — buildKnowledgeSection 이 조건부인 것과 같은 이유다.
  it('지식이 0 이어도 질문 프롬프트는 그대로 만들어지고 근거를 지식으로 못박지 않는다', () => {
    const cs = getCsAnswerPrompt({ ...profile, faq: [], knowledge: '' }, '환불 되나요?');

    expect(cs).toContain('환불 되나요?');
    expect(cs).toContain('널널투어');
    expect(cs).not.toContain('Answer only from');
    // 근거에 없으면 문장 대신 플래그 — 대기 문장은 서버가 방문자 언어로 넣는다(holding.ts)
    expect(cs).toContain('"hold": true');
    expect(cs).not.toContain(HOLDING_MESSAGE);
    // 치환되지 않고 남은 자리표시자가 없다
    expect(cs).not.toContain('{{');
  });
});

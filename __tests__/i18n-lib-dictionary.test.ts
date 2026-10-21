import { describe, expect, it } from 'vitest';
import { checkKeyFormat } from '@/lib/llm/key-format';
import { CHECK_LABELS } from '@/lib/paypal/action-view';
import type { LlmProvider } from '@/lib/llm/models';
import { loadMessages } from './helpers/intl';

// 서버·프롬프트·이메일이 쓰는 문구(lib)와 화면 사전이 같은 말을 두 곳에 갖고 있는 자리.
// 화면은 사전만 쓰고, lib 쪽은 서버에서 아직 필요해서 남겨 뒀다 — 둘이 갈라지지 않는지 여기서 본다.
type Dict = { common: { validation: { key: { format: Record<string, string> } } }; inbox: { payment: { checks: Record<string, string> } } };
const en = loadMessages('en') as unknown as Dict;
const ko = loadMessages('ko') as unknown as Dict;

describe('lib ↔ 사전 문구', () => {
  it.each(['gemini', 'anthropic', 'openai'] as LlmProvider[])('API 키 형식 오류(%s) — 서버 응답 한국어가 ko 사전과 같다', (provider) => {
    const r = checkKeyFormat(provider, 'bad key');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ko.common.validation.key.format[provider]);
  });

  it('승인 메일의 검사 라벨(CHECK_LABELS)이 en 사전 inbox.payment.checks 와 같다', () => {
    expect(CHECK_LABELS).toEqual(en.inbox.payment.checks);
  });
});

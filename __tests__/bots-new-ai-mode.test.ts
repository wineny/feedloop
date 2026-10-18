// `/bots/new` 의 「AI 답변」 분기 — 화면 없이 규칙만 시험한다.
//
// 이 스키마가 정하는 것은 «언제 키 칸을 보는가»다. 잘못 접으면 두 방향으로 아프다.
//  - 무료를 골랐는데 키 칸을 보면: 키를 쓰다 마음 바꾼 사람이 등록을 못 한다
//  - 내 키를 골랐는데 안 보면: 키 없이 봇이 만들어지고 위젯은 플랫폼 무료분으로 답한다
//    (운영자는 자기 키로 도는 줄 안다)

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEY_PROVIDER,
  llmKeyPayload,
  newBotFormSchema,
  registrationPayload,
  type NewBotFormValues,
} from '@/lib/bot/new-bot-form';
import { CUSTOM_MODEL } from '@/lib/llm/model-choice';

/** 형식만 맞는 가짜 키. 실제로 통하는지는 서버 라우트의 provider 실호출이 본다. */
const ANTHROPIC_KEY = 'sk-ant-abcdefgh1234567890';
const GEMINI_KEY = 'AIzaabcdefgh1234567890';

function base(over: Record<string, unknown> = {}) {
  return {
    service_name: '널널투어',
    service_description: '',
    service_url: '',
    github_repo_url: '',
    github_token: '',
    pr_mode: 'approve',
    ai_mode: 'free',
    llm_provider: DEFAULT_KEY_PROVIDER,
    llm_model_choice: '',
    llm_model_custom: '',
    llm_api_key: '',
    ...over,
  };
}

/** 실패한 이슈의 path 첫 조각들 */
function issuePaths(input: Record<string, unknown>): string[] {
  const parsed = newBotFormSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => String(i.path[0]));
}

describe('newBotFormSchema — ai_mode 기본값', () => {
  it('ai_mode 를 안 보내면 free 로 접힌다', () => {
    const input = base();
    delete (input as Record<string, unknown>).ai_mode;
    const parsed = newBotFormSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ai_mode).toBe('free');
  });

  it('free·own 밖의 값은 거절한다', () => {
    expect(issuePaths(base({ ai_mode: 'byok' }))).toContain('ai_mode');
  });
});

describe('newBotFormSchema — free 는 키 칸을 보지 않는다', () => {
  it('키가 비어 있어도 통과한다', () => {
    expect(newBotFormSchema.safeParse(base()).success).toBe(true);
  });

  it('쓰다 만 키가 남아 있어도 통과한다 — 마음을 바꾼 사람이 막히면 안 된다', () => {
    expect(
      newBotFormSchema.safeParse(base({ llm_api_key: 'sk-ant-지우다만값' })).success,
    ).toBe(true);
  });

  it('잘못된 직접 입력 모델이 남아 있어도 통과한다', () => {
    expect(
      newBotFormSchema.safeParse(
        base({ llm_model_choice: CUSTOM_MODEL, llm_model_custom: 'gemini flash/../x' }),
      ).success,
    ).toBe(true);
  });
});

describe('newBotFormSchema — own 은 키를 요구한다', () => {
  it('키가 비면 llm_api_key 에서 막힌다', () => {
    expect(issuePaths(base({ ai_mode: 'own' }))).toContain('llm_api_key');
  });

  it('형식이 맞는 키면 통과한다', () => {
    expect(
      newBotFormSchema.safeParse(base({ ai_mode: 'own', llm_api_key: ANTHROPIC_KEY })).success,
    ).toBe(true);
  });

  it('provider 와 접두사가 어긋나면 막는다', () => {
    // anthropic 을 골라두고 gemini 키를 붙여넣은 경우
    expect(
      issuePaths(base({ ai_mode: 'own', llm_provider: 'anthropic', llm_api_key: GEMINI_KEY })),
    ).toContain('llm_api_key');
  });

  it('앞뒤 공백이 섞인 붙여넣기를 잡는다', () => {
    expect(
      issuePaths(base({ ai_mode: 'own', llm_api_key: ` ${ANTHROPIC_KEY} ` })),
    ).toContain('llm_api_key');
  });

  it('목록 밖 provider 는 받지 않는다', () => {
    expect(
      issuePaths(base({ ai_mode: 'own', llm_provider: 'groq', llm_api_key: ANTHROPIC_KEY })),
    ).toContain('llm_provider');
  });
});

describe('newBotFormSchema — own 의 모델 검증', () => {
  it('목록에서 고른 모델은 통과한다', () => {
    expect(
      newBotFormSchema.safeParse(
        base({
          ai_mode: 'own',
          llm_api_key: ANTHROPIC_KEY,
          llm_model_choice: 'claude-haiku-4-5-20251001',
        }),
      ).success,
    ).toBe(true);
  });

  it('「자동」(빈 값)은 통과한다 — 추천 기본값을 탄다', () => {
    expect(
      newBotFormSchema.safeParse(base({ ai_mode: 'own', llm_api_key: ANTHROPIC_KEY })).success,
    ).toBe(true);
  });

  it('「직접 입력」 칸이 비면 통과한다 — 안 고른 것과 같게 접힌다', () => {
    expect(
      newBotFormSchema.safeParse(
        base({
          ai_mode: 'own',
          llm_api_key: ANTHROPIC_KEY,
          llm_model_choice: CUSTOM_MODEL,
          llm_model_custom: '   ',
        }),
      ).success,
    ).toBe(true);
  });

  it('허용 문자 밖의 직접 입력 모델은 거절한다', () => {
    // 이 값은 SDK 를 거쳐 provider API 의 URL 경로에 들어간다
    expect(
      issuePaths(
        base({
          ai_mode: 'own',
          llm_api_key: ANTHROPIC_KEY,
          llm_model_choice: CUSTOM_MODEL,
          llm_model_custom: '../../secret?x=1',
        }),
      ),
    ).toContain('llm_model_custom');
  });

  it('80자를 넘는 모델 이름은 거절한다', () => {
    expect(
      issuePaths(
        base({
          ai_mode: 'own',
          llm_api_key: ANTHROPIC_KEY,
          llm_model_choice: CUSTOM_MODEL,
          llm_model_custom: 'a'.repeat(81),
        }),
      ),
    ).toContain('llm_model_custom');
  });
});

describe('newBotFormSchema — 기본 정보는 ai_mode 와 무관하게 본다', () => {
  it('서비스 이름이 1글자면 막는다', () => {
    expect(issuePaths(base({ service_name: '널' }))).toContain('service_name');
  });

  it('URL 형식이 아니면 막는다', () => {
    expect(issuePaths(base({ service_url: 'example.com' }))).toContain('service_url');
  });
});

describe('요청 본문 조립', () => {
  const values = newBotFormSchema.parse(
    base({
      ai_mode: 'own',
      llm_api_key: ANTHROPIC_KEY,
      llm_model_choice: CUSTOM_MODEL,
      llm_model_custom: '  claude-haiku-4-5-20251001  ',
      github_repo_url: 'https://github.com/wineny/nullnul-tour',
    }),
  ) as NewBotFormValues;

  it('등록 요청에는 키가 들어가지 않는다', () => {
    const payload = registrationPayload(values) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'github_repo_url',
      'pr_mode',
      'service_description',
      'service_name',
      'service_url',
    ]);
    expect(JSON.stringify(payload)).not.toContain(ANTHROPIC_KEY);
  });

  it('키 요청은 LlmKeyForm 과 같은 모양이고 직접 입력 모델을 다듬어 싣는다', () => {
    expect(llmKeyPayload(values)).toEqual({
      provider: 'anthropic',
      key: ANTHROPIC_KEY,
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('모델을 안 고르면 model 은 null 이다 — "지웠다"가 아니라 "안 골랐다"', () => {
    const auto = newBotFormSchema.parse(
      base({ ai_mode: 'own', llm_api_key: GEMINI_KEY, llm_provider: 'gemini' }),
    ) as NewBotFormValues;
    expect(llmKeyPayload(auto).model).toBeNull();
  });
});

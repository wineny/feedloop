// 새 서비스 등록 폼의 스키마 — 화면(`/bots/new`)에서 떼어 뒀다.
//
// 떼어 둔 이유는 둘이다.
//  1) 규칙을 React 없이 시험할 수 있게(`__tests__/bots-new-ai-mode.test.ts`)
//  2) 「무료로 시작」과 「내 API 키로 시작」의 분기가 화면 안에 흩어지지 않게
//
// ⚠️ 이건 **클라이언트 1차 필터**다. 서버는 다시 본다 —
// 등록값은 `lib/bot/registration.ts`, 키·모델은 `api/bots/[id]/llm-key` 가 판정한다.
// 여기서 통과한 키가 «실제로 통하는» 키인지는 저 라우트의 provider 실호출만 안다.

import * as z from 'zod';
import { isLlmProvider, validateModelId, type LlmProvider } from '@/lib/llm/models';
import { checkGithubTokenFormat } from '@/lib/github/token-format';
import { checkKeyFormat } from '@/lib/llm/key-format';
import { draftModelValue } from '@/lib/llm/model-choice';

/** 등록 시점의 AI 답변 설정. `free` = 플랫폼 키(무료분), `own` = 운영자 키(BYOK). */
export const AI_MODES = ['free', 'own'] as const;
export type AiMode = (typeof AI_MODES)[number];

/**
 * 「내 API 키로 시작」을 처음 눌렀을 때 잡혀 있는 provider.
 * 플랫폼 무료분이 Anthropic 모델로 도니, 같은 곳이 먼저 보이는 편이 덜 놀랍다.
 */
export const DEFAULT_KEY_PROVIDER: LlmProvider = 'anthropic';

export const newBotFormSchema = z
  .object({
    service_name: z.string().min(2, {
      message: '서비스 이름은 2글자 이상이어야 합니다.',
    }),
    service_description: z.string().optional(),
    service_url: z
      .string()
      .url({ message: '유효한 URL을 입력해주세요.' })
      .optional()
      .or(z.literal('')),
    github_repo_url: z
      .string()
      .url({ message: '유효한 GitHub URL을 입력해주세요.' })
      .optional()
      .or(z.literal('')),
    pr_mode: z.enum(['approve', 'auto']),
    /** 봇 GitHub 토큰(B5, 선택). 등록 요청엔 싣지 않고 봇이 생긴 뒤 별도 PATCH 로 보낸다 */
    github_token: z.string(),

    // ── AI 답변
    ai_mode: z.enum(AI_MODES).default('free'),
    // 목록 밖 provider 는 받지 않는다. z.enum 대신 판별 함수를 쓰는 이유는
    // 목록(LLM_PROVIDERS)이 한 곳에만 있게 하려는 것이다.
    llm_provider: z.custom<LlmProvider>(isLlmProvider, {
      message: 'AI 제공사를 골라주세요',
    }),
    /** <select> 의 값. 빈 문자열 = 「자동」, `CUSTOM_MODEL` = 「직접 입력…」 */
    llm_model_choice: z.string(),
    /** 「직접 입력…」일 때만 쓰이는 칸 */
    llm_model_custom: z.string(),
    llm_api_key: z.string(),
  })
  .superRefine((values, ctx) => {
    // GitHub 토큰은 비워도 된다(공용 계정 폴백). 채웠으면 형식만 본다 — 접근·권한은 서버가 GitHub 에 묻는다
    if (values.github_token.trim() !== '') {
      const tokenCheck = checkGithubTokenFormat(values.github_token);
      if (!tokenCheck.ok) {
        ctx.addIssue({ code: 'custom', path: ['github_token'], message: tokenCheck.error });
      }
    }

    // 「무료로 시작」이면 키 칸은 **보지 않는다**. 키를 쓰다 마음을 바꿔 무료를 골랐을 때
    // 지우다 만 값 때문에 등록이 막히면 안 된다.
    if (values.ai_mode !== 'own') return;

    const keyCheck = checkKeyFormat(values.llm_provider, values.llm_api_key);
    if (!keyCheck.ok) {
      ctx.addIssue({ code: 'custom', path: ['llm_api_key'], message: keyCheck.error });
    }

    const modelCheck = validateModelId(
      draftModelValue(values.llm_model_choice, values.llm_model_custom),
    );
    if (!modelCheck.ok) {
      // 「직접 입력…」 칸이 잘못된 경우다 — 목록에서 고른 값은 이 검사를 통과한다.
      ctx.addIssue({ code: 'custom', path: ['llm_model_custom'], message: modelCheck.error });
    }
  });

export type NewBotFormValues = z.infer<typeof newBotFormSchema>;

/** `POST /api/bots` 에 실을 것만 고른다. **키는 이 요청에 절대 싣지 않는다.** */
export function registrationPayload(values: NewBotFormValues) {
  return {
    service_name: values.service_name,
    service_description: values.service_description,
    service_url: values.service_url,
    github_repo_url: values.github_repo_url,
    pr_mode: values.pr_mode,
  };
}

/** `PATCH /api/bots/[id]/llm-key` 본문. LlmKeyForm 이 보내는 모양과 같아야 한다. */
export function llmKeyPayload(values: NewBotFormValues) {
  return {
    provider: values.llm_provider,
    key: values.llm_api_key,
    model: draftModelValue(values.llm_model_choice, values.llm_model_custom),
  };
}

/** `PATCH /api/bots/[id]/github-token` 본문. 비어 있으면 null — 보내지 않는다 */
export function githubTokenPayload(values: NewBotFormValues): { token: string } | null {
  const token = values.github_token.trim();
  return token ? { token } : null;
}

// 봇이 쓸 LLM 모델을 만든다 — provider·모델·키가 전부 "누가 정했나"에 따라 갈린다.
//
//   운영자 키가 있으면 → bots.llm_provider + bots.llm_model + 복호화한 운영자 키
//   키가 없으면        → PLATFORM_LLM_PROVIDER + PLATFORM_LLM_MODEL + 그 provider 의 플랫폼 키
//
// **DB 를 읽지 않는다.** 재료는 이미 BotConfig 에 실려 있다(core.ts 의 select).
// 위젯 POST 는 메시지마다 이 경로를 타므로 여기서 왕복을 늘리면 그대로 지연이 된다.
// 그래서 이 파일은 `@/lib/supabase` 를 import 하지 않는다 — 늘리지 말 것.

import type { LanguageModel } from 'ai';
import { decrypt } from '@/lib/utils/crypto';
import { RECOMMENDED, isLlmProvider, type LlmProvider } from './models';

/**
 * `resolveModel` 이 보는 것. `BotConfig`(lib/bot/handler.ts)의 부분집합이고,
 * core.ts 가 같은 select 에서 채운다.
 */
export interface LlmBotConfig {
  botId: string;
  llmApiKeyEncrypted?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
}

/**
 * 설정이 잘못돼 모델을 만들 수조차 없는 경우. 호출부는 이걸 LLM 호출 실패와 같게 다루되,
 * **플랫폼 폴백 쪽 실패는 `bots` 에 쓰지 않는다** — 운영자 잘못이 아니다(§B-6).
 * `usingOwnKey` 로 어느 쪽인지 구분한다.
 */
export class LlmConfigError extends Error {
  readonly usingOwnKey: boolean;
  constructor(message: string, usingOwnKey: boolean) {
    super(message);
    this.name = 'LlmConfigError';
    this.usingOwnKey = usingOwnKey;
  }
}

export interface ResolvedModel {
  model: LanguageModel;
  usingOwnKey: boolean;
  provider: LlmProvider;
  modelId: string;
}

/**
 * 플랫폼 폴백이 쓰는 키의 env 이름. **앞의 것이 있으면 앞의 것**을 쓴다.
 *
 * anthropic 만 두 개인 이유(2026-09-13 보안 리뷰 MEDIUM-2): `ANTHROPIC_API_KEY` 는 자동 PR 엔진
 * (`auto-dev/ai-engine.ts`)과 스펙 초안이 쓰는 키다. 무인증 위젯 트래픽이 같은 키를 태우면 위젯이
 * 유발한 429 가 심사 시연의 [PR 만들기]까지 같이 죽인다. 그래서 폴백은 전용 키
 * `PLATFORM_ANTHROPIC_API_KEY` 를 먼저 찾고, 없을 때만 공용 키로 내려간다(발급 전 과도기).
 * 어느 쪽을 쓰는지는 `/api/health` 의 `runtime.platform_anthropic_key_dedicated` 로 본다.
 */
const PLATFORM_KEY_ENV: Record<LlmProvider, readonly string[]> = {
  gemini: ['GOOGLE_API_KEY'],
  anthropic: ['PLATFORM_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

/** 폴백 anthropic 키가 자동 PR 엔진과 «분리»돼 있는가(health 용). */
export function platformAnthropicKeyDedicated(): boolean {
  return Boolean(process.env.PLATFORM_ANTHROPIC_API_KEY?.trim());
}

export async function resolveModel(config: LlmBotConfig): Promise<ResolvedModel> {
  const encrypted = config.llmApiKeyEncrypted;

  if (encrypted) {
    // ── 운영자 키
    if (!isLlmProvider(config.llmProvider)) {
      // 키 저장 라우트가 provider 를 늘 함께 쓴다. 여기 오면 데이터가 깨진 것이다 —
      // 조용히 gemini 로 넘기면 gemini 가 아닌 키로 호출해 첫 답변에서 죽는다.
      throw new LlmConfigError(`bot ${config.botId}: llm_provider is missing or unknown`, true);
    }
    const provider = config.llmProvider;

    // CryptoKeyError(키 설정 자체가 깨짐)는 삼키지 않는다 — 설정 버그가 조용히 묻히면 안 된다.
    const apiKey = decrypt(encrypted);
    if (!apiKey) {
      throw new LlmConfigError(`bot ${config.botId}: stored LLM key could not be decrypted`, true);
    }

    const modelId = config.llmModel?.trim() || RECOMMENDED[provider];
    return { model: await createModel(provider, apiKey, modelId), usingOwnKey: true, provider, modelId };
  }

  // ── 플랫폼 폴백
  const rawProvider = process.env.PLATFORM_LLM_PROVIDER?.trim();
  if (rawProvider && !isLlmProvider(rawProvider)) {
    // env 오타를 조용히 gemini 로 접지 않는다. 설정 실수는 드러나야 고쳐진다.
    throw new LlmConfigError('PLATFORM_LLM_PROVIDER is set to an unknown provider', false);
  }
  const provider: LlmProvider = rawProvider ? (rawProvider as LlmProvider) : 'gemini';

  const apiKey = PLATFORM_KEY_ENV[provider].map((name) => process.env[name]?.trim()).find(Boolean);
  if (!apiKey) {
    // 다른 provider 로 넘어가지 않는다 — 넘어가면 우리가 의도하지 않은 단가로 돈이 나간다.
    throw new LlmConfigError(`platform key ${PLATFORM_KEY_ENV[provider].join(' / ')} is not set`, false);
  }

  const modelId = process.env.PLATFORM_LLM_MODEL?.trim() || RECOMMENDED[provider];
  return { model: await createModel(provider, apiKey, modelId), usingOwnKey: false, provider, modelId };
}

/**
 * provider 별 **dynamic import**. 정적으로 셋을 다 끌어오면 안 쓰는 두 개까지
 * 콜드스타트에 실리고, 카카오 웹훅은 4초 예산으로 돈다(REPLY_TIMEOUT_MS).
 *
 * 인스턴스를 캐시하지 않는다 — 키·모델이 바뀌면 즉시 반영돼야 하고 생성 비용은 무시할 만하다.
 */
async function createModel(
  provider: LlmProvider,
  apiKey: string,
  modelId: string,
): Promise<LanguageModel> {
  switch (provider) {
    case 'gemini': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(modelId);
    }
  }
}

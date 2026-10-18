import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateModelId, RECOMMENDED, MODELS, MODEL_ID_MAX, isLlmProvider } from '@/lib/llm/models';

// SDK 팩토리는 목으로 잡는다 — 실제 호출은 없다. 어느 팩토리가 어떤 인자로 불렸는지만 본다.
const googleFactory = vi.fn((opts: { apiKey: string }) =>
  vi.fn((id: string) => ({ sdk: 'google', id, apiKey: opts.apiKey })),
);
const anthropicFactory = vi.fn((opts: { apiKey: string }) =>
  vi.fn((id: string) => ({ sdk: 'anthropic', id, apiKey: opts.apiKey })),
);
const openaiFactory = vi.fn((opts: { apiKey: string }) =>
  vi.fn((id: string) => ({ sdk: 'openai', id, apiKey: opts.apiKey })),
);

vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: googleFactory }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: anthropicFactory }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: openaiFactory }));

// resolveModel 은 DB 를 읽으면 안 된다. 읽으면 이 목이 호출되고 아래 단언이 깨진다.
const getServiceRoleClient = vi.fn(() => {
  throw new Error('resolveModel must not touch the database');
});
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient }));

// 복호화는 crypto 의 책임이라 여기선 목으로 둔다(왕복 자체는 llm-key.test.ts 가 본다).
const DECRYPTED = 'AIzaNOTAREALKEY0000000000000000000000000';
vi.mock('@/lib/utils/crypto', () => ({
  decrypt: vi.fn((s: string) => (s === 'enc:good' ? DECRYPTED : '')),
}));

import { resolveModel, LlmConfigError } from '@/lib/llm/provider';

const ENV_KEYS = [
  'PLATFORM_LLM_PROVIDER',
  'PLATFORM_LLM_MODEL',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'PLATFORM_ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  // 셸 환경이 들고 있을 수 있는 값을 전부 지우고 시작한다 — 테스트가 환경에 안 흔들리게.
  for (const k of ENV_KEYS) vi.stubEnv(k, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveModel — 운영자 키가 있을 때', () => {
  it('provider 별로 올바른 SDK 팩토리를 부른다', async () => {
    const g = await resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: 'gemini' });
    expect(googleFactory).toHaveBeenCalledWith({ apiKey: DECRYPTED });
    expect(g.usingOwnKey).toBe(true);
    expect(g.provider).toBe('gemini');

    await resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: 'anthropic' });
    expect(anthropicFactory).toHaveBeenCalledWith({ apiKey: DECRYPTED });

    await resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: 'openai' });
    expect(openaiFactory).toHaveBeenCalledWith({ apiKey: DECRYPTED });

    expect(googleFactory).toHaveBeenCalledTimes(1);
  });

  it('DB 를 읽지 않는다', async () => {
    await resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: 'gemini' });
    expect(getServiceRoleClient).not.toHaveBeenCalled();
  });

  it('llm_model 이 있으면 그 값이 modelId 로 간다', async () => {
    const r = await resolveModel({
      botId: 'b1',
      llmApiKeyEncrypted: 'enc:good',
      llmProvider: 'anthropic',
      llmModel: 'claude-sonnet-5',
    });
    expect(r.modelId).toBe('claude-sonnet-5');
    expect(r.model).toMatchObject({ sdk: 'anthropic', id: 'claude-sonnet-5' });
  });

  it('llm_model 이 null 이면 RECOMMENDED[provider] 로 떨어진다', async () => {
    const r = await resolveModel({
      botId: 'b1',
      llmApiKeyEncrypted: 'enc:good',
      llmProvider: 'openai',
      llmModel: null,
    });
    expect(r.modelId).toBe(RECOMMENDED.openai);
  });

  it('provider 가 비었거나 알 수 없으면 조용히 gemini 로 넘기지 않고 실패한다', async () => {
    await expect(
      resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: null }),
    ).rejects.toBeInstanceOf(LlmConfigError);
    await expect(
      resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:good', llmProvider: 'mistral' }),
    ).rejects.toBeInstanceOf(LlmConfigError);
    expect(googleFactory).not.toHaveBeenCalled();
  });

  it('복호화가 실패하면 운영자 잘못으로 표시되는 실패를 던진다', async () => {
    try {
      await resolveModel({ botId: 'b1', llmApiKeyEncrypted: 'enc:broken', llmProvider: 'gemini' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmConfigError);
      expect((err as LlmConfigError).usingOwnKey).toBe(true);
    }
  });
});

describe('resolveModel — 키가 없을 때 (플랫폼 폴백)', () => {
  it('PLATFORM_LLM_PROVIDER / PLATFORM_LLM_MODEL 을 쓴다', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'gemini');
    vi.stubEnv('PLATFORM_LLM_MODEL', 'gemini-2.5-flash-lite');
    vi.stubEnv('GOOGLE_API_KEY', 'AIzaPLATFORMFAKE00000000000000000000000');

    const r = await resolveModel({ botId: 'b1' });

    expect(r.usingOwnKey).toBe(false);
    expect(r.provider).toBe('gemini');
    expect(r.modelId).toBe('gemini-2.5-flash-lite');
    expect(googleFactory).toHaveBeenCalledWith({ apiKey: 'AIzaPLATFORMFAKE00000000000000000000000' });
  });

  it('플랫폼 env 2개가 없어도 gemini + 추천 기본값으로 동작한다 (배포가 안 깨진다)', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'AIzaPLATFORMFAKE00000000000000000000000');

    const r = await resolveModel({ botId: 'b1', llmApiKeyEncrypted: null, llmProvider: null });

    expect(r.provider).toBe('gemini');
    expect(r.modelId).toBe(RECOMMENDED.gemini);
    expect(r.usingOwnKey).toBe(false);
  });

  it('지정한 provider 의 플랫폼 키가 없으면 다른 provider 로 넘어가지 않고 실패한다', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'openai');
    vi.stubEnv('GOOGLE_API_KEY', 'AIzaPLATFORMFAKE00000000000000000000000'); // 있어도 안 쓴다

    try {
      await resolveModel({ botId: 'b1' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmConfigError);
      // 운영자 잘못이 아니므로 bots 에 쓰면 안 된다 — 그 판정 근거가 이 플래그다
      expect((err as LlmConfigError).usingOwnKey).toBe(false);
    }
    expect(googleFactory).not.toHaveBeenCalled();
    expect(openaiFactory).not.toHaveBeenCalled();
  });

  it('PLATFORM_LLM_PROVIDER 오타는 조용히 gemini 로 접지 않는다', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'gemeni');
    vi.stubEnv('GOOGLE_API_KEY', 'AIzaPLATFORMFAKE00000000000000000000000');

    await expect(resolveModel({ botId: 'b1' })).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe('resolveModel — 플랫폼 anthropic 키는 자동 PR 엔진 키와 분리된다 (2026-09-13 보안 리뷰 MEDIUM-2)', () => {
  it('PLATFORM_ANTHROPIC_API_KEY 가 있으면 그것을 쓴다 — 공용 ANTHROPIC_API_KEY 가 있어도 무시', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'anthropic');
    vi.stubEnv('PLATFORM_LLM_MODEL', 'claude-haiku-4-5-20251001');
    vi.stubEnv('PLATFORM_ANTHROPIC_API_KEY', 'sk-ant-PLATFORM-ONLY');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHARED-WITH-AUTO-PR');

    const r = await resolveModel({ botId: 'b1' });

    expect(r.provider).toBe('anthropic');
    expect(r.modelId).toBe('claude-haiku-4-5-20251001');
    expect(anthropicFactory).toHaveBeenCalledWith({ apiKey: 'sk-ant-PLATFORM-ONLY' });
  });

  it('전용 키가 없으면 공용 ANTHROPIC_API_KEY 로 내려간다 (발급 전 과도기 — 배포가 안 깨진다)', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHARED-WITH-AUTO-PR');

    const r = await resolveModel({ botId: 'b1' });

    expect(anthropicFactory).toHaveBeenCalledWith({ apiKey: 'sk-ant-SHARED-WITH-AUTO-PR' });
    expect(r.usingOwnKey).toBe(false);
  });

  it('둘 다 없으면 실패 메시지가 두 이름을 다 말한다', async () => {
    vi.stubEnv('PLATFORM_LLM_PROVIDER', 'anthropic');

    await expect(resolveModel({ botId: 'b1' })).rejects.toThrow(/PLATFORM_ANTHROPIC_API_KEY \/ ANTHROPIC_API_KEY/);
  });
});

describe('모델 이름 검증 — 목록은 닫힌 집합이 아니다', () => {
  it('목록에 없는 이름도 통과시킨다 (provider 신모델을 우리 배포 없이 쓴다)', () => {
    expect(validateModelId('gemini-9.9-flash-future')).toEqual({
      ok: true,
      value: 'gemini-9.9-flash-future',
    });
    expect(validateModelId('some-model-nobody-knows')).toMatchObject({ ok: true });
  });

  it('안 고른 것(null·undefined)은 통과하고 값이 null 이다 = 추천 기본값을 탄다', () => {
    expect(validateModelId(null)).toEqual({ ok: true, value: null });
    expect(validateModelId(undefined)).toEqual({ ok: true, value: null });
  });

  it('빈 문자열·공백만·81자는 거절한다', () => {
    expect(validateModelId('').ok).toBe(false);
    expect(validateModelId('   ').ok).toBe(false);
    expect(validateModelId('a'.repeat(MODEL_ID_MAX + 1)).ok).toBe(false);
    expect(validateModelId('a'.repeat(MODEL_ID_MAX)).ok).toBe(true);
  });

  it('허용 문자 집합 밖은 거절한다 — 블랙리스트로는 인코딩·쿼리 주입이 새어 나간다', () => {
    // %2e%2e = 인코딩된 상위 경로, ? = 쿼리, # = 프래그먼트, : = 스킴.
    // 슬래시·공백만 막는 블랙리스트로는 넷 다 통과한다.
    expect(validateModelId('..%2f..%2fmodels').ok).toBe(false);
    expect(validateModelId('gemini?key=stolen').ok).toBe(false);
    expect(validateModelId('gemini#frag').ok).toBe(false);
    expect(validateModelId('http:models').ok).toBe(false);
    expect(validateModelId('gemini%20flash').ok).toBe(false);
    // 실제 모델 id 는 셋 다 통과한다
    expect(validateModelId('gemini-3.5-flash-lite').ok).toBe(true);
    expect(validateModelId('claude-haiku-4-5-20251001').ok).toBe(true);
    expect(validateModelId('gpt-5.6-luna').ok).toBe(true);
    expect(validateModelId('some_model.v2').ok).toBe(true);
  });

  it('URL 경로를 비틀 수 있는 문자를 거절한다 — 이 값이 provider API 경로에 들어간다', () => {
    expect(validateModelId('gemini flash').ok).toBe(false);
    expect(validateModelId('../../v1beta/models').ok).toBe(false);
    expect(validateModelId('gemini\\flash').ok).toBe(false);
    expect(validateModelId('gemini\nflash').ok).toBe(false);
    expect(validateModelId('gemini\tflash').ok).toBe(false);
    expect(validateModelId(' gemini-3.5-flash-lite').ok).toBe(false);
    expect(validateModelId(String.fromCharCode(103, 0, 112)).ok).toBe(false);
    expect(validateModelId(123).ok).toBe(false);
  });
});

describe('models.ts 자체 정합성', () => {
  it('RECOMMENDED 는 세 provider 모두 목록 안에 있다', () => {
    for (const p of ['gemini', 'anthropic', 'openai'] as const) {
      expect(MODELS[p].map((m) => m.id)).toContain(RECOMMENDED[p]);
    }
  });

  it('모든 모델 id 가 자기 검증 규칙을 통과한다', () => {
    for (const list of Object.values(MODELS)) {
      for (const m of list) expect(validateModelId(m.id)).toEqual({ ok: true, value: m.id });
    }
  });

  it('isLlmProvider 는 세 값만 인정한다', () => {
    expect(isLlmProvider('gemini')).toBe(true);
    expect(isLlmProvider('anthropic')).toBe(true);
    expect(isLlmProvider('openai')).toBe(true);
    expect(isLlmProvider('google')).toBe(false);
    expect(isLlmProvider(null)).toBe(false);
  });
});

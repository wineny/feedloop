import { describe, it, expect, vi, beforeEach } from 'vitest';

// callLlm 의 «호출 조건»을 지킨다. 여기서 새면 상한도 예산도 의미가 없어진다.

// vi.mock 팩토리는 파일 맨 위로 끌어올려진다. 스파이를 평범한 const 로 두면
// 팩토리가 «초기화 전»에 그걸 읽어 ReferenceError 가 난다 — vi.hoisted 로 같이 올린다.
const { generateText, resolveModel, markLlmKeyFailed, clearLlmKeyFailure, LlmConfigError } =
  vi.hoisted(() => {
    class LlmConfigError extends Error {
      readonly usingOwnKey: boolean;
      constructor(message: string, usingOwnKey: boolean) {
        super(message);
        this.name = 'LlmConfigError';
        this.usingOwnKey = usingOwnKey;
      }
    }
    return {
      generateText: vi.fn(),
      resolveModel: vi.fn(),
      markLlmKeyFailed: vi.fn(async () => {}),
      clearLlmKeyFailure: vi.fn(async () => {}),
      LlmConfigError,
    };
  });

vi.mock('ai', () => ({ generateText }));
vi.mock('@/lib/llm/provider', () => ({ resolveModel, LlmConfigError }));
vi.mock('@/lib/llm/failure', () => ({ markLlmKeyFailed, clearLlmKeyFailure }));

// handler.ts 가 끌어오는 DB 함수들. 이 테스트는 하나도 부르지 않는다.
vi.mock('@/lib/bot/db', () => ({
  saveMessage: vi.fn(),
  saveInsight: vi.fn(),
  saveResponse: vi.fn(),
  getRecentMessages: vi.fn(),
  checkCooldown: vi.fn(),
  updateCooldown: vi.fn(),
}));

import { callLlm, type BotConfig } from '@/lib/bot/handler';

const BOT_ID = '11111111-1111-4111-8111-111111111111';

function config(extra: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: BOT_ID,
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: '널널투어',
      botTone: '친근',
      serviceName: '널널투어',
      serviceUrl: '',
      serviceDescription: '',
      serviceCompany: '',
      targetUsers: '',
      serviceFeatures: [],
      loginMethod: '',
      faq: [],
      knowledge: '',
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockResolvedValue({ text: '안녕하세요' });
  resolveModel.mockResolvedValue({
    model: { fake: true },
    usingOwnKey: true,
    provider: 'gemini',
    modelId: 'gemini-3.5-flash-lite',
  });
});

describe('callLlm — 재시도를 하지 않는다', () => {
  it('generateText 에 maxRetries: 0 을 넘긴다', async () => {
    await callLlm(config(), 'system', 'user');

    // AI SDK v7 기본값은 2 다. 그대로 두면 우리 호출 1건이 provider 호출 3건이 되어
    // 일일 상한이 3배로 새고 카카오 4초 예산은 첫 재시도에서 깨진다.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });

  it('timeoutMs 를 주면 SDK 안쪽 timeout 으로 넘긴다', async () => {
    await callLlm(config(), 'system', 'user', { timeoutMs: 4000 });

    expect(generateText.mock.calls[0][0]).toMatchObject({ maxRetries: 0, timeout: 4000 });
  });

  it('timeoutMs 가 없으면 timeout 을 넘기지 않는다', async () => {
    await callLlm(config(), 'system', 'user');

    expect(generateText.mock.calls[0][0]).not.toHaveProperty('timeout');
  });
});

describe('callLlm — 실패 표시의 수명', () => {
  it('성공했고 지난 실패가 남아 있으면 지운다', async () => {
    const cfg = config({ llmKeyFailedAt: '2026-09-09T00:00:00Z', llmApiKeyEncrypted: 'enc' });

    await callLlm(cfg, 'system', 'user');

    expect(clearLlmKeyFailure).toHaveBeenCalledWith(BOT_ID);
    // 캐시된 config 를 그 자리에서 고친다 — 5분 동안 같은 UPDATE 를 반복하지 않기 위해서다.
    expect(cfg.llmKeyFailedAt).toBeNull();
  });

  it('평소 성공에는 DB 를 건드리지 않는다', async () => {
    await callLlm(config({ llmApiKeyEncrypted: 'enc' }), 'system', 'user');

    expect(clearLlmKeyFailure).not.toHaveBeenCalled();
    expect(markLlmKeyFailed).not.toHaveBeenCalled();
  });

  it('플랫폼 폴백으로 돈 성공은 실패 표시를 지우지 않는다', async () => {
    resolveModel.mockResolvedValue({
      model: { fake: true },
      usingOwnKey: false,
      provider: 'gemini',
      modelId: 'gemini-2.5-flash-lite',
    });

    await callLlm(config({ llmKeyFailedAt: '2026-09-09T00:00:00Z' }), 'system', 'user');

    expect(clearLlmKeyFailure).not.toHaveBeenCalled();
  });

  it('운영자 키로 실패하면 사유를 남긴다', async () => {
    generateText.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 401 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await callLlm(config({ llmApiKeyEncrypted: 'enc' }), 'system', 'user');

    expect(out).toBeNull();
    expect(markLlmKeyFailed).toHaveBeenCalledWith(BOT_ID, 'key_rejected');
  });

  it('플랫폼 폴백 실패는 bots 에 쓰지 않는다 — 운영자 잘못이 아니다', async () => {
    resolveModel.mockRejectedValue(new LlmConfigError('platform key missing', false));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await callLlm(config(), 'system', 'user');

    expect(out).toBeNull();
    expect(markLlmKeyFailed).not.toHaveBeenCalled();
  });
});

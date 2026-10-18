import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_LIMITS } from '@/lib/llm/limits';

// ── Supabase 모킹 ───────────────────────────────────
// 테이블별로 insert / update 를 기록해 «무엇이 늘었나» 를 직접 센다.
// saveInsight·saveConversationResponse 는 진짜 함수를 태운다 — 채널톡 경로가
// 공용 저장 계층을 실제로 어떻게 부르는지가 이 테스트의 관심사다.

const inserted: Record<string, unknown[]> = {};
const updated: Record<string, unknown[]> = {};

let messageInsertError: { code?: string; message: string } | null = null;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: 1, error: null };

const rpcMock = vi.fn(async (_fn: string, _args: unknown) => rpcResult);

function makeFrom(table: string) {
  return {
    insert: (row: unknown) => {
      inserted[table] = [...(inserted[table] ?? []), row];
      const error = table === 'messages' ? messageInsertError : null;
      const result = { data: error ? null : { id: `${table}-1` }, error };
      return {
        select: () => ({ single: async () => result }),
        // saveInsight 는 .select() 없이 insert 를 그대로 await 한다.
        then: (resolve: (v: unknown) => void) => resolve({ error }),
      };
    },
    update: (patch: unknown) => {
      updated[table] = [...(updated[table] ?? []), patch];
      return { eq: async () => ({ error: null }) };
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ from: (table: string) => makeFrom(table), rpc: rpcMock }),
}));

// ── 봇 설정 · LLM 모킹 ──────────────────────────────

const SERVICE_PROFILE = {
  botName: '널널투어',
  botTone: '친근하고 편한 한국어.',
  serviceName: '널널투어',
  serviceUrl: 'https://example.com',
  serviceDescription: '여행 쿠폰 서비스',
  serviceCompany: '',
  targetUsers: '베타 테스터',
  serviceFeatures: [],
  loginMethod: '',
  faq: [],
  knowledge: '',
};

let botConfig: Record<string, unknown> | null = {
  botId: 'bot-1',
  mentionPatterns: [],
  feedbackKeywords: { negative: [], positive: [], question: [] },
  serviceProfile: SERVICE_PROFILE,
  cooldownIntervalSec: 30,
  cooldownMaxDaily: 50,
  dailyReplyLimit: null,
  llmApiKeyEncrypted: null,
  llmProvider: null,
  llmModel: null,
  llmKeyFailedAt: null,
};

vi.mock('@/lib/bot/core', () => ({
  getBotConfigFromDB: vi.fn(async () => {
    if (!botConfig) throw new Error('Bot not found: bot-1');
    return botConfig;
  }),
}));

const callLlmMock = vi.fn(async () => '{}' as string | null);

vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  // extractResult 는 «진짜» 를 쓴다 — 공용 함수 무회귀가 이 테스트의 단언 중 하나다.
  return { ...actual, callLlm: callLlmMock };
});

let store: typeof import('@/lib/channel/store');
let extractResult: typeof import('@/lib/bot/handler').extractResult;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(inserted)) delete inserted[k];
  for (const k of Object.keys(updated)) delete updated[k];
  messageInsertError = null;
  rpcResult = { data: 1, error: null };
  rpcMock.mockClear();
  callLlmMock.mockClear();
  callLlmMock.mockResolvedValue('{}');
  botConfig = {
    botId: 'bot-1',
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: SERVICE_PROFILE,
    cooldownIntervalSec: 30,
    cooldownMaxDaily: 50,
    dailyReplyLimit: null,
    llmApiKeyEncrypted: null,
    llmProvider: null,
    llmModel: null,
    llmKeyFailedAt: null,
  };
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  store = await import('@/lib/channel/store');
  ({ extractResult } = await import('@/lib/bot/handler'));
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const countOf = (table: string) => (inserted[table] ?? []).length;

describe('classifyChannelMessage — 인사이트만 남기고 응답은 버린다', () => {
  it('정상 출력이면 인사이트 1건을 남긴다', async () => {
    callLlmMock.mockResolvedValue(
      JSON.stringify({
        response: '확인해 볼게요',
        insight: { category: 'bug', summary: '쿠폰함이 안 열림', sentiment: 'negative' },
      }),
    );

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '쿠폰함이 안 열려요')).toBe('saved');

    // 인사이트는 `pipeline_settle_insight` 가 메시지 상태와 **한 트랜잭션**에 남긴다.
    // 직접 insert 하던 시절의 단언은 이 경로를 보지 못한다.
    const settle = rpcMock.mock.calls.find((c) => c[0] === 'pipeline_settle_insight');
    expect(settle).toBeDefined();
    expect(settle![1]).toMatchObject({
      p_bot_id: 'bot-1',
      p_message_id: 'msg-1',
      p_insight: expect.objectContaining({ category: 'bug' }),
    });
  });

  it('응답은 저장하지 않는다 — 이 채널에서 우리는 말하지 않는다', async () => {
    callLlmMock.mockResolvedValue(
      JSON.stringify({
        response: '제가 답해 드릴게요',
        insight: { category: 'cs', summary: '문의', sentiment: 'neutral' },
      }),
    );

    await store.classifyChannelMessage('bot-1', 'msg-1', '문의드려요');
    expect(countOf('responses')).toBe(0);
  });

  it('출력이 깨지면 인사이트를 저장하지 않는다 — other 쓰레기가 묶기로 흘러가면 안 된다', async () => {
    callLlmMock.mockResolvedValue('죄송합니다. JSON 이 아닌 그냥 문장입니다.');

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('unparsed');
    expect(countOf('insights')).toBe(0);
  });

  it('공용 extractResult 는 종전 그대로다 — 판별만 밖에서 하고 함수는 안 고쳤다', () => {
    const broken = extractResult('그냥 문장');
    expect(broken.parsed).toBe(false);
    expect(broken.response).toBeNull();
    expect(broken.insight).toEqual({
      category: 'other',
      summary: '그냥 문장',
      sentiment: 'neutral',
    });
  });

  it('insight 가 null 이면 저장할 것이 없다', async () => {
    callLlmMock.mockResolvedValue(JSON.stringify({ response: '안녕하세요', insight: null }));

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '안녕')).toBe('no_insight');
    expect(countOf('insights')).toBe(0);
  });

  it('LLM 호출 자체가 실패하면 인사이트가 늘지 않는다', async () => {
    callLlmMock.mockResolvedValue(null);

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('llm_failed');
    expect(countOf('insights')).toBe(0);
  });

  it('봇 설정을 못 읽으면 상한을 태우지 않고 멈춘다', async () => {
    botConfig = null;

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('config_failed');
    expect(rpcMock).not.toHaveBeenCalled();
    expect(callLlmMock).not.toHaveBeenCalled();
  });
});

describe('일일 상한 — 위젯 칸을 잠식하지 않는다', () => {
  it('채널톡 칸만 올린다. 위젯 상한(ai_call_attempts)은 건드리지 않는다', async () => {
    await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트');

    const fns = rpcMock.mock.calls.map((c) => c[0]);
    expect(fns).toEqual(['bump_channel_usage']);
    expect(fns).not.toContain('bump_bot_usage');
    expect(fns).not.toContain('bump_kakao_usage');
  });

  it('상한을 넘으면 LLM 을 부르지 않는다 — 상한은 분류를 막지 제보를 버리지 않는다', async () => {
    // 키 없는 봇의 무료분(`DEFAULT_LIMITS.noKey`)을 상수에서 끌어온다. 숫자를 박아두면
    // 무료분이 바뀔 때 이 테스트가 «경계를 안 재는» 상태로 조용히 초록이 된다 —
    // main 이 30 → 100(Haiku 무료분)으로 올렸을 때 실제로 그렇게 어긋났다.
    rpcResult = { data: DEFAULT_LIMITS.noKey + 1, error: null };

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('over_limit');
    expect(callLlmMock).not.toHaveBeenCalled();
    expect(countOf('insights')).toBe(0);
  });

  it('상한 경계에서는 통과한다', async () => {
    rpcResult = { data: DEFAULT_LIMITS.noKey, error: null };
    callLlmMock.mockResolvedValue(
      // `response` 키가 있어야 한다 — 파이프라인이 출력 모양 검사를 엄격하게 바꿨다.
      JSON.stringify({ response: null, insight: { category: 'ux', summary: 's', sentiment: 'neutral' } }),
    );

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('saved');
  });

  it('계측이 실패하면 초과와 같게 다룬다 — 셀 수 없으면 열어두지 않는다', async () => {
    rpcResult = { data: null, error: { message: 'rpc down' } };

    expect(await store.classifyChannelMessage('bot-1', 'msg-1', '텍스트')).toBe('over_limit');
    expect(callLlmMock).not.toHaveBeenCalled();
  });
});

describe('saveChannelMessage', () => {
  it('source 는 channel, origin 은 NULL — 서버 웹훅에 브라우저 Origin 은 없다', async () => {
    const result = await store.saveChannelMessage({
      botId: 'bot-1',
      conversationId: 'conv-1',
      externalUserId: 'chat-9',
      externalMessageId: 'msg-ext-1',
      text: '쿠폰함이 안 열려요',
    });

    expect(result).toEqual({ id: 'messages-1', duplicate: false });
    expect(inserted.messages[0]).toMatchObject({
      source: 'channel',
      external_user_id: 'chat-9',
      external_message_id: 'msg-ext-1',
      origin: null,
    });
  });

  it('같은 external_message_id 가 다시 오면 duplicate 로 알린다 — 재전송은 정상이다', async () => {
    messageInsertError = { code: '23505', message: 'duplicate key' };

    const result = await store.saveChannelMessage({
      botId: 'bot-1',
      conversationId: 'conv-1',
      externalUserId: 'chat-9',
      externalMessageId: 'msg-ext-1',
      text: '같은 말',
    });

    expect(result).toEqual({ id: null, duplicate: true });
    // 재전송은 사고가 아니다 — 에러로 시끄럽게 굴지 않는다.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('다른 DB 오류는 duplicate 로 삼키지 않는다', async () => {
    messageInsertError = { code: '23503', message: 'fk violation' };

    const result = await store.saveChannelMessage({
      botId: 'bot-1',
      conversationId: 'conv-1',
      externalUserId: 'chat-9',
      externalMessageId: 'msg-ext-2',
      text: '텍스트',
    });

    expect(result).toEqual({ id: null, duplicate: false });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('saveManagerReply', () => {
  it('상담원 답장을 전달된 것으로 남긴다 — 이미 유저에게 도착한 말이다', async () => {
    const id = await store.saveManagerReply({
      botId: 'bot-1',
      conversationId: 'conv-1',
      body: '확인해 보겠습니다',
    });

    expect(id).toBe('responses-1');
    expect(inserted.responses[0]).toMatchObject({
      conversation_id: 'conv-1',
      response_type: 'operator',
    });
    expect((inserted.responses[0] as { delivered_at: string | null }).delivered_at).not.toBeNull();
  });

  it('escalated_at 을 건드리지 않는다 — 우리가 답하지 않는 채널에 「사람 필요」는 성립하지 않는다', async () => {
    await store.saveManagerReply({
      botId: 'bot-1',
      conversationId: 'conv-1',
      body: '확인해 보겠습니다',
    });

    expect(updated.conversations).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// I-28 — 카카오 웹훅에서 인사이트 저장(saveInsight)이 DB 오류로 throw 하면, 답장은 이미 저장돼 있는데
// processUtterance 가 거부돼 바깥 catch 가 「요청을 처리하지 못했습니다」를 내보냈다. 방문자는 만들어 둔
// 답을 못 받는다. 이 테스트가 지키는 것: 인사이트 저장 실패는 로그로만 남고 답장은 그대로 나간다.
// (messageId 가 null 인 경로는 라우트가 saveInsight 전에 이미 끊는다 — 백로그가 걱정한 고아 인사이트는 안 생긴다.)

function noopChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'is', 'in', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => ({ data: null, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({ rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn(() => noopChain()) }),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).catch === 'function') (task as Promise<unknown>).catch(() => {});
    },
  };
});

// 인사이트가 «있는» 답 — parsed:true 가 되어 saveInsight 경로를 탄다.
const callLlm = vi.fn(async () =>
  JSON.stringify({ response: '쿠폰함은 마이페이지 오른쪽 위에 있어요', insight: { category: 'bug', summary: '쿠폰함 안 열림', sentiment: 'negative' } }),
);
vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return { ...actual, callLlm };
});

const touchConversation = vi.fn(async () => {});
vi.mock('@/lib/bot/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/conversations')>();
  return {
    ...actual,
    touchConversation,
    upsertConversation: vi.fn(async () => ({ id: 'conv-1', contact_name: null, contact_email: null, contact_phone: null })),
    getUndeliveredResponses: vi.fn(async () => []),
    markResponsesDelivered: vi.fn(async () => {}),
    markConversationEscalated: vi.fn(async () => {}),
  };
});

const getBotConfigFromDB = vi.fn();
vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB, invalidateBotCache: vi.fn() }));

const saveInsight = vi.fn<() => Promise<{ id: string | null; created: boolean }>>();
const saveResponse = vi.fn(async () => 'kakao-resp-1');
const saveKakaoMessage = vi.fn<() => Promise<string | null>>(async () => 'kakao-msg-1');
vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  return {
    ...actual,
    saveInsight,
    saveResponse,
    saveKakaoMessage,
    getRecentKakaoMessages: vi.fn(async () => []),
    markBotConnected: vi.fn(async () => {}),
  };
});

const BOT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  saveKakaoMessage.mockResolvedValue('kakao-msg-1');
  getBotConfigFromDB.mockResolvedValue({
    botId: BOT_ID,
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: '널널투어', botTone: '친근', serviceName: '널널투어', serviceUrl: '', serviceDescription: '',
      serviceCompany: '', targetUsers: '', serviceFeatures: [], loginMethod: '', faq: [], knowledge: '',
    },
  });
});

async function postKakao() {
  vi.stubEnv('KAKAO_WEBHOOK_ENABLED', 'true');
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/kakao/webhook/[botId]/route');
  const req = new NextRequest(`https://feedloop.test/api/kakao/webhook/${BOT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userRequest: { utterance: '쿠폰함이 안 열려요', user: { id: 'kakao-user-1' } } }),
  });
  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  return { res, body: (await res.json()) as { template: { outputs: { simpleText: { text: string } }[] } } };
}

describe('카카오 웹훅 — 인사이트 저장 실패가 답장을 깨지 않는다 (I-28)', () => {
  it('saveInsight 가 throw 해도 만들어 둔 답이 그대로 나간다 (오류 문구 ✗)', async () => {
    saveInsight.mockRejectedValue(new Error('insight_persistence_failed: gateway timeout'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res, body } = await postKakao();

    expect(res.status).toBe(200);
    expect(body.template.outputs[0].simpleText.text).toBe('쿠폰함은 마이페이지 오른쪽 위에 있어요');
    expect(saveResponse).toHaveBeenCalledTimes(1);
    expect(saveInsight).toHaveBeenCalledTimes(1);
    // 조용히 삼키지 않는다 — 운영 로그에는 남아야 한다
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('insight save failed'), expect.any(Error));
    errorSpy.mockRestore();
  });

  it('저장이 되면 종전대로 같은 답이다 (대조군 — 가드가 정상 경로를 바꾸지 않는다)', async () => {
    saveInsight.mockResolvedValue({ id: 'ins-1', created: true });

    const { res, body } = await postKakao();

    expect(res.status).toBe(200);
    expect(body.template.outputs[0].simpleText.text).toBe('쿠폰함은 마이페이지 오른쪽 위에 있어요');
    expect(saveInsight).toHaveBeenCalledWith(BOT_ID, 'kakao-msg-1', expect.objectContaining({ category: 'bug' }), false);
  });
});

// ── I-29 근본 원인 — 메시지가 «남은 뒤»에만 last_message_at 을 올린다 ──────────
// 카카오는 4초 예산이라 touch 를 최근 대화 조회와 같이 보낸다. 그래도 «저장 뒤»여야 한다.

describe('카카오 웹훅 — last_message_at 은 저장 뒤에 올린다 (I-29)', () => {
  it('저장이 되면 그 «뒤에» 대화 시각을 올린다', async () => {
    const order: string[] = [];
    saveKakaoMessage.mockImplementation(async () => {
      order.push('save');
      return 'kakao-msg-1';
    });
    touchConversation.mockImplementation(async () => {
      order.push('touch');
    });

    const { res } = await postKakao();

    expect(res.status).toBe(200);
    expect(touchConversation).toHaveBeenCalledTimes(1);
    expect(touchConversation).toHaveBeenCalledWith('conv-1');
    expect(order).toEqual(['save', 'touch']);
  });

  it('저장이 실패하면 재전송 안내만 나가고 시각은 안 올라간다 — 유령 대화를 만들지 않는다', async () => {
    saveKakaoMessage.mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res, body } = await postKakao();

    expect(res.status).toBe(200);
    expect(body.template.outputs[0].simpleText.text).toContain('저장하지 못했습니다');
    expect(touchConversation).not.toHaveBeenCalled();
    expect(saveResponse).not.toHaveBeenCalled();
  });
});

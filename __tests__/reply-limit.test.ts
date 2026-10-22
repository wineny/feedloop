import { describe, it, expect, vi, beforeEach } from 'vitest';

// 무인증 위젯 POST 가 남의 지갑을 태우지 않게 하는 장치.
// 앞부분은 판정 함수의 단위 테스트, 뒷부분은 «위젯 라우트가 실제로 그 순서를 지키는가»다.

// ── 모킹 ────────────────────────────────────────────
// 아래 목들은 라우트 테스트용이다. 순수 함수(resolveLimit·isOverLimit)는 이걸 안 탄다.

type RpcResult = { data: number | null; error: { message: string } | null };
const rpcMock = vi.fn<() => Promise<RpcResult>>(async () => ({ data: 1, error: null }));

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
  getServiceRoleClient: () => ({ rpc: rpcMock, from: vi.fn(() => noopChain()) }),
}));

// after() 는 응답 뒤 작업이라 테스트에서는 삼킨다. 거부는 조용히 흘려보낸다.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      if (task && typeof (task as Promise<unknown>).catch === 'function') {
        (task as Promise<unknown>).catch(() => {});
      }
    },
  };
});

const callLlm = vi.fn(async () => JSON.stringify({ response: '안녕하세요', insight: null }));
vi.mock('@/lib/bot/handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/handler')>();
  return { ...actual, callLlm };
});

// 인자를 타입에 실어야 아래에서 calls[0][0] 을 볼 수 있다.
const saveWebMessage = vi.fn<(params: Record<string, unknown>) => Promise<string | null>>(
  async () => 'msg-1',
);
const saveConversationResponse = vi.fn(async () => 'resp-1');
const markConversationEscalated = vi.fn(async () => {});
const touchConversation = vi.fn(async () => {});
vi.mock('@/lib/bot/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/conversations')>();
  return {
    ...actual,
    saveWebMessage,
    saveConversationResponse,
    markConversationEscalated,
    touchConversation,
    upsertConversation: vi.fn(async () => ({
      id: 'conv-1',
      contact_name: null,
      contact_email: null,
      contact_phone: null,
    })),
    getTimeline: vi.fn(async () => []),
    getUndeliveredResponses: vi.fn(async () => []),
    markResponsesDelivered: vi.fn(async () => {}),
  };
});

const getBotConfigFromDB = vi.fn();
vi.mock('@/lib/bot/core', () => ({ getBotConfigFromDB, invalidateBotCache: vi.fn() }));

// 실제 구현을 그대로 태우고 «불렸는가»만 본다 — 저장 실패 경로에서 0회여야 한다(I-23).
const applyInsightWrite = vi.fn<typeof import('@/lib/bot/db').applyInsightWrite>();
vi.mock('@/lib/bot/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/db')>();
  applyInsightWrite.mockImplementation(actual.applyInsightWrite);
  return {
    ...actual,
    applyInsightWrite,
    saveInsight: vi.fn(async () => {}),
    saveKakaoMessage: vi.fn(async () => 'kakao-msg-1'),
    saveResponse: vi.fn(async () => 'kakao-resp-1'),
    getRecentKakaoMessages: vi.fn(async () => []),
    markBotConnected: vi.fn(async () => {}),
  };
});

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';

/** 라우트가 보는 속도 판정. 기본은 통과. 봇 상한 테스트가 이 값을 바꾼다. */
const rateVerdict = vi.fn(async () => ({ ok: true }) as import('@/lib/widget/http').WidgetRateVerdict);

vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return {
    ...actual,
    resolveWidgetBot: vi.fn(async () => ({ id: BOT_ID, service_name: '널널투어' })),
    checkWriteRate: vi.fn(async () => null),
    checkWidgetWriteRate: rateVerdict,
  };
});

import { resolveLimit, isOverLimit, withReplyBudget, DEFAULT_LIMITS } from '@/lib/llm/usage';
import { limitForDisplay } from '@/lib/llm/limits';

const KEY = 'enc:whatever'; // 암호문 자리표시자. 값은 안 본다 — 유무만 본다

beforeEach(() => {
  // clearAllMocks 는 호출 기록만 지운다 — 위 applyInsightWrite 의 mockImplementation(실제 구현)은 남는다.
  // resetAllMocks/restoreAllMocks 로 바꾸면 그게 no-op 이 되어 I-23 케이스가 «조용히» 통과한다.
  vi.clearAllMocks();
  rateVerdict.mockResolvedValue({ ok: true });
  rpcMock.mockResolvedValue({ data: 1, error: null });
  saveWebMessage.mockResolvedValue('msg-1');
  getBotConfigFromDB.mockResolvedValue({
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
    dailyReplyLimit: 30,
  });
});

describe('resolveLimit — provider 3종 전부', () => {
  it('키가 없으면 100 이다 (llm_provider 값과 무관)', () => {
    expect(resolveLimit({})).toBe(100);
    expect(resolveLimit({ llmApiKeyEncrypted: null, llmProvider: 'gemini' })).toBe(100);
    expect(resolveLimit({ llmApiKeyEncrypted: '', llmProvider: 'anthropic' })).toBe(100);
    expect(resolveLimit({ llmProvider: 'openai' })).toBe(100);
  });

  it('gemini 키가 있으면 한도 없음(Infinity) 이다', () => {
    expect(resolveLimit({ llmApiKeyEncrypted: KEY, llmProvider: 'gemini' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('anthropic 키가 있으면 한도 없음이다', () => {
    expect(resolveLimit({ llmApiKeyEncrypted: KEY, llmProvider: 'anthropic' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('openai 키가 있으면 한도 없음이다', () => {
    expect(resolveLimit({ llmApiKeyEncrypted: KEY, llmProvider: 'openai' })).toBe(Number.POSITIVE_INFINITY);
  });

  it('daily_reply_limit 이 있으면 provider·키 유무와 무관하게 그 값이 이긴다', () => {
    // 데모 봇(널널투어) 예외가 이 경로로 산다 — 심사 기간에 상한으로 죽지 않게.
    expect(resolveLimit({ dailyReplyLimit: 2000 })).toBe(2000);
    expect(resolveLimit({ dailyReplyLimit: 2000, llmApiKeyEncrypted: KEY, llmProvider: 'gemini' })).toBe(2000);
    expect(resolveLimit({ dailyReplyLimit: 2000, llmApiKeyEncrypted: KEY, llmProvider: 'anthropic' })).toBe(2000);
    // 0 도 유효한 예외값이다 — "이 봇은 자동 답변을 끈다"
    expect(resolveLimit({ dailyReplyLimit: 0, llmApiKeyEncrypted: KEY, llmProvider: 'gemini' })).toBe(0);
  });

  it('provider 문자열과 무관하게 키가 있으면 한도 없음이다', () => {
    expect(resolveLimit({ llmApiKeyEncrypted: KEY, llmProvider: 'mistral' })).toBe(Number.POSITIVE_INFINITY);
    expect(resolveLimit({ llmApiKeyEncrypted: KEY, llmProvider: null })).toBe(Number.POSITIVE_INFINITY);
  });

  it('상수는 키 없음 100 / 키 있음 Infinity 이다', () => {
    expect(DEFAULT_LIMITS).toEqual({ noKey: 100, withKey: Number.POSITIVE_INFINITY });
  });

  it('한도 없음은 isOverLimit 을 절대 넘지 않고, 화면용으로는 null 이 된다', () => {
    expect(isOverLimit(1_000_000, Number.POSITIVE_INFINITY)).toBe(false);
    expect(limitForDisplay(Number.POSITIVE_INFINITY)).toBeNull();
    expect(limitForDisplay(100)).toBe(100);
  });
});

describe('isOverLimit — 선증가 후판정', () => {
  it('올린 뒤 값이 상한 이하면 부를 수 있다', () => {
    expect(isOverLimit(1, 100)).toBe(false);
    expect(isOverLimit(100, 100)).toBe(false);
  });

  it('상한을 넘으면 부르지 않는다 (101번째)', () => {
    expect(isOverLimit(101, 100)).toBe(true);
  });

  it('계측 자체가 실패하면 초과와 같게 다룬다 — 셀 수 없으면 열어두지 않는다', () => {
    expect(isOverLimit(null, 100)).toBe(true);
    expect(isOverLimit(null, 2000)).toBe(true);
  });
});

describe('withReplyBudget — 순서를 코드로 묶는다', () => {
  it('상한 안이면 run 을 부르고 값을 그대로 돌려준다', async () => {
    rpcMock.mockResolvedValue({ data: 5, error: null });
    const run = vi.fn(() => Promise.resolve('답변'));

    const r = await withReplyBudget(BOT_ID, { dailyReplyLimit: 30 }, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ allowed: true, attempts: 5, limit: 30 });
    if (r.allowed) expect(await r.value).toBe('답변');
  });

  it('상한을 넘으면 run 을 아예 부르지 않는다', async () => {
    rpcMock.mockResolvedValue({ data: 31, error: null });
    const run = vi.fn(() => Promise.resolve('답변'));

    const r = await withReplyBudget(BOT_ID, { dailyReplyLimit: 30 }, run);

    expect(run).not.toHaveBeenCalled();
    expect(r).toEqual({ allowed: false, attempts: 31, limit: 30 });
  });

  it('계측이 실패해도 run 을 부르지 않는다 (fail closed)', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const run = vi.fn(() => Promise.resolve('답변'));

    const r = await withReplyBudget(BOT_ID, { dailyReplyLimit: 30 }, run);

    expect(run).not.toHaveBeenCalled();
    expect(r).toEqual({ allowed: false, attempts: null, limit: 30 });
  });

  it('카운터를 먼저 올리고 나서 run 을 부른다 (되돌리지 않는다)', async () => {
    const order: string[] = [];
    rpcMock.mockImplementation(async () => {
      order.push('bump');
      return { data: 1, error: null };
    });
    await withReplyBudget(BOT_ID, { dailyReplyLimit: 30 }, () => {
      order.push('run');
      return Promise.resolve(null);
    });

    expect(order).toEqual(['bump', 'run']);
  });
});

// ── 위젯 라우트가 실제로 그 순서를 지키는가 ─────────
//
// 판정 함수가 맞아도 라우트가 순서를 뒤집으면 상한은 없는 것과 같다.
// 그래서 여기서는 라우트 핸들러를 직접 부른다.

async function postWidget(text = '쿠폰함이 안 열려요') {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/widget/[botId]/messages/route');

  const req = new NextRequest(`https://feedloop.test/api/widget/${BOT_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://demo.example' },
    body: JSON.stringify({ visitorId: VISITOR_ID, text }),
  });

  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  return { res, body: (await res.json()) as { notice: string | null; error?: string } };
}

describe('위젯 POST — 상한 초과', () => {
  it('상한을 넘으면 LLM 을 부르지 않는다', async () => {
    rpcMock.mockResolvedValue({ data: 31, error: null });

    await postWidget();

    expect(callLlm).not.toHaveBeenCalled();
  });

  it('상한을 넘어도 메시지 저장은 일어난다 — 상한은 답을 막지 피드백을 버리지 않는다', async () => {
    rpcMock.mockResolvedValue({ data: 31, error: null });

    const { body } = await postWidget('상한 넘은 뒤에 보낸 피드백');

    expect(saveWebMessage).toHaveBeenCalledTimes(1);
    expect(saveWebMessage.mock.calls[0][0]).toMatchObject({
      botId: BOT_ID,
      text: '상한 넘은 뒤에 보낸 피드백',
    });
    // 답변은 저장되지 않는다
    expect(saveConversationResponse).not.toHaveBeenCalled();
    // 안내 문구는 응답에만 실린다 (말풍선으로 남지 않는다)
    expect(body.notice).toBeTruthy();
    // 「AI 가 못 답함」은 «찍지 않는다» — 그 배지는 지식이 모자란 경우고 여기는 예산 문제다.
    // 섞으면 운영자가 엉뚱하게 지식을 고치러 간다. 대화는 미읽음으로 남아 받은편지함에 뜬다.
    expect(markConversationEscalated).not.toHaveBeenCalled();
  });

  it('저장을 «먼저» 하고 나서 카운터를 올린다 — 순서가 뒤집히면 피드백이 사라진다', async () => {
    const order: string[] = [];
    saveWebMessage.mockImplementation(async () => {
      order.push('save');
      return 'msg-1';
    });
    rpcMock.mockImplementation(async () => {
      order.push('bump');
      return { data: 31, error: null };
    });

    await postWidget();

    expect(order).toEqual(['save', 'bump']);
  });

  it('상한 안이면 LLM 을 부르고 답을 저장한다 (대조군)', async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });

    const { body } = await postWidget();

    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(body.notice).toBeNull();
  });

  it('Origin 헤더를 200자로 잘라 메시지에 남긴다 (차단하지 않는다)', async () => {
    await postWidget();

    expect(saveWebMessage.mock.calls[0][0]).toMatchObject({ origin: 'https://demo.example' });
  });
});

// ── 봇 시간당 상한은 제보를 «버리지» 않는다 ─────────────
//
// 봇 상한(WIDGET_BOT_HOURLY_LIMIT)을 429 로 끊으면, 분당 1건만 보내도 남의 봇을 시간
// 단위로 침묵시킬 수 있다 — 그 사이 들어온 «진짜» 제보가 DB 에 아예 안 남는다.
// 일일 예산과 같은 원칙으로 간다: 답은 막고 제보는 받는다.

describe('위젯 POST — 봇 시간당 상한', () => {
  const rate429 = { ok: false as const, limit: 'bot' as const, response: new Response(null, { status: 429 }) as never };

  it('200 으로 받고 제보를 저장한다 — 429 로 끊지 않는다', async () => {
    rateVerdict.mockResolvedValue(rate429);

    const { res, body } = await postWidget('상한 중에 들어온 진짜 제보');

    expect(res.status).toBe(200);
    expect(saveWebMessage).toHaveBeenCalledTimes(1);
    expect(saveWebMessage.mock.calls[0][0]).toMatchObject({ text: '상한 중에 들어온 진짜 제보' });
    expect(body.notice).toBeTruthy();
  });

  it('LLM 을 부르지 않고 일일 예산도 올리지 않는다', async () => {
    rateVerdict.mockResolvedValue(rate429);

    await postWidget();

    expect(callLlm).not.toHaveBeenCalled();
    // 부르지 않은 호출을 시도로 세면 시간당 상한이 일일 예산을 대신 태운다.
    expect(rpcMock).not.toHaveBeenCalled();
    expect(saveConversationResponse).not.toHaveBeenCalled();
  });

  it('「담당자 확인 필요」를 찍지 않는다 — 지식 문제가 아니라 트래픽 문제다', async () => {
    rateVerdict.mockResolvedValue(rate429);

    await postWidget();

    expect(markConversationEscalated).not.toHaveBeenCalled();
  });

  it('안내 문구는 일일 예산의 것과 다르다 — 저쪽은 오늘이 끝난 것이고 이쪽은 한 시간이면 풀린다', async () => {
    rateVerdict.mockResolvedValue(rate429);
    const hourly = (await postWidget()).body.notice;

    rateVerdict.mockResolvedValue({ ok: true });
    rpcMock.mockResolvedValue({ data: 31, error: null });
    const daily = (await postWidget()).body.notice;

    expect(hourly).toBeTruthy();
    expect(daily).toBeTruthy();
    expect(hourly).not.toBe(daily);
    expect(hourly).not.toContain('오늘');
  });

  it('방문자·IP 상한은 종전대로 즉시 막는다 — 한 명을 재는 자라 침묵 위험이 없다', async () => {
    rateVerdict.mockResolvedValue({
      ok: false,
      limit: 'visitor',
      response: new Response(JSON.stringify({ error: '너무 빨리' }), { status: 429 }) as never,
    });

    const { res } = await postWidget();

    expect(res.status).toBe(429);
    expect(saveWebMessage).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
  });
});

// ── 저장이 실패하면 답하지 않는다 (I-23) ─────────────
//
// 2026-09-13 프로덕션 실측: Supabase Gateway Timeout 으로 messages insert 가 실패했는데
// 라우트가 null 을 그대로 흘려보내 LLM 을 부르고 답장을 저장했다 — 방문자는 접수된 줄 알고,
// 운영자 받은편지함엔 원문이 없고, insights 에는 message_id NULL 고아 행이 남았다.

describe('위젯 POST — 메시지 저장 실패(I-23)', () => {
  it('저장이 null 이면 503 + 재전송 안내로 끊고 LLM·인사이트·답장 저장을 전부 건너뛴다', async () => {
    saveWebMessage.mockResolvedValue(null);

    const { res, body } = await postWidget('저장에 실패할 제보');

    expect(res.status).toBe(503);
    // 위젯은 `res.data.error` 를 그대로 띄우고 문장·힌트를 입력창에 복구한다(widget.js send()).
    expect(body.error).toBe('try_again');
    expect((body as { message?: string }).message).toBe('Try sending again in a moment');
    expect(callLlm).not.toHaveBeenCalled();
    expect(applyInsightWrite).not.toHaveBeenCalled();
    expect(saveConversationResponse).not.toHaveBeenCalled();
    // 일일 답변 예산은 저장 «뒤»에 올린다 — 실패한 전송이 상한을 먹으면 안 된다.
    expect(rpcMock).not.toHaveBeenCalledWith('bump_bot_usage', expect.anything());
    // 예산 문제도 지식 문제도 아니다 — 「담당자 확인 필요」 배지를 찍을 대화 내용 자체가 없다.
    expect(markConversationEscalated).not.toHaveBeenCalled();
    // I-29 근본 원인 — 저장이 안 됐으면 last_message_at 도 안 올린다. 올리면 빈 미읽음 줄(유령)이 생긴다.
    expect(touchConversation).not.toHaveBeenCalled();
  });

  it('저장이 되면 그 «뒤에» last_message_at 을 올린다 — 순서가 앞이면 유령 대화가 생긴다(I-29)', async () => {
    const order: string[] = [];
    saveWebMessage.mockImplementation(async () => {
      order.push('save');
      return 'msg-1';
    });
    touchConversation.mockImplementation(async () => {
      order.push('touch');
    });

    const { res } = await postWidget('저장될 제보');

    expect(res.status).toBe(200);
    expect(touchConversation).toHaveBeenCalledTimes(1);
    expect(touchConversation).toHaveBeenCalledWith('conv-1');
    expect(order).toEqual(['save', 'touch']);
  });

  it('touch 가 거부돼도 답장은 나간다 — 이미 저장된 메시지를 시각 하나 때문에 버리지 않는다', async () => {
    touchConversation.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { res } = await postWidget('저장될 제보');

    expect(res.status).toBe(200);
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(saveConversationResponse).toHaveBeenCalledTimes(1);
  });

  it('저장이 되면 종전대로 200 이다 (대조군 — 가드가 정상 경로를 막지 않는다)', async () => {
    const { res, body } = await postWidget();

    expect(res.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(applyInsightWrite).toHaveBeenCalledTimes(1);
  });
});

// ── 카카오는 «세기만» 한다 ───────────────────────────
//
// 차단하지 않는 이유 둘: 4초 예산이라 bump RPC 왕복이 폴백 문구를 부를 수 있고,
// 오픈빌더 1:1 채널이라 익명 스크립트가 때릴 수 있는 위젯 POST 와 노출 성격이 다르다.
// 그래도 같은 지갑에서 나가는 호출이라 계측은 한다.

async function postKakao(utterance = '쿠폰함이 안 열려요') {
  // 라우트는 2026-09-14 부터 기본으로 닫혀 있다(서명이 없어서 — I-34). 여기서 검사하려는 것은
  // 「켜져 있을 때 상한을 세는가」이므로 켠 상태로 친다. 닫힌 쪽은 kakao-webhook-gate 가 맡는다.
  vi.stubEnv('KAKAO_WEBHOOK_ENABLED', 'true');
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/kakao/webhook/[botId]/route');

  const req = new NextRequest(`https://feedloop.test/api/kakao/webhook/${BOT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userRequest: { utterance, user: { id: 'kakao-user-1' } },
    }),
  });

  const res = await POST(req, { params: Promise.resolve({ botId: BOT_ID }) });
  return { res, body: (await res.json()) as { template: { outputs: { simpleText: { text: string } }[] } } };
}

describe('카카오 웹훅 — 계측만, 차단 없음', () => {
  it('위젯과 «다른 칸»을 올린다 — 위젯 상한을 잠식하지 않는다', async () => {
    await postKakao();

    expect(rpcMock).toHaveBeenCalledWith('bump_kakao_usage', { p_bot_id: BOT_ID });
    // 같은 칸이면 차단당하지 않는 카카오 트래픽이 차단당하는 위젯의 상한을 먹어치운다.
    expect(rpcMock).not.toHaveBeenCalledWith('bump_bot_usage', { p_bot_id: BOT_ID });
  });

  it('상한을 넘겨도 답이 그대로 나간다 — 카카오는 차단하지 않는다', async () => {
    rpcMock.mockResolvedValue({ data: 9999, error: null });

    const { res, body } = await postKakao();

    expect(res.status).toBe(200);
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(body.template.outputs[0].simpleText.text).toBe('안녕하세요');
  });

  it('계측이 실패해도 답이 그대로 나간다', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { res, body } = await postKakao();

    expect(res.status).toBe(200);
    expect(body.template.outputs[0].simpleText.text).toBe('안녕하세요');
  });
});

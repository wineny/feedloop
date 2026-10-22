import { describe, it, expect, vi, beforeEach } from 'vitest';

// PATCH 한 번이 provider 로 바깥 요청을 하나 낸다. 막지 않으면 이 라우트가
// provider 를 향한 키 대입 시도의 통로가 된다 — 우리 서버 IP 로 나가 시도자는 가려지고,
// 실패 사유 4분류가 그대로 판별 신호가 된다.

const { resolveOwnedBots, encrypt, invalidateBotCache, singleMock } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  encrypt: vi.fn(() => 'enc:ciphertext'),
  invalidateBotCache: vi.fn(),
  singleMock: vi.fn(),
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/utils/crypto', () => ({ encrypt }));
vi.mock('@/lib/bot/core', () => ({ invalidateBotCache }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'update', 'eq']) chain[m] = vi.fn(() => chain);
      chain.single = singleMock;
      return chain;
    },
  }),
}));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-1';
const FAKE_KEY = 'sk-NOTAREALKEY00000000000000000000000';

const BOT_ROW = {
  id: BOT_ID,
  llm_provider: null,
  llm_model: null,
  llm_api_key_encrypted: null,
  llm_key_last4: null,
  llm_key_verified_at: null,
  llm_key_failed_at: null,
  llm_key_failed_reason: null,
  daily_reply_limit: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: USER_ID, botIds: [BOT_ID] });
  singleMock.mockResolvedValue({ data: BOT_ROW, error: null });
  // provider 는 늘 "통하는 키"라고 답한다 — 여기서 보는 건 속도 제한이지 검증이 아니다.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});

async function patchKey() {
  const { NextRequest } = await import('next/server');
  const { PATCH } = await import('@/app/api/bots/[id]/llm-key/route');

  const req = new NextRequest(`https://feedloop.test/api/bots/${BOT_ID}/llm-key`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', key: FAKE_KEY }),
  });

  const res = await PATCH(req, { params: Promise.resolve({ id: BOT_ID }) });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

describe('PATCH /api/bots/[id]/llm-key — 키 확인 속도 제한', () => {
  it('분당 5회까지는 통과하고 6번째가 429 다', async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await patchKey();
      expect(status).toBe(200);
    }

    const sixth = await patchKey();
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toContain('Too many');

    // 막힌 요청은 provider 로 나가지도 않는다 — 그게 이 제한의 요점이다.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(5);
  });

  it('형식이 틀린 키는 한도를 쓰지 않는다 — 오탈자로 사람이 손해를 보면 안 된다', async () => {
    const { NextRequest } = await import('next/server');
    const { PATCH } = await import('@/app/api/bots/[id]/llm-key/route');

    for (let i = 0; i < 8; i++) {
      const req = new NextRequest(`https://feedloop.test/api/bots/${BOT_ID}/llm-key`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', key: 'obviously-wrong' }),
      });
      const res = await PATCH(req, { params: Promise.resolve({ id: BOT_ID }) });
      expect(res.status).toBe(400);
    }

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe('GET /api/bots/[id]/llm-key — failedReason 문장', () => {
  async function getReason(row: Record<string, unknown>) {
    singleMock.mockResolvedValue({ data: { ...BOT_ROW, ...row }, error: null });
    const { GET } = await import('@/app/api/bots/[id]/llm-key/route');
    const res = await GET(new Request(`https://feedloop.test/api/bots/${BOT_ID}/llm-key`), {
      params: Promise.resolve({ id: BOT_ID }),
    });
    return ((await res.json()) as { failedReason: string | null }).failedReason;
  }

  it('모델을 안 골랐으면 추천 기본 모델 ID 를 붙인다(옛 문장과 같다)', async () => {
    const { RECOMMENDED } = await import('@/lib/llm/models');
    const reason = await getReason({ llm_provider: 'openai', llm_model: null, llm_key_failed_reason: 'model_invalid' });
    expect(reason).toBe(`Check the model name: ${RECOMMENDED.openai}`);
  });

  it('고른 모델이 있으면 그 ID 를 붙인다', async () => {
    const reason = await getReason({ llm_provider: 'openai', llm_model: 'gpt-nope', llm_key_failed_reason: 'model_invalid' });
    expect(reason).toBe('Check the model name: gpt-nope');
  });
});

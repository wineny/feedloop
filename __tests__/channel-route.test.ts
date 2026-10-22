import { describe, it, expect, vi, beforeEach } from 'vitest';

// 채널톡 연결 라우트. 여기서 지키는 것은 둘이다.
// ① 자격증명은 한 방향으로만 흐른다 — 어떤 응답에도 키·시크릿이 되돌아 나오지 않는다(원칙 4).
// ② 연결 해제는 «익명화»다 — 사람을 특정하는 값만 지우고 가명 식별자와 본문은 남긴다(U6).

const { resolveOwnedBots, verifyCredentials, generateWebhookToken } = vi.hoisted(() => ({
  resolveOwnedBots: vi.fn(),
  verifyCredentials: vi.fn(),
  generateWebhookToken: vi.fn(() => 'TOKEN-0000000000000000000000000000000000000'),
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots }));
vi.mock('@/lib/channel/client', () => ({ verifyCredentials }));
vi.mock('@/lib/channel/verify', () => ({ generateWebhookToken }));

// 암호화는 «되돌릴 수 있는 표식»으로 대신한다. 평문이 응답에 섞였는지 보려면
// 저장된 값과 평문의 관계가 눈에 보여야 한다.
vi.mock('@/lib/utils/crypto', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => (s.startsWith('enc(') ? s.slice(4, -1) : s),
}));

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: [string, unknown][];
}

let botRow: Record<string, unknown> | null = null;
const updateCalls: UpdateCall[] = [];

function chainWithFilters(record: UpdateCall) {
  const chain: Record<string, unknown> = {};
  chain.eq = vi.fn((col: string, val: unknown) => {
    record.filters.push([col, val]);
    return chain;
  });
  chain.select = vi.fn(() => ({
    single: vi.fn(async () => ({
      data: { id: BOT_ID, pr_mode: record.patch.pr_mode ?? 'approve' },
      error: null,
    })),
  }));
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null });
  return chain;
}

const fromMock = vi.fn((table: string) => ({
  select: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: botRow, error: null }));
    chain.single = vi.fn(async () => ({ data: botRow, error: null }));
    return chain;
  }),
  update: vi.fn((patch: Record<string, unknown>) => {
    const record: UpdateCall = { table, patch, filters: [] };
    updateCalls.push(record);
    return chainWithFilters(record);
  }),
}));

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: fromMock }) }));

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'TESTKEY-a1b2c3';
const SECRET = 'TESTSECRET-a1b2c3';

const VALID_BODY = {
  access_key: KEY,
  access_secret: SECRET,
  channel_slug: 'nullnul',
  channel_id: '123456',
  bot_name: '널널투어 팀',
};

/** 이미 연결된 봇. 키·시크릿·토큰 암호문이 전부 들어 있어 「새어 나가는지」를 볼 수 있다. */
const CONNECTED_BOT = {
  id: BOT_ID,
  channel_slug: 'nullnul',
  channel_id: '123456',
  channel_bot_name: '널널투어 팀',
  channel_connected_at: '2026-09-10T00:00:00Z',
  channel_access_key_encrypted: `enc(${KEY})`,
  channel_access_secret_encrypted: `enc(${SECRET})`,
  channel_webhook_token_encrypted: 'enc(EXISTINGTOKEN-1111111111111111111111111)',
};

beforeEach(() => {
  vi.clearAllMocks();
  botRow = null;
  updateCalls.length = 0;
  resolveOwnedBots.mockResolvedValue({ ok: true, userId: 'u1', botIds: [BOT_ID] });
  verifyCredentials.mockResolvedValue({ ok: true });
  generateWebhookToken.mockReturnValue('TOKEN-0000000000000000000000000000000000000');
});

async function call(
  method: 'PATCH' | 'GET' | 'POST' | 'DELETE',
  { body, query = '' }: { body?: unknown; query?: string } = {},
) {
  vi.resetModules();
  const { NextRequest } = await import('next/server');
  const mod = await import('@/app/api/bots/[id]/channel/route');

  const req = new NextRequest(`https://feedloop.test/api/bots/${BOT_ID}/channel${query}`, {
    method,
    headers: { 'content-type': 'application/json', host: 'feedloop.test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const res = await mod[method](req, { params: Promise.resolve({ id: BOT_ID }) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

describe('인가 — 남의 봇 설정에 손댈 수 없다', () => {
  it('무인증이면 네 메서드 모두 401 이다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    expect((await call('PATCH', { body: VALID_BODY })).status).toBe(401);
    expect((await call('GET')).status).toBe(401);
    expect((await call('POST', { query: '?action=rotate' })).status).toBe(401);
    expect((await call('DELETE')).status).toBe(401);
  });

  it('남의 봇이면 403 이고 아무것도 쓰지 않는다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 403, error: '권한이 없습니다' });

    expect((await call('PATCH', { body: VALID_BODY })).status).toBe(403);
    expect((await call('DELETE')).status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it('무인증 PATCH 는 채널톡에 요청조차 보내지 않는다', async () => {
    resolveOwnedBots.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    await call('PATCH', { body: VALID_BODY });
    expect(verifyCredentials).not.toHaveBeenCalled();
  });
});

describe('PATCH — 저장 전에 검증하고, 키는 되돌려 보내지 않는다', () => {
  it('검증에 실패하면 저장하지 않는다', async () => {
    verifyCredentials.mockResolvedValue({ ok: false, status: 401, message: '키가 올바르지 않습니다' });

    const { status, body } = await call('PATCH', { body: VALID_BODY });
    expect(status).toBe(400);
    expect(body.status).toBe(401);
    expect(updateCalls).toHaveLength(0);
  });

  it('검증 실패 응답에 우리가 보낸 키가 되비치지 않는다', async () => {
    // 채널톡이 에러 본문에 키를 되비추더라도 그대로 옮기지 않는다.
    verifyCredentials.mockResolvedValue({ ok: false, status: 400, message: `bad key: ${KEY}` });

    const { text } = await call('PATCH', { body: VALID_BODY });
    expect(text).not.toContain(SECRET);
  });

  it('성공하면 키·시크릿·토큰을 암호화해 저장한다', async () => {
    const { status, body } = await call('PATCH', { body: VALID_BODY });

    expect(status).toBe(200);
    expect(body.configured).toBe(true);

    const patch = updateCalls[0].patch;
    expect(patch.channel_access_key_encrypted).toBe(`enc(${KEY})`);
    expect(patch.channel_access_secret_encrypted).toBe(`enc(${SECRET})`);
    expect(patch.channel_bot_name).toBe('널널투어 팀');
  });

  it('성공 응답에도 키·시크릿은 없다 — 웹훅 토큰만 예외다', async () => {
    const { text, body } = await call('PATCH', { body: VALID_BODY });

    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
    expect(body.webhookUrl).toContain('/api/channel/webhook/');
  });

  it('검증을 통과하지 못한 입력은 채널톡에 묻지도 않는다', async () => {
    const { status } = await call('PATCH', { body: { ...VALID_BODY, bot_name: '' } });
    expect(status).toBe(400);
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('이미 발급된 토큰은 그대로 둔다 — 이름만 고쳤는데 URL 이 바뀌면 웹훅이 조용히 죽는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { body } = await call('PATCH', { body: { ...VALID_BODY, bot_name: '새 이름' } });

    expect(body.webhookUrl).toContain('EXISTINGTOKEN-1111111111111111111111111');
    expect(generateWebhookToken).not.toHaveBeenCalled();
  });
});

describe('GET — 소유자에게 돌려주는 것과 돌려주지 않는 것', () => {
  it('웹훅 주소는 주고 키·시크릿은 주지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { text, body } = await call('GET');

    expect(body.configured).toBe(true);
    expect(body.webhookUrl).toContain('EXISTINGTOKEN-1111111111111111111111111');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
  });

  it('설정 전에는 configured=false 고 주소가 없다', async () => {
    botRow = {
      id: BOT_ID,
      channel_slug: null,
      channel_id: null,
      channel_bot_name: null,
      channel_connected_at: null,
      channel_access_key_encrypted: null,
      channel_webhook_token_encrypted: null,
    };

    const { body } = await call('GET');
    expect(body.configured).toBe(false);
    expect(body.webhookUrl).toBeNull();
  });
});

describe('POST ?action=verify_token — 채널톡 ?token= 저장·해제', () => {
  const VERIFY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('연결된 봇이면 암호화해 저장하고 값은 되돌려 주지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status, text, body } = await call('POST', {
      query: '?action=verify_token',
      body: { verify_token: VERIFY },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ verifyTokenSet: true });
    expect(text).not.toContain(VERIFY);
    expect(updateCalls[0].patch).toEqual({ channel_webhook_verify_token_encrypted: `enc(${VERIFY})` });
    expect(updateCalls[0].filters).toEqual([['id', BOT_ID]]);
  });

  it('빈 값이면 해제한다(NULL)', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status, body } = await call('POST', {
      query: '?action=verify_token',
      body: { verify_token: '' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ verifyTokenSet: false });
    expect(updateCalls[0].patch).toEqual({ channel_webhook_verify_token_encrypted: null });
  });

  it('형식이 아니면 400 이고 저장하지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status } = await call('POST', {
      query: '?action=verify_token',
      body: { verify_token: '?token=abc def' },
    });

    expect(status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it('연결 전에는 저장할 곳이 없다', async () => {
    botRow = { id: BOT_ID, channel_access_key_encrypted: null };

    const { status } = await call('POST', {
      query: '?action=verify_token',
      body: { verify_token: VERIFY },
    });

    expect(status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it('GET 은 「대조 중인가」 만 말한다', async () => {
    botRow = { ...CONNECTED_BOT, channel_webhook_verify_token_encrypted: `enc(${VERIFY})` };
    const set = await call('GET');
    expect(set.body.verifyTokenSet).toBe(true);
    expect(set.text).not.toContain(VERIFY);

    botRow = { ...CONNECTED_BOT, channel_webhook_verify_token_encrypted: null };
    const unset = await call('GET');
    expect(unset.body.verifyTokenSet).toBe(false);
  });
});

describe('POST ?action=rotate — 주소 회전', () => {
  it('연결된 봇이면 새 토큰으로 바꾼다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status, body } = await call('POST', { query: '?action=rotate' });

    expect(status).toBe(200);
    expect(body.webhookUrl).toContain('TOKEN-0000000000000000000000000000000000000');
    expect(updateCalls[0].patch).toEqual({
      channel_webhook_token_encrypted: 'enc(TOKEN-0000000000000000000000000000000000000)',
      channel_webhook_verify_token_encrypted: null,
    });
  });

  it('회전하면 채널톡 ?token= 대조값도 비운다 — 옛 값이 남으면 재등록 뒤 모든 웹훅이 조용히 404 다', async () => {
    botRow = { ...CONNECTED_BOT, channel_webhook_verify_token_encrypted: 'enc(oldverify0000000000)' };

    const { body } = await call('POST', { query: '?action=rotate' });

    expect(body.verifyTokenSet).toBe(false);
    expect(updateCalls[0].patch.channel_webhook_verify_token_encrypted).toBeNull();
  });

  it('연결 전에는 회전할 것이 없다', async () => {
    botRow = { id: BOT_ID, channel_access_key_encrypted: null };

    const { status } = await call('POST', { query: '?action=rotate' });
    expect(status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it('모르는 action 은 거부한다', async () => {
    const { status } = await call('POST', { query: '?action=nuke' });
    expect(status).toBe(400);
  });
});

// ── 연결 해제 익명화 (수용 기준 44) ─────────────────────
//
// 세 쿼리의 «의미»를 모킹으로 고정한다. 양방향이라 「다 지우기」로는 통과할 수 없다.

describe('DELETE — 익명화', () => {
  async function disconnect() {
    botRow = { ...CONNECTED_BOT };
    const res = await call('DELETE');
    return {
      res,
      bots: updateCalls.find((c) => c.table === 'bots')!,
      convs: updateCalls.find((c) => c.table === 'conversations')!,
      msgs: updateCalls.find((c) => c.table === 'messages')!,
    };
  }

  it('자격증명 3개를 지운다 — 이 시점부터 웹훅도 전송도 죽는다', async () => {
    const { res, bots } = await disconnect();

    expect(res.status).toBe(200);
    expect(bots.patch.channel_access_key_encrypted).toBeNull();
    expect(bots.patch.channel_access_secret_encrypted).toBeNull();
    expect(bots.patch.channel_webhook_token_encrypted).toBeNull();
    expect(bots.patch.channel_webhook_verify_token_encrypted).toBeNull();
  });

  it('① 연락처는 전부 지운다', async () => {
    const { convs } = await disconnect();

    expect(convs.patch.contact_name).toBeNull();
    expect(convs.patch.contact_email).toBeNull();
    expect(convs.patch.contact_phone).toBeNull();
    expect(convs.patch.status).toBe('closed');
  });

  it('② 채널 식별자는 남긴다 — 지우면 되돌림이 두 번 가고 루프 이력이 끊긴다', async () => {
    const { convs } = await disconnect();

    expect(convs.patch).not.toHaveProperty('external_user_id');
    expect(convs.patch).not.toHaveProperty('channel_person_id');
  });

  it('③ 작성자 이름만 치환하고 본문은 건드리지 않는다', async () => {
    const { msgs } = await disconnect();

    expect(msgs.patch).toEqual({ author_name: null });
    expect(msgs.patch).not.toHaveProperty('body');
  });

  it('그 봇의 채널톡 기록에만 건다 — 웹·카카오 대화는 손대지 않는다', async () => {
    const { convs, msgs } = await disconnect();

    expect(convs.filters).toEqual([
      ['bot_id', BOT_ID],
      ['source', 'channel'],
    ]);
    expect(msgs.filters).toEqual([
      ['bot_id', BOT_ID],
      ['source', 'channel'],
    ]);
  });

  it('메시지를 지우지 않는다 — 본문은 인사이트·묶음·PR 의 근거다', async () => {
    await disconnect();
    // update 만 있고 delete 는 없다. 행 수가 줄면 루프 기록 자체가 깨진다.
    for (const call of updateCalls) expect(call.patch).not.toEqual({});
    expect(updateCalls.map((c) => c.table).sort()).toEqual(['bots', 'conversations', 'messages']);
  });
});

// ── 자동 PR 차단 (계획 U4) ─────────────────────────
//
// 채널톡 웹훅은 무인증 입구이고, 토큰은 URL 경로에 있어 요청 로그에 남는다.
// 토큰이 새면 익명 POST → 인사이트 → 묶음 → 크론 → «사람 없이 PR» 까지 사슬이 이어진다.
// 그 사슬을 「사람이 승인」 한 칸으로 끊는다. 두 방향 모두 막아야 뜻이 있다 —
// 연결된 봇에 auto 를 켜는 것도, auto 인 봇에 채널톡을 붙이는 것도.

describe('PATCH /api/bots/[id]/channel — 연결하면 자동 PR 을 내린다', () => {
  it('auto 였으면 approve 로 내리고 그 사실을 응답에 싣는다', async () => {
    botRow = { ...CONNECTED_BOT, pr_mode: 'auto' };

    const { status, body } = await call('PATCH', { body: VALID_BODY });

    expect(status).toBe(200);
    expect(body.prModeChanged).toBe(true);
    expect(updateCalls[0].patch.pr_mode).toBe('approve');
  });

  it('이미 approve 면 건드리지 않고 바꿨다고도 하지 않는다', async () => {
    botRow = { ...CONNECTED_BOT, pr_mode: 'approve' };

    const { body } = await call('PATCH', { body: VALID_BODY });

    expect(body.prModeChanged).toBe(false);
    expect(updateCalls[0].patch).not.toHaveProperty('pr_mode');
  });
});

describe('PATCH /api/bots/[id] — 채널톡이 붙어 있으면 자동 모드를 못 켠다', () => {
  async function patchPrMode(pr_mode: string) {
    vi.resetModules();
    const mod = await import('@/app/api/bots/[id]/route');
    const res = await mod.PATCH(
      new Request(`https://feedloop.test/api/bots/${BOT_ID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pr_mode }),
      }),
      { params: Promise.resolve({ id: BOT_ID }) },
    );
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  }

  it('연결된 봇에 auto 를 걸면 400 이고 저장하지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status, body } = await patchPrMode('auto');

    expect(status).toBe(400);
    expect(body.error).toContain('approve mode');
    expect(updateCalls).toHaveLength(0);
  });

  it('연결 안 된 봇은 종전대로 auto 를 켤 수 있다 — 무회귀', async () => {
    botRow = { id: BOT_ID, channel_access_key_encrypted: null, pr_mode: 'approve' };

    const { status } = await patchPrMode('auto');

    expect(status).toBe(200);
    expect(updateCalls[0].patch).toEqual({ pr_mode: 'auto' });
  });

  it('연결된 봇이어도 approve 로 되돌리는 것은 막지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { status } = await patchPrMode('approve');

    expect(status).toBe(200);
    expect(updateCalls[0].patch).toEqual({ pr_mode: 'approve' });
  });

  it('400 응답에 자격증명이 섞이지 않는다', async () => {
    botRow = { ...CONNECTED_BOT };

    const { text } = await patchPrMode('auto');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
  });
});

describe('입구는 한 번에 하나 — 위젯이 받고 있으면 채널톡을 못 붙인다', () => {
  // 화면은 이미 잠겨 있다(`connect/page.tsx`). 여기 닿는 건 주소를 직접 친 경우라,
  // 서버가 같은 판정을 한 번 더 한다.
  const WIDGET_BOT = { id: BOT_ID, widget_connected_at: '2026-09-19T00:00:00Z' };

  it('위젯이 연결된 봇이면 400 이고 아무것도 쓰지 않는다', async () => {
    botRow = WIDGET_BOT;

    const { status, body } = await call('PATCH', { body: VALID_BODY });
    expect(status).toBe(400);
    expect(body.error).toContain('web widget');
    expect(updateCalls).toHaveLength(0);
  });

  it('거절할 요청으로 채널톡 API 를 두드리지 않는다 — 평문 키를 한 번 더 들고 다닐 이유가 없다', async () => {
    botRow = WIDGET_BOT;

    await call('PATCH', { body: VALID_BODY });
    expect(verifyCredentials).not.toHaveBeenCalled();
  });

  it('위젯 표시가 내려간 봇은 종전대로 저장된다 — 갈아타는 길을 막지 않는다', async () => {
    botRow = { id: BOT_ID, widget_connected_at: null };

    const { status } = await call('PATCH', { body: VALID_BODY });
    expect(status).toBe(200);
    expect(verifyCredentials).toHaveBeenCalled();
  });
});

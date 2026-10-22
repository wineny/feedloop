import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 복호화는 이 테스트의 관심사가 아니다 — 접두만 떼는 가짜로 바꾼다.
vi.mock('@/lib/utils/crypto', () => ({
  decrypt: (v: string) => (v ? v.replace(/^enc:/, '') : ''),
}));

const ACCESS_KEY = 'KEY-8f2c1a9b4d';
const ACCESS_SECRET = 'SECRET-a1b2c3d4e5f6';

let botRow: Record<string, unknown> | null = {
  channel_access_key_encrypted: `enc:${ACCESS_KEY}`,
  channel_access_secret_encrypted: `enc:${ACCESS_SECRET}`,
  channel_bot_name: '널널투어봇',
};

const singleMock = vi.fn(async () => ({ data: botRow, error: botRow ? null : { message: 'none' } }));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: singleMock }) }) }),
  }),
}));

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as unknown as Response;
}

function rejectWith(name: string) {
  return vi.fn(() => {
    const err = new Error('failed');
    err.name = name;
    return Promise.reject(err);
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

let sendBotMessage: typeof import('@/lib/channel/client').sendBotMessage;
let verifyCredentials: typeof import('@/lib/channel/client').verifyCredentials;
let registerWebhook: typeof import('@/lib/channel/client').registerWebhook;
let deleteWebhook: typeof import('@/lib/channel/client').deleteWebhook;
let ChannelNotConfirmedError: typeof import('@/lib/channel/client').ChannelNotConfirmedError;

beforeEach(async () => {
  vi.resetModules();
  botRow = {
    channel_access_key_encrypted: `enc:${ACCESS_KEY}`,
    channel_access_secret_encrypted: `enc:${ACCESS_SECRET}`,
    channel_bot_name: '널널투어봇',
  };
  singleMock.mockClear();
  fetchMock = vi.fn(async () => jsonResponse(200, { message: 'ok' }));
  global.fetch = fetchMock as unknown as typeof fetch;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  ({ sendBotMessage, verifyCredentials, registerWebhook, deleteWebhook, ChannelNotConfirmedError } =
    await import('@/lib/channel/client'));
});

afterEach(() => {
  errorSpy.mockRestore();
});

/** 로그로 나간 모든 문자열을 한 줄로 이어 붙인다. 시크릿 검사에 쓴다. */
function loggedText(): string {
  const calls = errorSpy.mock.calls as unknown[][];
  return calls.map((c) => c.map(String).join(' ')).join('\n');
}

describe('sendBotMessage', () => {
  it('유저챗 메시지 엔드포인트에 순수 텍스트로 보낸다 — 채널톡은 마크다운을 해석하지 않는다', async () => {
    const body = '요청하신 "쿠폰함" 이 반영됐어요. (PR #5) https://github.com/a/b/pull/5';
    const result = await sendBotMessage('bot-1', 'chat-9', body);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.channel.io/open/v5/user-chats/chat-9/messages');
    expect(url).toContain(`botName=${encodeURIComponent('널널투어봇')}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ plainText: body });
  });

  it('자격증명을 헤더로만 보낸다 — URL 에는 싣지 않는다', async () => {
    await sendBotMessage('bot-1', 'chat-9', '안녕하세요');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-access-key']).toBe(ACCESS_KEY);
    expect(headers['x-access-secret']).toBe(ACCESS_SECRET);
    expect(url).not.toContain(ACCESS_KEY);
    expect(url).not.toContain(ACCESS_SECRET);
  });

  it('유저챗 id 를 URL 인코딩한다 — 남이 준 값이 경로를 바꾸면 안 된다', async () => {
    await sendBotMessage('bot-1', '../../channels/999', '안녕하세요');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('user-chats/..%2F..%2Fchannels%2F999/messages');
  });

  it('401 이면 status 와 채널톡 문구를 그대로 돌려준다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized' }));
    const result = await sendBotMessage('bot-1', 'chat-9', '안녕하세요');
    expect(result).toEqual({ ok: false, status: 401, message: 'Unauthorized' });
  });

  it('타임아웃과 네트워크 실패는 status 0 으로 구분해 말한다', async () => {
    global.fetch = rejectWith('AbortError') as unknown as typeof fetch;
    expect(await sendBotMessage('bot-1', 'chat-9', 'x')).toEqual({
      ok: false,
      status: 0,
      message: 'Send timed out',
    });

    global.fetch = rejectWith('TypeError') as unknown as typeof fetch;
    expect(await sendBotMessage('bot-1', 'chat-9', 'x')).toEqual({
      ok: false,
      status: 0,
      message: 'Send failed',
    });
  });

  it('자격증명이 없으면 부르지 않는다 — 설정이 덜 된 것을 설정이 덜 됐다고 말한다', async () => {
    botRow = { channel_access_key_encrypted: null, channel_access_secret_encrypted: null };
    const result = await sendBotMessage('bot-1', 'chat-9', 'x');
    expect(result).toEqual({ ok: false, status: 0, message: 'Channel Talk credentials are not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('봇 이름이 없으면 부르지 않는다 — 400 으로 재시도 횟수만 태우게 두지 않는다', async () => {
    botRow = {
      channel_access_key_encrypted: `enc:${ACCESS_KEY}`,
      channel_access_secret_encrypted: `enc:${ACCESS_SECRET}`,
      channel_bot_name: null,
    };
    const result = await sendBotMessage('bot-1', 'chat-9', 'x');
    expect(result).toEqual({ ok: false, status: 0, message: 'The bot name to send as is not set' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('자격증명은 결과·로그로 되돌아 나오지 않는다 (원칙 4)', () => {
  it('채널톡이 시크릿을 되비춰도 결과에서 지운다 — 이 값은 DB 와 화면으로 나간다', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { message: `bad header x-access-secret=${ACCESS_SECRET}` }),
    );
    const result = await sendBotMessage('bot-1', 'chat-9', 'x');

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ACCESS_SECRET);
    expect(serialized).not.toContain(ACCESS_KEY);
    expect(serialized).toContain('[redacted]');
  });

  it('로그에는 봇 접두와 status 만 남는다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: ACCESS_SECRET }));
    await sendBotMessage('bot-1', 'chat-9', 'x');

    const logged = loggedText();
    expect(logged).toContain('[channel/bot-1]');
    expect(logged).toContain('status=500');
    expect(logged).not.toContain(ACCESS_SECRET);
    expect(logged).not.toContain(ACCESS_KEY);
  });
});

describe('verifyCredentials', () => {
  it('가벼운 읽기 1회로 확인한다 — 저장 전에 키가 통하는지 본다', async () => {
    const result = await verifyCredentials(ACCESS_KEY, ACCESS_SECRET);
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.channel.io/open/v5/user-chats?limit=1');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-access-key']).toBe(ACCESS_KEY);
  });

  it('키가 틀리면 401 을 돌려주고 시크릿을 싣지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    const result = await verifyCredentials(ACCESS_KEY, ACCESS_SECRET);
    expect(result).toEqual({ ok: false, status: 401, message: 'The key is not valid' });
    expect(JSON.stringify(result)).not.toContain(ACCESS_SECRET);
  });

  it('둘 중 하나라도 비면 부르지 않는다', async () => {
    expect(await verifyCredentials('', ACCESS_SECRET)).toEqual({
      ok: false,
      status: 0,
      message: 'Both the key and the secret are required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('웹훅 CRUD — 아직 확인되지 않았다', () => {
  it('추측한 경로로 남의 채널에 요청하지 않고 시끄럽게 멈춘다', async () => {
    await expect(registerWebhook()).rejects.toBeInstanceOf(ChannelNotConfirmedError);
    await expect(deleteWebhook()).rejects.toThrow(/NOT_CONFIRMED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { validateChannelInput, validateVerifyTokenInput, buildDeskUrl } from '@/lib/bot/channel-registration';

// 화면의 검증은 curl 로 우회된다. 서버가 다시 보는 그 자리를 여기서 고정한다.

const VALID = {
  access_key: 'TESTKEY-a1b2c3',
  access_secret: 'TESTSECRET-a1b2c3',
  channel_slug: 'nullnul',
  channel_id: '123456',
  bot_name: '널널투어 팀',
};

function err(body: unknown): string {
  const r = validateChannelInput(body);
  if (r.ok) throw new Error('통과하면 안 되는 입력이 통과했다');
  return r.error;
}

describe('validateChannelInput — 필수 네 값', () => {
  it('온전한 입력은 다듬어서 통과시킨다', () => {
    const r = validateChannelInput({ ...VALID, access_key: '  TESTKEY-a1b2c3  ' });
    expect(r).toEqual({ ok: true, values: { ...VALID } });
  });

  it('키·시크릿·채널 주소가 없으면 막는다 — 없으면 아무것도 할 수 없다', () => {
    expect(err({ ...VALID, access_key: '   ' })).toContain('액세스 키');
    expect(err({ ...VALID, access_secret: undefined })).toContain('액세스 시크릿');
    expect(err({ ...VALID, channel_slug: null })).toContain('채널 주소');
  });

  it('봇 이름이 없으면 막는다 — 없으면 되돌림이 영원히 안 나간다', () => {
    // 전송 API 가 ?botName= 을 요구해서, 비면 sendBotMessage 가 fetch 도 못 하고 실패한다.
    // 루프의 마지막 칸이 조용히 비는 것이라 연결 시점에 막아야 한다.
    expect(err({ ...VALID, bot_name: '  ' })).toContain('봇 이름');
  });

  it('channel_id 만 선택이다 — 페이로드에 실리는지가 미확인이라 대조는 가능할 때만 한다', () => {
    const r = validateChannelInput({
      access_key: VALID.access_key,
      access_secret: VALID.access_secret,
      channel_slug: VALID.channel_slug,
      bot_name: VALID.bot_name,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.channel_id).toBeNull();
  });

  it('객체가 아닌 몸통은 형식 오류다', () => {
    expect(err(null)).toBe('잘못된 요청 형식입니다');
    expect(err('key=abc')).toBe('잘못된 요청 형식입니다');
    expect(err([VALID])).toBe('잘못된 요청 형식입니다');
  });

  it('문자열이 아닌 값은 타입 오류로 막는다', () => {
    expect(err({ ...VALID, access_key: 12345 })).toContain('문자열');
  });
});

describe('validateChannelInput — 채널 주소는 앵커된 슬러그만', () => {
  it('경로·프로토콜이 섞이면 막는다 — 데스크 링크에 그대로 박히는 값이다', () => {
    for (const bad of [
      'nullnul/../evil',
      'https://desk.channel.io/nullnul',
      'null nul',
      'NullNul',
      'nullnul?x=1',
      'nullnul#frag',
    ]) {
      expect(err({ ...VALID, channel_slug: bad })).toContain('채널 주소');
    }
  });

  it('영문 소문자·숫자·하이픈은 통과한다', () => {
    for (const good of ['nullnul', 'null-nul-2', 'a', '123']) {
      expect(validateChannelInput({ ...VALID, channel_slug: good }).ok).toBe(true);
    }
  });
});

describe('validateChannelInput — 길이 상한', () => {
  it('키 200자·시크릿 200자·슬러그 64자·채널ID 64자·봇 이름 40자를 넘기면 막는다', () => {
    expect(err({ ...VALID, access_key: 'k'.repeat(201) })).toContain('200자');
    expect(err({ ...VALID, access_secret: 's'.repeat(201) })).toContain('200자');
    expect(err({ ...VALID, channel_slug: 'a'.repeat(65) })).toContain('64자');
    expect(err({ ...VALID, channel_id: '1'.repeat(65) })).toContain('64자');
    expect(err({ ...VALID, bot_name: '이'.repeat(41) })).toContain('40자');
  });

  it('상한 정확히까지는 통과한다', () => {
    expect(validateChannelInput({ ...VALID, access_key: 'k'.repeat(200) }).ok).toBe(true);
    expect(validateChannelInput({ ...VALID, channel_slug: 'a'.repeat(64) }).ok).toBe(true);
  });
});

describe('buildDeskUrl — 답장 창구로 가는 링크', () => {
  it('슬러그와 chatId 가 있으면 그 유저챗을 연다', () => {
    expect(buildDeskUrl('nullnul', 'chat-77')).toBe(
      'https://desk.channel.io/nullnul/user-chats/chat-77',
    );
  });

  it('chatId 를 모르면 그 채널의 데스크로 보낸다', () => {
    expect(buildDeskUrl('nullnul', null)).toBe('https://desk.channel.io/nullnul');
  });

  it('슬러그를 모르면 데스크 첫 화면으로 — 링크가 막다른 길이 되지 않게', () => {
    expect(buildDeskUrl(null, 'chat-77')).toBe('https://desk.channel.io');
    expect(buildDeskUrl(undefined, null)).toBe('https://desk.channel.io');
  });

  it('chatId 를 인코딩한다 — 페이로드에서 온 값이 경로를 벗어나면 안 된다', () => {
    // 채널톡이 준 200자 문자열이다. 그대로 이으면 운영자가 엉뚱한 주소로 간다.
    expect(buildDeskUrl('nullnul', '../../admin')).toBe(
      'https://desk.channel.io/nullnul/user-chats/..%2F..%2Fadmin',
    );
    expect(buildDeskUrl('nullnul', 'a?b#c')).toBe(
      'https://desk.channel.io/nullnul/user-chats/a%3Fb%23c',
    );
    // 정상 id 는 그대로 남는다 — 인코딩이 평소 링크를 망가뜨리지 않는다.
    expect(buildDeskUrl('nullnul', 'chat-77')).toBe(
      'https://desk.channel.io/nullnul/user-chats/chat-77',
    );
  });
});

describe('validateVerifyTokenInput — 채널톡이 보여준 ?token= 값', () => {
  it('실계정 형식(32hex)을 받는다', () => {
    const r = validateVerifyTokenInput({ verify_token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    expect(r).toEqual({ ok: true, value: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  });

  it('앞뒤 공백은 지운다 — 대화상자에서 복사하면 따라오는 경우가 있다', () => {
    const r = validateVerifyTokenInput({ verify_token: '  a1b2c3d4e5f60718293a4b5c6d7e8f90\n' });
    expect(r).toEqual({ ok: true, value: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });
  });

  it('빈 값·누락은 「해제」다', () => {
    expect(validateVerifyTokenInput({ verify_token: '' })).toEqual({ ok: true, value: null });
    expect(validateVerifyTokenInput({ verify_token: '   ' })).toEqual({ ok: true, value: null });
    expect(validateVerifyTokenInput({})).toEqual({ ok: true, value: null });
  });

  it('URL·공백·너무 짧은 값·문자열 아닌 값은 막는다', () => {
    for (const bad of ['?token=abc', 'has space', 'abc', 'x'.repeat(129), 42, ['a']]) {
      expect(validateVerifyTokenInput({ verify_token: bad }).ok).toBe(false);
    }
  });

  it('본문이 객체가 아니면 막는다', () => {
    expect(validateVerifyTokenInput(null).ok).toBe(false);
    expect(validateVerifyTokenInput('str').ok).toBe(false);
    expect(validateVerifyTokenInput([]).ok).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseChannelEvent,
  personKeyFor,
  readChannelId,
  MAX_ID_CHARS,
  type ChannelMessageEvent,
  type ChannelUserChatEvent,
  type ChannelUserEvent,
} from '@/lib/channel/payload';

// 이 파서가 읽는 건 전부 무인증 경로로 들어온 남의 JSON 이다.
// "채널톡이 보냈으니 이 모양일 것" 을 전제하지 않는지 확인한다.

function messagePayload(entity: Record<string, unknown>) {
  return { event: 'push', type: 'Message', entity };
}

const BASE_MESSAGE = {
  id: 'msg-1',
  chatId: 'chat-1',
  chatType: 'userChat',
  personType: 'user',
  personId: 'person-1',
  plainText: '쿠폰함이 안 열려요',
  createdAt: 1757400000000,
};

describe('parseChannelEvent — Message', () => {
  it('메시지 이벤트를 판별 유니온으로 읽는다', () => {
    const ev = parseChannelEvent(messagePayload(BASE_MESSAGE)) as ChannelMessageEvent;
    expect(ev.kind).toBe('message');
    expect(ev.chatId).toBe('chat-1');
    expect(ev.messageId).toBe('msg-1');
    expect(ev.chatType).toBe('userChat');
    expect(ev.personType).toBe('user');
    expect(ev.personId).toBe('person-1');
    expect(ev.plainText).toBe('쿠폰함이 안 열려요');
  });

  it('chatId 나 messageId 가 없으면 null — 저장도 멱등도 걸 수 없다', () => {
    expect(parseChannelEvent(messagePayload({ ...BASE_MESSAGE, chatId: undefined }))).toBeNull();
    expect(parseChannelEvent(messagePayload({ ...BASE_MESSAGE, id: undefined }))).toBeNull();
    expect(parseChannelEvent(messagePayload({ ...BASE_MESSAGE, chatId: 123 }))).toBeNull();
  });

  it('본문을 2000자에서 자른다 — 무인증 경로라 길이를 믿지 않는다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, plainText: 'ㄱ'.repeat(5000) }),
    ) as ChannelMessageEvent;
    expect(ev.plainText).toHaveLength(2000);
  });

  it('식별자를 200자에서 자른다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, personId: 'p'.repeat(500) }),
    ) as ChannelMessageEvent;
    expect(ev.personId).toHaveLength(MAX_ID_CHARS);
  });

  it('식별자의 제어문자를 지운다 — 로그·URL 을 오염시킬 수 있다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, chatId: 'chat\u0007-1\n' }),
    ) as ChannelMessageEvent;
    expect(ev.chatId).toBe('chat-1');
  });

  it('본문의 줄바꿈·탭은 남기고 나머지 제어문자만 지운다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, plainText: '첫 줄\n둘째\t줄\u0007끝' }),
    ) as ChannelMessageEvent;
    expect(ev.plainText).toBe('첫 줄\n둘째\t줄끝');
  });

  it('파일만 보낸 메시지(plainText 없음)는 빈 문자열이다 — 호출부가 무시한다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, plainText: undefined }),
    ) as ChannelMessageEvent;
    expect(ev.plainText).toBe('');
  });

  it('chatType 을 판단하지 않고 그대로 싣는다 — group 차단은 라우트의 몫이다', () => {
    const ev = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, chatType: 'group' }),
    ) as ChannelMessageEvent;
    expect(ev.chatType).toBe('group');
  });

  it('createdAt 이 epoch 밀리초면 ISO 로 바꾸고, 해석 불가면 null 이다', () => {
    const ok = parseChannelEvent(messagePayload(BASE_MESSAGE)) as ChannelMessageEvent;
    expect(ok.createdAt).toBe(new Date(1757400000000).toISOString());

    const bad = parseChannelEvent(
      messagePayload({ ...BASE_MESSAGE, createdAt: 'not-a-date' }),
    ) as ChannelMessageEvent;
    expect(bad.createdAt).toBeNull();
  });
});

describe('parseChannelEvent — 실계정 페이로드 (2026-09-10 gpters 채널 v5 실물)', () => {
  // ngrok 인스펙터로 받은 실제 웹훅에서 사람을 특정하는 값만 지웠다. `type` 이 소문자다.
  const real = {
    event: 'push',
    type: 'message',
    entity: {
      chatKey: 'userChat-6aa274bf2ebcd69cf0f2',
      id: '6aa274cc9b0e0295c862',
      channelId: '145384',
      chatType: 'userChat',
      chatId: '6aa274bf2ebcd69cf0f2',
      personType: 'user',
      personId: '6a98fc330dc56adbd166',
      createdAt: 1789031628635,
      plainText: '쿠폰을 받았는데 사용도 전에 만료 일자로 되어 있는데 확인해주실 수 있나요?',
      blocks: [{ type: 'text', value: '쿠폰을 받았는데 사용도 전에 만료 일자로 되어 있는데 확인해주실 수 있나요?' }],
    },
    refers: {
      userChat: { id: '6aa274bf2ebcd69cf0f2', channelId: '145384', state: 'initial', userId: '6a98fc330dc56adbd166', name: '푸딩 109' },
      user: { id: '6a98fc330dc56adbd166', channelId: '145384', name: '푸딩 109', named: false, member: false },
    },
  };

  it('소문자 type: "message" 를 메시지 이벤트로 읽는다 (대문자 Message 만 받던 결함)', () => {
    const ev = parseChannelEvent(real);
    expect(ev?.kind).toBe('message');
    if (ev?.kind !== 'message') return;
    expect(ev.chatId).toBe('6aa274bf2ebcd69cf0f2');
    expect(ev.messageId).toBe('6aa274cc9b0e0295c862');
    expect(ev.personType).toBe('user');
    expect(ev.personId).toBe('6a98fc330dc56adbd166');
    expect(ev.createdAt).toBe(new Date(1789031628635).toISOString());
  });

  it('채널 id 를 entity.channelId 에서 읽는다', () => {
    expect(readChannelId(real)).toBe('145384');
  });

  it('유저챗 상태를 refers.userChat.state 에서 읽는다 — 닫힘 스코프가 없어 이 값이 유일한 통로다', () => {
    const ev = parseChannelEvent(real);
    if (ev?.kind !== 'message') throw new Error('message 여야 한다');
    expect(ev.chatState).toBe('initial');

    const closed = { ...real, refers: { ...real.refers, userChat: { ...real.refers.userChat, state: 'closed' } } };
    const closedEv = parseChannelEvent(closed);
    if (closedEv?.kind !== 'message') throw new Error('message 여야 한다');
    expect(closedEv.chatState).toBe('closed');

    const noRefers = parseChannelEvent({ ...real, refers: undefined });
    if (noRefers?.kind !== 'message') throw new Error('message 여야 한다');
    expect(noRefers.chatState).toBeNull();
  });

  it('첫 메시지 뒤에 오는 로그 메시지(plainText 없음, log.action=open)는 빈 본문으로 읽힌다', () => {
    const log = { ...real, entity: { ...real.entity, id: '6aa274ccbd3ae6a663de', plainText: undefined, blocks: undefined, log: { action: 'open' } } };
    const ev = parseChannelEvent(log);
    expect(ev?.kind).toBe('message');
    if (ev?.kind === 'message') expect(ev.plainText).toBe('');
  });

  it('대문자 표기도 계속 받는다', () => {
    expect(parseChannelEvent({ ...real, type: 'Message' })?.kind).toBe('message');
    expect(parseChannelEvent({ event: 'push', type: 'UserChat', entity: { id: 'c1' }, refers: {} })?.kind).toBe('userChat');
  });
});

describe('parseChannelEvent — UserChat · User', () => {
  it('refers.user 에서 연락처를 읽고 출처를 user 로 남긴다', () => {
    const ev = parseChannelEvent({
      type: 'UserChat',
      entity: { id: 'chat-9', state: 'opened' },
      refers: { user: { id: 'person-9', name: '김널널', email: 'a@b.com', mobileNumber: '01000000000' } },
    }) as ChannelUserChatEvent;

    expect(ev.kind).toBe('userChat');
    expect(ev.chatId).toBe('chat-9');
    expect(ev.state).toBe('opened');
    expect(ev.personId).toBe('person-9');
    expect(ev.contact).toEqual({
      name: '김널널',
      email: 'a@b.com',
      phone: '01000000000',
      contactSource: 'user',
    });
  });

  it('refers.veil 이면 출처가 veil 이다 — 검증되지 않은 값임을 화면이 말할 수 있어야 한다', () => {
    const ev = parseChannelEvent({
      type: 'UserChat',
      entity: { id: 'chat-10' },
      refers: { veil: { id: 'veil-3', profile: { name: '익명손님' } } },
    }) as ChannelUserChatEvent;

    expect(ev.contact?.contactSource).toBe('veil');
    expect(ev.contact?.name).toBe('익명손님');
    expect(ev.personId).toBe('veil-3');
  });

  it('유저챗 엔티티에 chatType 이 없으면 userChat 으로 읽는다', () => {
    const ev = parseChannelEvent({
      type: 'UserChat',
      entity: { id: 'chat-11' },
    }) as ChannelUserChatEvent;
    expect(ev.chatType).toBe('userChat');
    expect(ev.contact).toBeNull();
  });

  it('User 이벤트는 연락처만 읽는다', () => {
    const ev = parseChannelEvent({
      type: 'User',
      entity: { id: 'person-12', name: '이피드', email: 'c@d.com' },
    }) as ChannelUserEvent;

    expect(ev.kind).toBe('user');
    expect(ev.personId).toBe('person-12');
    expect(ev.contact?.name).toBe('이피드');
  });
});

describe('parseChannelEvent — 판별 불가', () => {
  it('알 수 없는 type 은 null 이다', () => {
    expect(parseChannelEvent({ type: 'Manager', entity: { id: 'x' } })).toBeNull();
    expect(parseChannelEvent({ type: 42, entity: {} })).toBeNull();
    expect(parseChannelEvent({ entity: {} })).toBeNull();
  });

  it('객체가 아닌 본문은 null 이다', () => {
    for (const bad of [null, undefined, 'string', 42, [], true]) {
      expect(parseChannelEvent(bad)).toBeNull();
    }
  });
});

describe('personKeyFor — 되돌림을 사람당 1건으로 접는 키', () => {
  it('personId 가 있으면 그것을 쓴다', () => {
    expect(personKeyFor({ personId: 'person-1', chatId: 'chat-1' })).toBe('person-1');
  });

  it('personId 가 없으면 chat: 폴백으로 채운다 — NULL 을 남기지 않는다', () => {
    expect(personKeyFor({ personId: null, chatId: 'chat-1' })).toBe('chat:chat-1');
    expect(personKeyFor({ chatId: 'chat-1' })).toBe('chat:chat-1');
  });

  it('폴백은 결정적이다 — 같은 챗은 몇 번을 불러도 같은 키다', () => {
    const a = personKeyFor({ personId: null, chatId: 'chat-42' });
    const b = personKeyFor({ personId: undefined, chatId: 'chat-42' });
    expect(a).toBe(b);
    expect(a).toBe('chat:chat-42');
  });

  it('챗도 사람도 모르면 null 이다 — 지어내지 않는다', () => {
    expect(personKeyFor({ personId: null, chatId: null })).toBeNull();
    expect(personKeyFor({})).toBeNull();
  });
});

describe('readChannelId', () => {
  it('루트와 entity 두 자리를 본다', () => {
    expect(readChannelId({ channelId: 'ch-1' })).toBe('ch-1');
    expect(readChannelId({ entity: { channelId: 'ch-2' } })).toBe('ch-2');
  });

  it('없으면 null — 없는 근거로 검사를 켜지 않는다', () => {
    expect(readChannelId({ entity: {} })).toBeNull();
    expect(readChannelId('nope')).toBeNull();
  });
});

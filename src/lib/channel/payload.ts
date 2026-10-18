// 채널톡(Channel.io) 웹훅 페이로드 파서.
//
// 이 값들은 무인증 경로로 들어온다. 시크릿 세그먼트가 앞을 막아도, 본문 자체는
// 스키마가 보증되지 않은 남의 JSON 이다 — 필드마다 타입을 확인하고, 길이를 자르고,
// 제어문자를 지운다. 판별할 수 없는 것은 조용히 버린다(`null`).
//
// 페이로드 모양: `{ event, type, entity, refers }`
//  - `type: 'message'`  메시지 생성. entity 에 chatId·chatType·personType·plainText·channelId,
//                       refers 에 userChat(state 포함)·user. **실계정은 소문자** 로 보낸다(대소문자 무시)
//  - `type: 'userChat'` 유저챗 생성/갱신. entity.id 가 chatId, refers 에 user 또는 veil
//  - `type: 'user'`     유저 upsert. 연락처만 갱신한다

import { MAX_BODY_CHARS } from '@/lib/widget/http';

/** 식별자·연락처 필드의 상한. 본문(2000자)과 달리 길 이유가 없다. */
export const MAX_ID_CHARS = 200;

/** `user` = 채널톡이 아는 유저, `veil` = 익명. veil 의 이름·이메일은 검증되지 않은 값이다. */
export type ChannelContactSource = 'user' | 'veil';

export interface ChannelContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  contactSource: ChannelContactSource;
}

export interface ChannelMessageEvent {
  kind: 'message';
  chatId: string;
  /** `userChat` 만 처리한다. `group` 은 봇 메시지 전송 API 의 대상이 아니다. */
  chatType: string;
  /** `user` | `manager` | `bot`. bot 은 ALF 답변이라 기록하지 않는다. */
  personType: string;
  personId: string | null;
  /** 빈 문자열일 수 있다 — 파일만 보낸 메시지. 호출부가 무시한다. */
  plainText: string;
  messageId: string;
  createdAt: string | null;
  /**
   * `refers.userChat.state` — `initial` | `opened` | `closed`.
   * 채널톡에는 닫힘 스코프가 없어(실측 E8) 유저챗이 닫혔다는 사실은 **이 값으로만** 알 수 있다.
   * 메시지마다 실려 오므로, 닫힌 채팅에 상담원이 마지막 말을 남기면 그때 닫힘이 전해진다.
   */
  chatState: string | null;
}

export interface ChannelUserChatEvent {
  kind: 'userChat';
  chatId: string;
  chatType: string;
  personId: string | null;
  /** `opened` | `closed` 등. 오지 않을 수 있다(스코프에 없으면 영영 안 온다). */
  state: string | null;
  contact: ChannelContact | null;
}

export interface ChannelUserEvent {
  kind: 'user';
  personId: string | null;
  contact: ChannelContact | null;
}

export type ChannelEvent = ChannelMessageEvent | ChannelUserChatEvent | ChannelUserEvent;

// ── 원시값 정리 ─────────────────────────────────────

/** 제어문자를 지운다. 줄바꿈·탭은 본문에서 의미가 있으므로 선택적으로 남긴다. */
function stripControl(value: string, keepWhitespace: boolean): string {
  // 줄바꿈(\n)·캐리지리턴(\r)·탭(\t)만 예외로 남길 수 있다. 나머지 C0·DEL 은 전부 지운다.
  const re = keepWhitespace
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
    : /[\u0000-\u001F\u007F]/g;
  return value.replace(re, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 식별자 한 칸. 문자열이 아니거나 비면 null. */
function readId(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const raw = source[key];
  if (typeof raw !== 'string') return null;
  const cleaned = stripControl(raw, false).trim().slice(0, MAX_ID_CHARS);
  return cleaned.length > 0 ? cleaned : null;
}

/** 여러 후보 중 처음 잡히는 것. 채널톡이 필드를 어디에 싣는지 확정되지 않은 자리에 쓴다. */
function firstId(candidates: Array<string | null>): string | null {
  for (const c of candidates) if (c) return c;
  return null;
}

function readText(source: Record<string, unknown> | null, key: string, max: number): string | null {
  if (!source) return null;
  const raw = source[key];
  if (typeof raw !== 'string') return null;
  const cleaned = stripControl(raw, true).slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

// ── 연락처 ─────────────────────────────────────────

/**
 * `refers.user` 또는 `refers.veil` 에서 연락처를 꺼낸다.
 * 어느 쪽에서 왔는지를 `contactSource` 로 남겨, 화면이 「검증되지 않은 값」임을 말할 수 있게 한다.
 */
function readContact(
  entity: Record<string, unknown> | null,
  source: ChannelContactSource,
): ChannelContact | null {
  if (!entity) return null;
  const profile = asRecord(entity.profile);

  const name =
    readText(entity, 'name', MAX_ID_CHARS) ?? readText(profile, 'name', MAX_ID_CHARS) ?? null;
  const email =
    readText(entity, 'email', MAX_ID_CHARS) ?? readText(profile, 'email', MAX_ID_CHARS) ?? null;
  const phone =
    readText(entity, 'mobileNumber', MAX_ID_CHARS) ??
    readText(entity, 'phoneNumber', MAX_ID_CHARS) ??
    readText(profile, 'mobileNumber', MAX_ID_CHARS) ??
    null;

  if (!name && !email && !phone) return null;
  return { name, email, phone, contactSource: source };
}

/** `refers` 에서 사람 정보를 고른다. user 가 있으면 user, 없으면 veil(익명). */
function readRefers(refers: Record<string, unknown> | null): {
  contact: ChannelContact | null;
  personId: string | null;
} {
  const user = asRecord(refers?.user);
  if (user) {
    return { contact: readContact(user, 'user'), personId: readId(user, 'id') };
  }
  const veil = asRecord(refers?.veil);
  if (veil) {
    return { contact: readContact(veil, 'veil'), personId: readId(veil, 'id') };
  }
  return { contact: null, personId: null };
}

// ── 파싱 ───────────────────────────────────────────

/**
 * 페이로드를 판별 유니온으로 바꾼다. 알 수 없는 `type`, 구조가 깨진 본문,
 * 식별자가 없는 이벤트는 전부 `null` 이다 — 호출부는 200 을 주고 아무것도 만들지 않는다.
 */
export function parseChannelEvent(raw: unknown): ChannelEvent | null {
  const root = asRecord(raw);
  if (!root) return null;

  // ⚠️ 실계정(2026-09-10, gpters 채널 v5)은 `type` 을 **소문자** 로 보낸다 — `message`·`userChat`·`user`,
  //    `event` 는 `push`. 문서 예시의 `Message` 만 보다가 실웹훅 3건이 전부 `unknown_type` 으로
  //    버려졌다. 대소문자를 접어 두 표기를 다 받는다.
  const type = typeof root.type === 'string' ? root.type.toLowerCase() : null;
  const entity = asRecord(root.entity);
  const refers = asRecord(root.refers);

  if (type === 'message') return parseMessage(entity, refers);
  if (type === 'userchat') return parseUserChat(entity, refers);
  if (type === 'user') return parseUser(entity, refers);
  return null;
}

function parseMessage(
  entity: Record<string, unknown> | null,
  refers: Record<string, unknown> | null,
): ChannelMessageEvent | null {
  if (!entity) return null;

  const chatId = readId(entity, 'chatId');
  const messageId = readId(entity, 'id');
  // 둘 중 하나라도 없으면 저장할 수도, 멱등을 걸 수도 없다.
  if (!chatId || !messageId) return null;

  const chatType = readId(entity, 'chatType') ?? '';
  const personType = readId(entity, 'personType') ?? '';

  return {
    kind: 'message',
    chatId,
    chatType,
    personType,
    personId: readId(entity, 'personId'),
    plainText: readText(entity, 'plainText', MAX_BODY_CHARS) ?? '',
    messageId,
    createdAt: readCreatedAt(entity),
    chatState: readId(asRecord(refers?.userChat), 'state'),
  };
}

/**
 * 채널톡은 `createdAt` 을 epoch 밀리초(숫자)로 보낸다. 문자열로 오는 경우도 받아 둔다.
 * 해석할 수 없으면 null — 없는 시각을 지어내지 않는다.
 */
function readCreatedAt(entity: Record<string, unknown>): string | null {
  const raw = entity.createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function parseUserChat(
  entity: Record<string, unknown> | null,
  refers: Record<string, unknown> | null,
): ChannelUserChatEvent | null {
  if (!entity) return null;

  const chatId = readId(entity, 'id');
  if (!chatId) return null;

  const fromRefers = readRefers(refers);

  return {
    kind: 'userChat',
    chatId,
    // 유저챗 엔티티에는 chatType 이 없다. 엔티티 자체가 유저챗이므로 그렇게 읽는다.
    chatType: readId(entity, 'chatType') ?? 'userChat',
    personId: firstId([readId(entity, 'userId'), fromRefers.personId]),
    state: readId(entity, 'state'),
    contact: fromRefers.contact,
  };
}

function parseUser(
  entity: Record<string, unknown> | null,
  refers: Record<string, unknown> | null,
): ChannelUserEvent | null {
  const fromEntity = entity ? readContact(entity, 'user') : null;
  const fromRefers = readRefers(refers);

  const personId = firstId([readId(entity, 'id'), fromRefers.personId]);
  const contact = fromEntity ?? fromRefers.contact;

  if (!personId && !contact) return null;
  return { kind: 'user', personId, contact };
}

// ── person 키 ───────────────────────────────────────

/**
 * 되돌림을 «사람당 1건» 으로 접는 키.
 *
 * personId 가 없으면 `'chat:' + chatId` 로 채운다. 폴백이 결정적이라 같은 챗은 재실행에도
 * 같은 키를 얻는다. NULL 을 남기면 같은 사람의 챗 2개가 서로 다른 키를 갖고 되돌림이
 * 두 번 나간다 — 없애려던 바로 그 실패다(설계 §3-(a)).
 *
 * 챗도 사람도 모르는 이벤트(User 이벤트에 personId 가 없는 경우)만 `null` 이다.
 */
export function personKeyFor(ev: {
  personId?: string | null;
  chatId?: string | null;
}): string | null {
  if (ev.personId) return ev.personId;
  if (ev.chatId) return `chat:${ev.chatId}`;
  return null;
}

/**
 * 페이로드가 실어 보낸 채널 id. 있으면 봇에 저장된 값과 대조한다(설계 §3-(c) B).
 * 어디에 실리는지가 확정되지 않아 두 자리를 본다.
 */
export function readChannelId(raw: unknown): string | null {
  const root = asRecord(raw);
  if (!root) return null;
  return firstId([readId(root, 'channelId'), readId(asRecord(root.entity), 'channelId')]);
}

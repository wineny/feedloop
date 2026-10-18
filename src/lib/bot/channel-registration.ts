// 채널톡 연결 — 입력 검증과 데스크 링크.
//
// 원칙 4(자격증명은 한 방향으로만 흐른다)를 지키는 자리라 여기서는 «검증» 과 «주소 조립» 만 한다.
// 평문 키를 만드는 함수도, 되돌려주는 함수도 이 파일에 두지 않는다.

import { getServiceRoleClient } from '@/lib/supabase';

/** 채널톡 상담 데스크. 운영자 답장은 늘 여기 한 곳에서 한다(§3-(d) A). */
const DESK_ORIGIN = 'https://desk.channel.io';

/**
 * 그 유저챗을 여는 데스크 주소.
 *
 * slug 를 모르면 데스크 첫 화면으로 보낸다 — 링크가 아예 없는 것보다 낫고,
 * 「채널톡에서 답하세요」라는 안내가 막다른 길이 되지 않는다.
 */
export function buildDeskUrl(slug: string | null | undefined, chatId: string | null): string {
  if (!slug) return DESK_ORIGIN;
  if (!chatId) return `${DESK_ORIGIN}/${slug}`;
  // chatId 는 채널톡 페이로드에서 온 값이다. 그대로 이으면 `/`·`?`·`#`·`..` 이 경로에 박혀
  // 운영자를 엉뚱한 주소로 보낸다. slug 는 우리 정규식을 통과한 값이라 손대지 않는다.
  return `${DESK_ORIGIN}/${slug}/user-chats/${encodeURIComponent(chatId)}`;
}

/** 대화 하나에 대한 데스크 주소. bots.channel_slug 한 칸만 읽는다. */
export async function getChannelDeskUrl(
  botId: string,
  externalUserId: string | null,
): Promise<string> {
  const { data } = await getServiceRoleClient()
    .from('bots')
    .select('channel_slug')
    .eq('id', botId)
    .maybeSingle();
  return buildDeskUrl((data as { channel_slug?: string | null } | null)?.channel_slug, externalUserId);
}

// ── 연결 입력 검증 ────────────────────────────────────
//
// 화면의 zod 는 curl 로 우회되므로 서버가 다시 본다(registration.ts 와 같은 이유).
// 여기서 보는 값 중 둘은 특별히 위험하다.
// - access_key·access_secret: 채널톡을 향한 자격증명이다. 검증에 통과한 것만 암호화해 저장하고,
//   어떤 경로로도 되돌려 내보내지 않는다(원칙 4).
// - channel_slug: 운영자 화면의 데스크 링크에 그대로 박힌다. 슬러그 문법 밖 문자를 받으면
//   `https://desk.channel.io/<임의 경로>` 로 사람을 보내는 링크가 된다. 앵커된 형태만 받는다.

export const CHANNEL_SLUG_RE = /^[a-z0-9-]{1,64}$/;

export interface ChannelValues {
  access_key: string;
  access_secret: string;
  channel_slug: string;
  channel_id: string | null;
  bot_name: string;
}

export type ChannelInputResult = { ok: true; values: ChannelValues } | { ok: false; error: string };

const CHANNEL_LIMITS = {
  access_key: 200,
  access_secret: 200,
  channel_slug: 64,
  channel_id: 64,
  bot_name: 40,
} as const;

function trimmedString(
  raw: unknown,
  label: string,
  max: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 은(는) 문자열이어야 합니다` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, error: `${label} 은(는) ${max}자까지 입력할 수 있습니다` };
  return { ok: true, value: trimmed };
}

/**
 * 채널톡 연결 입력.
 *
 * 필수는 넷이다.
 * - access_key·access_secret: 없으면 채널톡에 아무것도 물어볼 수 없다
 * - channel_slug: 없으면 「데스크에서 답장하기」가 막다른 링크가 된다
 * - bot_name: 전송 API 가 `?botName=` 을 요구해서, 비어 있으면 `sendBotMessage` 가
 *   fetch 조차 못 하고 실패한다(client.ts:145). 그러면 **되돌림이 영원히 안 나간다** —
 *   루프의 마지막 칸이 조용히 비는 것이라 연결 시점에 막는다
 *
 * channel_id 만 선택이다. 페이로드에 `channelId` 가 실리는지가 확인되지 않아
 * 대조(§3-(c) B)를 «가능할 때만» 하기 때문이다.
 */
export function validateChannelInput(body: unknown): ChannelInputResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '잘못된 요청 형식입니다' };
  }
  const input = body as Record<string, unknown>;

  const key = trimmedString(input.access_key, '액세스 키', CHANNEL_LIMITS.access_key);
  if (!key.ok) return key;
  if (!key.value) return { ok: false, error: '액세스 키를 입력해 주세요' };

  const secret = trimmedString(input.access_secret, '액세스 시크릿', CHANNEL_LIMITS.access_secret);
  if (!secret.ok) return secret;
  if (!secret.value) return { ok: false, error: '액세스 시크릿을 입력해 주세요' };

  const slug = trimmedString(input.channel_slug, '채널 주소', CHANNEL_LIMITS.channel_slug);
  if (!slug.ok) return slug;
  if (!slug.value) return { ok: false, error: '채널 주소를 입력해 주세요' };
  if (!CHANNEL_SLUG_RE.test(slug.value)) {
    return { ok: false, error: '채널 주소는 영문 소문자·숫자·하이픈만 쓸 수 있습니다' };
  }

  const channelId = trimmedString(input.channel_id, '채널 ID', CHANNEL_LIMITS.channel_id);
  if (!channelId.ok) return channelId;

  const botName = trimmedString(input.bot_name, '봇 이름', CHANNEL_LIMITS.bot_name);
  if (!botName.ok) return botName;
  if (!botName.value) return { ok: false, error: '봇 이름을 입력해 주세요' };

  return {
    ok: true,
    values: {
      access_key: key.value,
      access_secret: secret.value,
      channel_slug: slug.value,
      channel_id: channelId.value,
      bot_name: botName.value,
    },
  };
}

// ── 채널톡 웹훅 토큰(?token=) 입력 ───────────────────
//
// 채널톡이 웹훅 등록 직후 보여주는 32hex 값이다. 형식을 넓게 받는다 — 실계정은 32hex 였지만
// 채널톡이 형식을 바꿔도 운영자가 붙여넣은 값을 우리가 거절할 이유는 없다. URL·공백·제어문자만 막는다.
// 빈 값은 「대조 해제」다.

export const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

export type VerifyTokenInputResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export function validateVerifyTokenInput(body: unknown): VerifyTokenInputResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: '잘못된 요청 형식입니다' };
  }
  const raw = (body as Record<string, unknown>).verify_token;
  const token = trimmedString(raw, '웹훅 토큰', 128);
  if (!token.ok) return token;
  if (!token.value) return { ok: true, value: null };
  if (!VERIFY_TOKEN_RE.test(token.value)) {
    return { ok: false, error: '웹훅 토큰은 영문·숫자·하이픈·밑줄 8~128자입니다. 채널톡이 보여준 값을 그대로 붙여넣어 주세요' };
  }
  return { ok: true, value: token.value };
}

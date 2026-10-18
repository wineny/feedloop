// 채널톡 Open API 클라이언트.
//
// 우리가 이 채널로 보내는 것은 **되돌림 하나뿐**이다(원칙 2). 즉답도, 상담도 하지 않는다 —
// 그건 채널톡 ALF 와 상담원의 몫이다.
//
// 자격증명은 한 방향으로만 흐른다(원칙 4). 복호화된 평문은 `loadChannelCredentials` 안에서
// 나서 fetch 헤더로 들어가고 끝난다 — 이 모듈 밖으로 export 하지 않고, 반환값·로그·에러
// 어디에도 싣지 않는다. 로그는 `[channel/{botId}]` 접두와 status 뿐이다. URL 에는 토큰이
// 없지만 쿼리·헤더·바디를 통째로 찍는 습관이 생기면 언젠가 시크릿이 함께 나간다.

import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt } from '@/lib/utils/crypto';

const API_BASE = 'https://api.channel.io/open/v5';

/** 전송 1건의 상한. 되돌림은 크론·버튼의 공유 예산 안에서 도므로 짧아야 한다. */
export const DEFAULT_TIMEOUT_MS = 3000;

/** `status: 0` 은 HTTP 응답을 못 받았다는 뜻이다 — 타임아웃·네트워크 실패·설정 누락. */
export type ChannelApiResult = { ok: true } | { ok: false; status: number; message: string };

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/**
 * 확인되지 않은 API 를 부르려 할 때 던진다. 추측한 경로로 남의 채널에 요청을 날리는 것보다
 * 시끄럽게 멈추는 편이 낫다.
 */
export class ChannelNotConfirmedError extends Error {
  constructor(what: string) {
    super(`NOT_CONFIRMED: ${what}`);
    this.name = 'ChannelNotConfirmedError';
  }
}

interface ChannelCredentials {
  accessKey: string;
  accessSecret: string;
  botName: string | null;
}

/**
 * ⚠️ **export 하지 않는다.** 복호화된 평문이 이 모듈을 벗어나지 않게 하는 유일한 장치다.
 * 밖에서 필요해 보이면 그 일을 이 파일 안으로 가져오는 게 맞다.
 */
async function loadChannelCredentials(botId: string): Promise<ChannelCredentials | null> {
  const { data, error } = await db()
    .from('bots')
    .select('channel_access_key_encrypted, channel_access_secret_encrypted, channel_bot_name')
    .eq('id', botId)
    .single();

  if (error || !data) {
    console.error(`[channel/${botId}] credentials lookup failed`);
    return null;
  }

  const accessKey = data.channel_access_key_encrypted
    ? decrypt(data.channel_access_key_encrypted)
    : '';
  const accessSecret = data.channel_access_secret_encrypted
    ? decrypt(data.channel_access_secret_encrypted)
    : '';

  if (!accessKey || !accessSecret) return null;
  return { accessKey, accessSecret, botName: data.channel_bot_name ?? null };
}

/**
 * 응답 본문에서 사람이 읽을 한 줄만 뽑는다. 통째로 싣지 않는 이유는 그 안에 무엇이
 * 들어 있을지 우리가 정하지 않기 때문이다 — 200자에서 자른다.
 */
function readApiMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body === 'object' && body !== null) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === 'string') return m.slice(0, 200);
  }
  return '';
}

/**
 * 자격증명 문자열이 결과에 섞여 들어가는 경로를 구조적으로 막는다.
 *
 * 지금 코드로는 섞일 자리가 없지만, 「없을 것이다」는 시간이 지나면 틀린다.
 * 채널톡이 우리가 보낸 헤더를 에러 본문에 되비추기만 해도 그대로 DB(`delivery_error`)와
 * 화면으로 나간다. 나가는 문 하나에서 한 번 더 지운다.
 */
function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | { status: 0; body: null; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network';
    return { status: 0, body: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 되돌림 한 건을 유저챗에 보낸다.
 *
 * 채널톡은 마크다운을 해석하지 않는다 — 순수 텍스트로 보낸다. 링크는 그대로 두면
 * 채널톡이 알아서 클릭 가능하게 만든다.
 *
 * `botName` 이 없으면 **부르지 않는다.** 전송 API 가 그걸 쿼리로 요구하고, 없이 보내면
 * 400 을 받아 delivery_attempts 만 태운다. 설정이 덜 된 것을 설정이 덜 됐다고 말한다.
 */
export async function sendBotMessage(
  botId: string,
  userChatId: string,
  plainText: string,
  opts: { timeoutMs?: number } = {},
): Promise<ChannelApiResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const creds = await loadChannelCredentials(botId);
  if (!creds) {
    return { ok: false, status: 0, message: '채널 자격증명이 설정되지 않았습니다' };
  }
  if (!creds.botName) {
    return { ok: false, status: 0, message: '보낼 봇 이름이 설정되지 않았습니다' };
  }

  const url =
    `${API_BASE}/user-chats/${encodeURIComponent(userChatId)}/messages` +
    `?botName=${encodeURIComponent(creds.botName)}`;

  const res = await requestJson(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-access-key': creds.accessKey,
        'x-access-secret': creds.accessSecret,
      },
      body: JSON.stringify({ plainText }),
    },
    timeoutMs,
  );

  const secrets = [creds.accessKey, creds.accessSecret];

  if (res.status === 0) {
    const reason = 'reason' in res ? res.reason : 'network';
    console.error(`[channel/${botId}] send failed: ${reason}`);
    return { ok: false, status: 0, message: reason === 'timeout' ? '전송 시간 초과' : '전송 실패' };
  }

  if (res.status >= 200 && res.status < 300) return { ok: true };

  const message = redact(readApiMessage(res.body), secrets);
  console.error(`[channel/${botId}] send rejected: status=${res.status}`);
  return { ok: false, status: res.status, message: message || `전송이 거부됐습니다 (${res.status})` };
}

/**
 * 저장하기 전에 키가 실제로 통하는지 가벼운 읽기 1회로 본다.
 * 실패하면 저장하지 않는다 — 안 통하는 키를 넣어 두면 되돌림이 조용히 실패한다.
 *
 * 키를 **인자로 받는다.** 아직 DB 에 없는 값을 검증하는 자리라서다.
 */
export async function verifyCredentials(
  accessKey: string,
  accessSecret: string,
  opts: { timeoutMs?: number } = {},
): Promise<ChannelApiResult> {
  if (!accessKey || !accessSecret) {
    return { ok: false, status: 0, message: '키와 시크릿이 모두 필요합니다' };
  }

  const res = await requestJson(
    `${API_BASE}/user-chats?limit=1`,
    {
      method: 'GET',
      headers: { 'x-access-key': accessKey, 'x-access-secret': accessSecret },
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (res.status === 0) {
    const reason = 'reason' in res ? res.reason : 'network';
    console.error(`[channel] credential check failed: ${reason}`);
    return {
      ok: false,
      status: 0,
      message: reason === 'timeout' ? '채널톡 응답 시간 초과' : '채널톡에 연결하지 못했습니다',
    };
  }

  if (res.status >= 200 && res.status < 300) return { ok: true };

  const message = redact(readApiMessage(res.body), [accessKey, accessSecret]);
  console.error(`[channel] credential check rejected: status=${res.status}`);
  return {
    ok: false,
    status: res.status,
    message: message || (res.status === 401 ? '키가 올바르지 않습니다' : `확인 실패 (${res.status})`),
  };
}

// ── 미확인 ─────────────────────────────────────────
//
// 웹훅 등록 API 의 정확한 경로와 스코프 값이 공식 문서에서 확인되지 않았다(브리프 22행).
// 추측해 부르면 실계정에서 조용히 실패하거나 엉뚱한 것을 만든다. 확인될 때까지 던진다 —
// 그때까지 고객은 연결 화면에서 URL 을 복사해 직접 등록한다(설계 §3-(f) A).

export async function registerWebhook(): Promise<never> {
  throw new ChannelNotConfirmedError('웹훅 등록 API 의 경로·스코프 값이 실계정에서 확인되지 않았다');
}

export async function deleteWebhook(): Promise<never> {
  throw new ChannelNotConfirmedError('웹훅 삭제 API 의 경로가 실계정에서 확인되지 않았다');
}

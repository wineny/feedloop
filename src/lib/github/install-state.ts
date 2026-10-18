// 설치 URL 에 실어 보내고 setup URL 로 되돌아오는 `state` — «어느 봇을 연결하려던 것인가»의 힌트 (의존성: node:crypto 만).
//
// 이 값은 인가가 아니다. 되돌아온 요청은 세션으로 소유를 다시 확인하고, 설치 여부는 봇 레포로 GitHub 에 묻는다.
// state 가 하는 일은 하나 — 봇이 여럿일 때 어느 봇 화면으로 돌려보낼지 고르는 것. 그래서 위조돼도 얻을 게 없고,
// 그래도 서명하는 이유는 「남의 botId 를 넣은 링크」로 그 봇 화면으로 유도하는 장난을 막기 위해서다.
//
// GitHub 이 state 를 setup URL 에 그대로 넘겨주는지는 공식 문서에 없다(2026-09-13 확인). 안 넘어오면
// setup 라우트가 «세션 유저의 봇 전부»를 후보로 삼아 같은 판정을 한다 — state 없이도 동작한다.

import { createHmac, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 30 * 60 * 1000;

export interface InstallState {
  botId: string;
  userId: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function signInstallState(state: InstallState, secret: string, now: number = Date.now()): string {
  const payload = b64url(Buffer.from(JSON.stringify({ b: state.botId, u: state.userId, e: now + STATE_TTL_MS }), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

/** 서명·만료가 맞으면 내용을, 아니면 null. 예외를 던지지 않는다 — 호출부는 null 이면 «힌트 없음»으로 진행한다 */
export function verifyInstallState(token: string | null | undefined, secret: string, now: number = Date.now()): InstallState | null {
  if (!token || typeof token !== 'string' || token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { b?: unknown; u?: unknown; e?: unknown };
    if (typeof parsed.b !== 'string' || typeof parsed.u !== 'string' || typeof parsed.e !== 'number') return null;
    if (parsed.e < now) return null;
    return { botId: parsed.b, userId: parsed.u };
  } catch {
    return null;
  }
}

/** state 서명 비밀. NEXTAUTH_SECRET 이 세션 서명에 이미 쓰이므로 같은 것을 쓴다 — 비밀을 하나 더 늘리지 않는다 */
export function installStateSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.NEXTAUTH_SECRET?.trim();
  return s ? s : null;
}

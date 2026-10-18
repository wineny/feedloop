// 채널톡 웹훅의 신원 확인.
//
// 채널톡의 공식 서명 방식은 확인되지 않았다(설계 §3-(c)). 그동안의 대안은 **URL 시크릿
// 세그먼트**다 — `POST /api/channel/webhook/{botId}/{token}`. 봇 id 만 아는 제3자를 막는다.
//
// 정직한 한계: 토큰이 URL 경로에 있으므로 Vercel 요청 로그에 남는다. 그래서 이 토큰의
// 권한은 「그 봇에 메시지 쓰기」 하나뿐이고, 연결 화면이 회전 버튼을 상시 노출한다.
//
// 서명 헤더가 확인되면 이 파일에 `verifySignature()` 를 더하고 «서명 우선, 없으면 토큰» 으로
// 간다. 라우트는 이 모듈만 부르므로 교체면이 여기 하나로 닫혀 있다.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { decrypt } from '@/lib/utils/crypto';

/** URL 세그먼트로 안전한 토큰. 32바이트를 base64url 로 — 43자. */
export function generateWebhookToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 토큰 형식만 본다. 값 비교는 `matchesWebhookToken` 이 한다. */
export function isWebhookTokenShape(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/**
 * 제시된 토큰이 그 봇의 것인가.
 *
 * 길이가 다르면 `timingSafeEqual` 이 던지므로, 두 값을 SHA-256 으로 고정 길이로 만든 뒤
 * 비교한다. 길이 불일치를 먼저 반환하면 길이 자체가 새어 나간다.
 *
 * 복호화가 실패하면 `false` 다. 암호문 손상은 `decrypt` 가 빈 문자열로 돌려주고,
 * 키 설정 오류는 던진다 — 어느 쪽이든 통과시키지 않는다. 다만 **키 오류는 조용히 넘어가면
 * 「토큰이 틀렸다」로 보이므로** 값 없이 한 줄 남긴다.
 */
export function matchesWebhookToken(
  presented: string | null | undefined,
  encrypted: string | null | undefined,
  keyHex?: string,
): boolean {
  if (!presented || !encrypted) return false;

  let expected = '';
  try {
    expected = decrypt(encrypted, keyHex);
  } catch (err) {
    console.error(
      '[channel] webhook token decrypt failed (encryption key config?):',
      err instanceof Error ? err.name : 'unknown',
    );
    return false;
  }
  if (!expected) return false;

  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * 페이로드의 채널 id 가 이 봇에 저장된 것과 맞는가.
 *
 * **둘 중 하나라도 없으면 검사하지 않는다(`true`).** 채널톡이 `channelId` 를 싣는지가
 * 확인되지 않았고, 운영자가 채널 id 를 아직 저장하지 않았을 수도 있다. 없는 근거로
 * 정상 웹훅을 404 로 떨어뜨리면 원인을 찾기가 매우 어렵다 — 확인 가능할 때만 확인한다.
 */
export function matchesChannelId(
  payloadChannelId: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!payloadChannelId || !stored) return true;
  return payloadChannelId === stored;
}

/**
 * 채널톡이 `?token=` 으로 붙여 보내는 웹훅 토큰이 운영자가 저장한 것과 맞는가.
 *
 * 실계정(2026-09-10 E2)에서 서명 헤더는 없고 이 쿼리 토큰만 확인됐다. 채널톡이 웹훅 등록
 * 직후 대화상자에 한 번 보여주는 값이라 운영자가 붙여넣어야 우리가 안다.
 *
 * **저장된 값이 없으면 대조하지 않는다(`true`).** 선택 항목이라, 안 넣은 운영자의 정상 웹훅을
 * 떨어뜨리면 원인을 찾기 어렵다(`matchesChannelId` 와 같은 태도). 저장돼 있으면 제시값이
 * 없거나 달라도 전부 `false` 다 — 그때부터는 URL 세그먼트 하나로는 들어올 수 없다.
 *
 * 무엇을 막는가: **복사한 웹훅 URL·화면 캡처의 유출.** 요청 로그(Vercel·Next dev)는 쿼리도 함께
 * 남기므로 로그 유출에는 겹이 되지 않는다 — 그 통로는 「주소 새로 만들기」 회전으로 막는다.
 */
export function matchesVerifyToken(
  presented: string | null | undefined,
  encrypted: string | null | undefined,
  keyHex?: string,
): boolean {
  if (!encrypted) return true;
  return matchesWebhookToken(presented, encrypted, keyHex);
}

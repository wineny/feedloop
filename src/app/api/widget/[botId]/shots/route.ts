// 「화면에서 선택하기」 스크린샷 업로드 (I-55, 2026-09-25) — 무인증, CORS 개방.
//
// 본문 = 이미지 바이너리, `?visitorId=`. 응답은 `{shotId}` 하나 — 이미지 URL 은 돌려주지 않는다
// (방문자가 남의 이미지를 볼 경로를 만들지 않는다). 메시지에 붙이는 건 messages POST 가 한다.
//
// 저장 비용 공격면이라 관문이 겹겹이다: 봇 검증 → IP 상한 → 방문자 분당 5장·봇 하루 300장(fail-closed)
// → 1MB → 매직 바이트로 WebP·JPEG 판정(Content-Type 안 믿음) → 가로세로 2560.
// 막히면 위젯은 「화면은 담지 못했어요 · 위치는 함께 보내요」로 위치만 보낸다 — 방문자가 잃는 건 없다.

import { NextRequest } from 'next/server';
import { checkReadRate, isUuid, resolveWidgetBot, widgetError, widgetJson, widgetOptions } from '@/lib/widget/http';
import { MAX_SHOT_BYTES, detectShotImage } from '@/lib/widget/shot-image';
import { checkShotRate, storeShot } from '@/lib/widget/shots';

export const OPTIONS = widgetOptions;

async function readBoundedBytes(req: NextRequest): Promise<Uint8Array | 'too_large' | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_SHOT_BYTES) return 'too_large';
  if (!req.body) return null;
  // 선언값은 위조·생략될 수 있다 — 읽으면서 센다. 넘는 순간 멈춰 메모리에 더 올리지 않는다.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_SHOT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError(req, 'bot_not_found', 404);

  const visitorId = req.nextUrl.searchParams.get('visitorId');
  if (!isUuid(visitorId)) return widgetError(req, 'invalid_visitor', 400);

  // IP 상한(인메모리)만 먼저 — 방문자·봇 상한은 이 표를 세는 전용 계수가 본다.
  // 메시지 계수(checkWriteRate)를 안 쓰는 이유: 그건 messages 행을 센다. 촬영은 발화가 아니다.
  const ipBlocked = checkReadRate(req);
  if (ipBlocked) return ipBlocked;

  const limit = await checkShotRate(botId, visitorId);
  if (limit) return widgetError(req, 'shot_busy', 429);

  const bytes = await readBoundedBytes(req);
  if (bytes === 'too_large') return widgetError(req, 'shot_too_large', 413);
  if (!bytes || bytes.length === 0) return widgetError(req, 'shot_empty', 400);

  const info = detectShotImage(bytes);
  if (!info) return widgetError(req, 'shot_unsupported', 415);

  // 상한은 저장소에서 «잠그고 세고 예약»으로 한 번 더 본다 — 위의 계수는 본문을 읽기 전 값싼 조기 거절일 뿐이고,
  // 동시 요청은 그걸 다 같이 통과한다(보안 리뷰 M1)
  const stored = await storeShot({ botId, visitorId, bytes, info });
  if (!stored.ok) {
    return stored.limit
      ? widgetError(req, 'shot_busy', 429)
      : widgetError(req, 'shot_save_failed', 500);
  }

  return widgetJson({ shotId: stored.id }, 201);
}

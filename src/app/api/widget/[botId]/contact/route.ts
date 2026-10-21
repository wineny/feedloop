// 위젯의 "연락처 남기기" — 무인증, CORS 개방.
// 로그인을 강제하지 않는 대신, 답장 받을 곳을 방문자가 직접 남긴다.

import { NextRequest } from 'next/server';
import { widgetLocale } from '@/lib/widget/strings';
import { upsertConversation, saveContact, touchConversation } from '@/lib/bot/conversations';
import { collapseWhitespace } from '@/lib/text';
import {
  checkWriteRate,
  isUuid,
  readJsonBody,
  resolveWidgetBot,
  widgetError,
  widgetJson,
  widgetOptions,
} from '@/lib/widget/http';

const MAX_FIELD = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const OPTIONS = widgetOptions;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError(req, 'bot_not_found', 404);

  const body = await readJsonBody<{
    visitorId?: unknown;
    name?: unknown;
    email?: unknown;
    phone?: unknown;
  }>(req);
  if (!body.ok) return body.response;
  const payload = body.value;

  const { visitorId } = payload;
  if (!isUuid(visitorId)) return widgetError(req, 'invalid_visitor', 400);

  // ⚠️ `.trim()` 만으로는 부족하다 — 앞뒤 공백만 없애고 **내부 개행은 남긴다**.
  // 이 값(`name`)은 `messages.author_name` 으로 저장돼 분류 프롬프트에 실리는데,
  // 거기서 개행은 «레코드 경계»를 뜻한다. 무인증 경로라 방문자가 이름 칸 하나로
  // 남의 제보를 지어낸 레코드를 끼워 넣을 수 있었다. 조립 쪽(batch.ts)에서 JSON 으로
  // 막았지만, 출처에서도 접는다 — 값이 프롬프트 말고 어디로 흘러갈지 여기서는 모른다.
  const field = (v: unknown) => {
    if (typeof v !== 'string') return undefined;
    const clean = collapseWhitespace(v).slice(0, MAX_FIELD);
    return clean !== '' ? clean : undefined;
  };

  const name = field(payload.name);
  const email = field(payload.email);
  const phone = field(payload.phone);

  if (!name && !email && !phone) return widgetError(req, 'contact_empty', 400);
  if (email && !EMAIL_RE.test(email)) return widgetError(req, 'email_invalid', 400);

  const limited = await checkWriteRate(req, botId, visitorId);
  if (limited) return limited;

  const conversation = await upsertConversation({
    botId,
    source: 'web',
    externalUserId: visitorId,
    locale: widgetLocale(req),
  });
  if (!conversation) return widgetError(req, 'conversation_failed', 500);

  const saved = await saveContact(conversation.id, { name, email, phone });
  if (!saved) return widgetError(req, 'contact_save_failed', 500);
  // 연락처가 «실제로 남은 뒤» 시각을 찍는다 — 운영자가 볼 리드가 생겼으니 미읽음·상단으로(2026-09-17 ny).
  // upsert 만 성공하고 여기서 실패한 행은 시각이 없어 목록 맨 뒤·미읽음 꺼짐으로 남는다.
  await touchConversation(conversation.id);

  return widgetJson({ ok: true, contact: { name, email, phone } });
}

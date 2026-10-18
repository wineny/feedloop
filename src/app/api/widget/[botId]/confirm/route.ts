import { NextRequest, after } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { emailOwnerHandoff } from '@/lib/email/notify';
import { checkReadRate, checkWriteRate, isUuid, readJsonBody, resolveWidgetBot, widgetError, widgetJson, widgetOptions } from '@/lib/widget/http';

export const OPTIONS = widgetOptions;

async function handle(req: NextRequest, botId: string, payload: unknown, write: boolean) {
  if (!isUuid(botId)) return widgetError('잘못된 봇 주소입니다', 400);
  if (!payload || typeof payload !== 'object') return widgetError('잘못된 요청입니다', 400);
  const { visitorId, responseId, confirmation } = payload as Record<string, unknown>;
  if (!isUuid(visitorId) || !isUuid(responseId) || (write && confirmation !== 'fixed' && confirmation !== 'not_fixed')) {
    return widgetError('확인 요청 형식이 올바르지 않습니다', 400);
  }
  if (!await resolveWidgetBot(botId)) return widgetError('봇을 찾을 수 없습니다', 404);
  // GET 도 공짜가 아니다 — 아래 RPC 를 한 번 돌린다. 예전엔 이 검사가 `write` 분기 «안»에만
  // 있어 읽기 경로의 상한이 사실상 0 이었다. 읽기는 저장되는 발화가 없어 방문자·봇 계수가
  // 애초에 안 움직이므로(둘 다 `messages` 행을 센다) IP 상한만 건다.
  const limited = write ? await checkWriteRate(req, botId, visitorId) : checkReadRate(req);
  if (limited) return limited;
  const { data, error } = await getServiceRoleClient().rpc('confirm_widget_resolution', {
    p_bot_id: botId, p_visitor_id: visitorId, p_response_id: responseId,
    p_confirmation: write ? confirmation : null,
  });
  if (error) return widgetError('확인 내용을 저장하거나 불러오지 못했습니다. 다시 시도해 주세요.', 503);
  if (!data) return widgetError('확인할 응답을 찾을 수 없습니다', 404);

  // 「아직 그대로예요」는 **고쳤다고 보낸 것이 안 고쳐졌다**는 신호다. RPC 가 대화 escalated_at 과
  // 묶음 follow_up_pending 을 이미 찍지만, 그것만으로는 운영자가 화면을 열어야 안다.
  //
  // `changed === false` 면 건너뛴다 — 같은 값을 다시 받은 것이라 알릴 새 소식이 없다.
  // 발송기의 상한이 메일 자체는 막지만, 거기 닿기까지 DB 왕복 5회와 배타 잠금 2개가 매번 돈다.
  // **이 라우트에는 방문자 속도제한이 사실상 없다** — `visitorRateExceeded` 가 `messages` 행을
  // 세는데 확인 요청은 메시지를 만들지 않아서다(IP 60회/분만 남는다).
  //
  // ⚠️ 이 알림은 「상담원 연결」과 **같은 슬롯**을 쓴다(대화당 1시간 1통 · 봇당 10통/시).
  // 방향이 하나 더 있다 — 확인이 슬롯을 먼저 먹으면, 같은 방문자가 곧이어 재현 절차를 적어
  // 「상담원 연결」을 눌러도 **그 글은 메일로 안 간다.** 받은편지함 배지(`escalated_at`)는 뜨므로
  // 「정본은 받은편지함」이라는 기존 결정과는 어긋나지 않는다. 캡을 가르는 건 하지 않았다.
  //
  // `!== false` 인 이유: `changed` 는 마이그레이션 `20260916_01` 이 더한 칸이다. 그 전 RPC 는
  // 이 키가 없어 `undefined` 인데, 그때 «안 보내는» 쪽으로 기울면 마이그레이션을 잊은 배포에서
  // 알림이 조용히 멎는다. 없으면 종전대로 보내고(상한이 막는다), 있으면 정확해진다.
  if (write && confirmation === 'not_fixed' && data.confirmation === 'not_fixed' && data.changed !== false) {
    after(notifyOwnerNotFixed(botId, responseId));
  }

  return widgetJson(data, 200, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
}

/**
 * 「아직 안 고쳐졌다」를 봇 소유자에게 알린다. 절대 throw 하지 않는다 —
 * 방문자의 확인은 이미 저장됐고, 메일은 부수 경로다.
 */
async function notifyOwnerNotFixed(botId: string, responseId: string) {
  try {
    const { data } = await getServiceRoleClient()
      .from('responses')
      .select('conversation_id')
      .eq('id', responseId)
      .eq('bot_id', botId)
      .maybeSingle();
    const conversationId = data?.conversation_id as string | null | undefined;
    if (!conversationId) return;
    // requestBody 를 비우면 발송기가 «최근 8턴 중 마지막 방문자 발화»를 인용한다(fallbackQuote).
    // 「원래 제보」가 아니다 — 제보 뒤 「감사합니다」 한마디만 있어도 그게 실린다. 메일 제목도
    // 그래서 「남긴 마지막 말」이다. 진짜 원래 제보를 실으려면 run → insight → 원문을 타야 한다.
    await emailOwnerHandoff({ botId, conversationId, requestBody: null, kind: 'not_fixed' });
  } catch (err) {
    console.error('[confirm] owner notify failed:', err instanceof Error ? err.message : err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const body = await readJsonBody<unknown>(req);
  if (!body.ok) return body.response;
  return handle(req, (await params).botId, body.value, true);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  return handle(req, (await params).botId, Object.fromEntries(req.nextUrl.searchParams), false);
}

// 라이브 데모 「내 제보 추적」 — 로그인 없이 «제보 하나»의 진행만 돌려준다.
//
// 랜딩의 [라이브 데모] 팝업이 iframe 안 위젯에서 `postMessage` 로 받은 제보 id 를 들고 여기를 친다.
// 심사위원이 손을 대는 유일한 물건이 그 팝업인데, 지금까지는 「AI 가 답했다」에서 끊겨
// 여느 챗봇 위젯과 구별이 안 됐다. 이 라우트가 그 뒤(분류 → 묶음)를 잇는다.
//
// ⚠️ 무인증 공개 경로다. 네 가지를 전부 지킨다:
//   ① 데모 봇 «허용 목록» 밖이면 아무것도 안 한다 — 남의 봇을 추적하는 범용 조회창이 되면 안 된다.
//   ② 제보 «본문»을 절대 돌려주지 않는다. 상태와 분류 라벨·건수만 나간다.
//      (요약·묶음 제목도 안 나간다 — 묶음에는 «다른 방문자»의 말이 섞여 있다.)
//   ③ 소유 검사 — messageId 와 visitorId 가 «같은 행»에서 맞아야 한다. id 를 주웠다고 남의 제보를 못 읽는다.
//   ④ 레이트 리밋 — 위젯 라우트들과 같은 IP 관문을 쓴다.

import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { checkReadRate, isUuid } from '@/lib/widget/http';
import { normalizeCategory, type Category } from '@/lib/classify/taxonomy';
import { serverT } from '@/i18n/server-messages';
import { localeFromRequest } from '@/i18n/server-locale';

/**
 * 추적을 허용하는 봇. **랜딩 「라이브 데모」가 띄우는 널널투어 하나뿐이다.**
 *
 * 왜 허용 목록인가 — 이 라우트가 어떤 botId 든 받으면, 방문자 제보의 «분류 결과»를 로그인 없이
 * 읽는 범용 창구가 된다. 고객사 봇에도 그대로 열리고, messageId·visitorId 는 그 사이트의
 * 스크립트라면 누구든 만질 수 있는 값이다. 데모에 필요한 건 봇 하나이므로 하나만 연다.
 *
 * 값을 env 로 빼지 않은 이유: 봇 id 는 비밀이 아니고(방문자 브라우저에 실린다),
 * env 로 두면 «어느 봇이 열려 있는지»가 코드 리뷰에 안 보인다.
 */
const DEMO_BOT_IDS = new Set(['8cb62530-1c10-498f-b03d-8c51ad31d4c6']);

export type DemoTrackStage = 'received' | 'classified' | 'grouped';

export interface DemoTrackResult {
  stage: DemoTrackStage;
  category: Category | null;
  categoryLabel: string | null;
  /** 이 제보가 묶인 묶음의 제보 수. 묶이기 전엔 null. 제목·요약은 싣지 않는다(다른 사람 말이 섞인다). */
  groupSize: number | null;
  at: { received: string; classified: string | null; grouped: string | null };
}

/** 화면에 그대로 찍히는 라벨 — 대시보드 분류 이름과 같은 사전(`dashboard.groups.categories`), 요청 언어로. */
function categoryLabel(req: NextRequest, category: Category): string {
  return serverT(localeFromRequest(req), 'dashboard.groups.categories')(category);
}

export async function GET(req: NextRequest) {
  const limited = checkReadRate(req);
  if (limited) return limited;

  const sp = req.nextUrl.searchParams;
  const botId = sp.get('botId');
  const messageId = sp.get('messageId');
  const visitorId = sp.get('visitorId');

  // 허용 목록 밖은 «형식 검사보다 먼저» 404. 어떤 봇이 존재하는지조차 흘리지 않는다.
  if (!botId || !DEMO_BOT_IDS.has(botId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!isUuid(messageId) || !isUuid(visitorId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const db = getServiceRoleClient();

  // ── 소유 검사. 네 조건이 «한 행에서» 동시에 맞아야 한다.
  // visitorId 는 위젯이 스스로 만드는 값이라 신분증은 아니지만, messageId 와 «짝»이 맞아야
  // 하므로 둘 다 모르면 남의 제보를 못 연다. 본문(`body`)은 select 에 넣지 않는다 —
  // 넣어두면 나중에 누가 행을 그대로 응답에 실을 때 그 순간 제보 본문이 공개된다.
  const { data: message, error: messageError } = await db
    .from('messages')
    .select('id, detected_at')
    .eq('id', messageId)
    .eq('bot_id', botId)
    .eq('external_user_id', visitorId)
    .eq('source', 'web')
    .maybeSingle();

  if (messageError) {
    console.error('[demo-track] 메시지 조회 실패', { code: messageError.code, message: messageError.message });
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  // 없는 제보와 «남의» 제보를 같은 404 로 답한다 — 구분되면 그 자체가 존재 확인이 된다.
  if (!message) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // ── 분류. 보충 턴(I-05)은 새 인사이트를 만들지 않고 «기존» 인사이트의 source_message_ids 에
  // 붙는다. message_id 만 보면 그런 턴이 영영 「접수됨」에 멈춘다 — 두 자리를 같이 본다.
  //
  // ⚠️ `.or()` 는 PostgREST 필터 «문자열»이라 값을 이어 붙이면 필터를 주입할 수 있다.
  // 여기서는 위에서 `isUuid(messageId)` 를 이미 통과했으므로 남는 문자가 16진수와 하이픈뿐이고,
  // 쉼표·괄호·점이 들어갈 수 없다. **이 순서를 바꾸지 말 것** — 검사를 뒤로 옮기면 그 순간 주입이 열린다.
  const { data: insights, error: insightError } = await db
    .from('insights')
    .select('category, created_at, updated_at, group_id')
    .eq('bot_id', botId)
    .or(`message_id.eq.${messageId},source_message_ids.cs.{${messageId}}`)
    .limit(1);

  if (insightError) {
    console.error('[demo-track] 인사이트 조회 실패', { code: insightError.code, message: insightError.message });
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const insight = insights?.[0] ?? null;
  const received = message.detected_at as string;

  if (!insight) {
    return json({
      stage: 'received',
      category: null,
      categoryLabel: null,
      groupSize: null,
      at: { received, classified: null, grouped: null },
    });
  }

  const category = normalizeCategory(insight.category);
  const classified = (insight.updated_at as string | null) ?? (insight.created_at as string);
  const groupId = insight.group_id as string | null;

  if (!groupId) {
    return json({
      stage: 'classified',
      category,
      categoryLabel: categoryLabel(req, category),
      groupSize: null,
      at: { received, classified, grouped: null },
    });
  }

  // 묶음에 몇 건이 들어 있는지 «숫자만». 제목·요약은 다른 방문자의 말이라 안 싣는다.
  const [{ count }, { data: group }] = await Promise.all([
    db
      .from('insights')
      .select('id', { count: 'exact', head: true })
      .eq('bot_id', botId)
      .eq('group_id', groupId),
    db.from('insight_groups').select('created_at').eq('id', groupId).eq('bot_id', botId).maybeSingle(),
  ]);

  return json({
    stage: 'grouped',
    category,
    categoryLabel: categoryLabel(req, category),
    groupSize: count ?? null,
    at: { received, classified, grouped: (group?.created_at as string | null) ?? null },
  });
}

/**
 * 캐시 금지. 단계가 몇 초 만에 바뀌는 값이라 CDN 이 첫 응답(「접수됨」)을 물면
 * 팝업이 영영 1단계에 멈춘 채로 보인다 — 데모가 끊겨 보이는 가장 나쁜 실패다.
 */
function json(result: DemoTrackResult) {
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

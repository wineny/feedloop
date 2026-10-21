import { NextRequest, NextResponse, after } from 'next/server';
import { signShotsForMessages } from '@/lib/widget/shots';
import { pickedFromContext } from '@/lib/widget/picked-shot';
import { getServiceRoleClient } from '@/lib/supabase';
import { runGroupingNow } from '@/lib/groups/auto-grouping';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { runClassificationRecovery } from '@/lib/classify/recovery';
import { apiText } from '@/lib/http/api-text';

const IN_CHUNK = 100;
export const maxDuration = 300;

/** `.in()` URL 이 터지지 않게 나눠 조회한다. */
export async function fetchClassifiedIds(
  db: ReturnType<typeof getServiceRoleClient>,
  ids: string[],
  botIds: string[],
): Promise<Set<string>> {
  const done = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    // 청크마다 Set 으로 만든다. 아래 교집합을 배열 `includes` 로 돌면 100개 청크 ×
    // 보충 배열마다 선형 탐색이라 건수가 늘수록 조용히 느려진다.
    const inChunk = new Set(chunk);

    // 두 조회 모두 **소유한 봇으로 좁힌다.** service_role 로 붙으므로 RLS 가 막아 주지
    // 않고, 이 결과는 「이미 분류됨」 판정에 쓰인다 — 남의 테넌트 인사이트가 섞이면
    // 내 미분류 메시지가 분류된 것으로 잘못 걸러진다.
    const { data, error } = await db
      .from('insights')
      .select('message_id')
      .in('bot_id', botIds)
      .in('message_id', chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) if (row.message_id) done.add(row.message_id as string);

    // 보충 턴(source_message_ids) 도 "이미 분류됨" 으로 본다 — 위젯 즉답이 기존
    // 인사이트를 갱신한 메시지는 message_id 에 안 걸린다. 여기서 안 걸러내면
    // [분류] 버튼이 그 메시지를 새 인사이트로 만들어 I-05(대화 1개 → 인사이트 여러 개)가
    // 배치 경로로 뒷문 재발한다.
    const { data: extData, error: extError } = await db
      .from('insights')
      .select('source_message_ids')
      .in('bot_id', botIds)
      .overlaps('source_message_ids', chunk);
    if (extError) throw new Error(extError.message);
    for (const row of extData ?? []) {
      const sourceIds = (row.source_message_ids as string[] | null) ?? [];
      // 배열 안 id 중 이번 청크에 속한 것만 넣는다 — 다른 청크 소속 id 는
      // 그 청크 차례에 같은 방식으로 잡힌다.
      for (const id of sourceIds) if (inChunk.has(id)) done.add(id);
    }
  }
  return done;
}

// ── POST: 미분류 메시지를 배치 분류 ─────────────────────

export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  const { bot_id, botId } = await req.json().catch(() => ({}));

  // 인증 + 테넌트 스코핑. service_role 을 쓰므로 RLS 가 막아주지 않는다.
  // `botId` 는 헤더 셀렉터(I-27)가 다른 라우트와 같은 이름으로 싣는 값이고, `bot_id` 는 옛 호출부용.
  const auth = await resolveOwnedBots(botId ?? bot_id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.botIds.length === 0) {
    return NextResponse.json({
      classified: 0,
      pending: 0,
      results: {},
      message: apiText(req, 'noBots'),
    });
  }

  try {
    const result = await runClassificationRecovery(auth.botIds, Date.now() + 240_000);
    // I-10 — 배치로 분류된 것은 이미 오래된 메시지라 조용한 시간을 기다릴 이유가 없다. 바로 묶는다.
    // 응답(분류 결과)을 붙들지 않고 after() 에서. 잠금은 존중한다(위젯 트리거와 겹치면 그쪽이 묶는다).
    // 봇 전체가 마감 하나를 나눠 쓴다 — 봇마다 새로 주면 넷이면 maxDuration 을 넘는다.
    // 복구가 240초를 다 썼으면 남은 시간이 100초보다 적다. 라우트 시작 기준으로 잘라 준다.
    if (result.classified > 0) {
      const deadline = Math.min(routeStartedAt + 290_000, Date.now() + 100_000);
      after(
        runGroupingNow(auth.botIds, deadline).catch((err) =>
          console.error('[classify] auto grouping failed:', err instanceof Error ? err.message : err),
        ),
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : apiText(req, 'recoveryFailed') }, { status: 500 });
  }
}

// ── GET: 분류 결과 조회 ─────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // 두 이름을 받는다 — `botId` 는 헤더 셀렉터(I-27)가 다른 라우트와 같은 이름으로 싣고, `bot_id` 는 옛 호출부.
  const botId = searchParams.get('botId') ?? searchParams.get('bot_id');
  const category = searchParams.get('category');

  const auth = await resolveOwnedBots(botId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.botIds.length === 0) {
    return NextResponse.json({ insights: [] });
  }

  const db = getServiceRoleClient();

  let query = db
    .from('insights')
    .select(`
      id,
      category,
      summary,
      sentiment,
      classified_by,
      classify_confidence,
      follow_up_needed,
      created_at,
      message_id,
      group_id,
      source_message_ids,
      updated_at,
      messages (
        body,
        author_name,
        chat_id,
        source,
        detected_at,
        context
      )
    `)
    .order('created_at', { ascending: false })
    .limit(50);

  query = query.in('bot_id', auth.botIds);
  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const states = ['pending', 'processing', 'failed', 'exhausted'] as const;
  const counts = await Promise.all(states.map(state => db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', auth.botIds).eq('classification_state', state)));
  const failures = await db.from('messages').select('id, classification_state, classification_attempts, classification_error, detected_at').in('bot_id', auth.botIds).in('classification_state', ['failed', 'exhausted']).order('detected_at', { ascending: true }).limit(50);
  if (counts.some(result => result.error) || failures.error) return NextResponse.json({ error: apiText(req, 'triageRecoveryReadFailed') }, { status: 500 });
  const insights = await withPickedShots(data || [], auth.botIds);
  return NextResponse.json({ insights, recovery: { counts: Object.fromEntries(states.map((state, index) => [state, counts[index].count ?? 0])), failures: failures.data ?? [] } });
}

/**
 * 「화면에서 선택하기」(I-55) — 짚은 요소가 있는 행에 `picked`(라벨·rect·뷰포트) + 10분 서명 URL 을 싣고,
 * 원본 context(html 뼈대·UA 등)는 목록 응답에서 뺀다. 소유 확인(resolveOwnedBots)을 지난 뒤에만 부른다.
 */
async function withPickedShots<T extends { message_id: string; messages: unknown }>(rows: T[], botIds: string[]) {
  const ctxOf = (r: T) => {
    const m = (Array.isArray(r.messages) ? r.messages[0] : r.messages) as { context?: unknown } | null;
    return m?.context ?? null;
  };
  const withShot = rows.filter((r) => Boolean((ctxOf(r) as { target?: { shot?: unknown } } | null)?.target?.shot)).map((r) => r.message_id);
  const shots = await signShotsForMessages(withShot, botIds);
  return rows.map((r) => {
    const context = ctxOf(r);
    const m = (Array.isArray(r.messages) ? r.messages[0] : r.messages) as ({ context?: unknown; detected_at?: string } & Record<string, unknown>) | null;
    const messages = m ? (({ context: _c, ...rest }) => (void _c, rest))(m) : m;
    const picked = pickedFromContext(context, shots[r.message_id], m?.detected_at);
    return { ...r, messages, picked };
  });
}

/** Explicit operator retry; repeated clicks do not reset an active cycle. */
export async function PATCH(req: NextRequest) {
  const auth = await resolveOwnedBots();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.messageId)) {
    return NextResponse.json({ error: apiText(req, 'messageIdRequired') }, { status: 400 });
  }
  const { data, error } = await getServiceRoleClient().rpc('retry_exhausted_classification', { p_message_id: body.messageId, p_operator_id: auth.userId });
  if (error) return NextResponse.json({ error: apiText(req, 'retryScheduleFailed') }, { status: 500 });
  if (!data) return NextResponse.json({ error: apiText(req, 'retryNotAllowed') }, { status: 409 });
  return NextResponse.json({ queued: true });
}

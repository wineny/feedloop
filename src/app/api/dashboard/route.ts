// 대시보드 데이터 — 봇 파이프라인(messages → insights → auto_dev_runs)만 읽는다.
//
// 예전에는 `/api/feedback` 이 `feedbacks`/`classifications` 를 읽었는데, 그 테이블에는
// 쓰는 코드도 테넌트 컬럼도 없어서 화면이 영원히 0 이었다. 실데이터는 전부 이쪽에 있다.

import { NextResponse, type NextRequest } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { personLabel } from '@/lib/channel/labels';
import { messageDelivery } from '@/lib/dashboard/feedback-delivery';
import {
  EMPTY_LOOP_TIME,
  FAILED_LOOP_TIME,
  loopClosedConversationIds,
  loopTimeStats,
  type LoopTimeStats,
} from '@/lib/dashboard/loop-time';
import {
  EMPTY_CONFIRMATION,
  FAILED_CONFIRMATION,
  type ConfirmationStats,
} from '@/lib/dashboard/confirmation';

/** 루프의 각 단계를 통과한 건수. 화면의 4칸과 1:1 대응한다. */
export interface LoopStats {
  collected: number;
  classified: number;
  prCreated: number;
  returned: number;
  /**
   * 입구별 수집 건수. **`collected` 를 나눈 것이지 깎은 것이 아니다** — 문의도 실제로
   * 들어온 피드백이라 총계에서 빼지 않는다. 화면 반영은 아직 하지 않고 숫자만 먼저 쌓는다.
   */
  bySource: SourceCounts;
  /** 아직 전달되지 않은 되돌림. 만들어졌지만 상대에게 못 간 것이라 «반영됨» 과 다르다. */
  returnQueued?: number;
  classification?: { done: number; pending: number; processing: number; failed: number; exhausted: number; eligible: number };
  /** 제보 → 반영 알림 평균 시간(C5). 정의와 표본에서 빼는 것은 `lib/dashboard/loop-time.ts` 주석에 있다. */
  loopTime?: LoopTimeStats;
  /** 되돌림 확인(F5). 두 비율의 «분모가 다르다» — `lib/dashboard/confirmation.ts` 주석 참고. */
  confirmation?: ConfirmationStats;
  /**
   * 고칠 레포가 지정된 봇들의 id(F6 체크리스트 ③). **id 목록만** 내려간다 —
   * 레포 주소도, 토큰·설치 정보도 이 응답에 싣지 않는다.
   *
   * 봇 단위로 내려보내는 이유: 계정 하나로 봇을 여럿 쓰면 「어느 봇이든 하나 되어 있음」은
   * 지금 온보딩 중인 그 봇의 사실이 아니다 — A 봇 레포 때문에 B 봇의 ③ 이 완료로 보인다.
   */
  githubReadyBotIds?: string[];
}

/** 입구 3종. 목록에 없는 입구가 생기면 여기에 칸을 더한다. */
export interface SourceCounts {
  web: number;
  kakao: number;
  channel: number;
}

const SOURCES = ['web', 'kakao', 'channel'] as const;

export interface LoopFeedbackItem {
  id: string;
  userName: string;
  content: string;
  source: string;
  createdAt: string;
  botResponse: string | null;
  insight: { id: string; category: string; summary: string } | null;
  pr: { url: string; number: number } | null;
  returnedAt: string | null;
  returnQueuedAt: string | null;
}

export interface LoopEvent {
  id: string;
  kind: 'classified' | 'pr_created' | 'pr_failed' | 'returned';
  title: string;
  detail: string;
  at: string;
}

const EMPTY = {
  stats: {
    collected: 0,
    classified: 0,
    prCreated: 0,
    returned: 0,
    bySource: { web: 0, kakao: 0, channel: 0 },
    loopTime: EMPTY_LOOP_TIME,
    confirmation: EMPTY_CONFIRMATION,
    githubReadyBotIds: [],
  } satisfies LoopStats,
  feedbacks: [] as LoopFeedbackItem[],
  events: [] as LoopEvent[],
};

/** 최근 목록에 싣는 메시지 수. 통계는 이 상한과 무관하게 전량을 센다. */
const RECENT_LIMIT = 50;

/**
 * 루프 시간 표본으로 읽는 메시지 수 상한(조회 한 번당). PostgREST 기본 상한(1000)에 기대지 않고
 * «우리가» 정한다 — 상한에 닿으면 잘렸다는 뜻이라 평균을 내지 않고 「집계 못 함」으로 보고한다.
 * 조용히 잘리면 첫 제보가 빠져 평균이 실제보다 **작게** 나온다(루프가 빨라 보인다).
 */
const ANCHOR_ROW_LIMIT = 1000;

/** `.in()` 한 번에 싣는 대화 id 수. 목록이 길어지면 URL 이 서버 상한을 넘겨 414 로 죽는다. */
const CONVERSATION_CHUNK = 200;

// `?botId=` 로 한 서비스만 본다(I-27). 없으면 종전대로 유저의 봇 전체.
// req 가 선택인 이유: 테스트가 인자 없이 부른다 — Next 는 늘 넘긴다.
export async function GET(req?: NextRequest) {
  const auth = await resolveAccessibleBots(req?.nextUrl.searchParams.get('botId') ?? null);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (auth.botIds.length === 0) {
    return NextResponse.json(EMPTY);
  }

  const db = getServiceRoleClient();
  const botIds = auth.botIds;

  // 통계는 개수만 필요하므로 행을 받아오지 않는다(head: true).
  const [collectedRes, classifiedRes, prRes, returnedRes] = await Promise.all([
    db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', botIds),
    db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', botIds).eq('classification_state', 'done'),
    db
      .from('auto_dev_runs')
      .select('id', { count: 'exact', head: true })
      .in('bot_id', botIds)
      .not('pr_url', 'is', null),
    db
      .from('responses')
      .select('id', { count: 'exact', head: true })
      .in('bot_id', botIds)
      .eq('response_type', 'loop_closed').not('delivered_at', 'is', null),
  ]);

  const states = ['pending', 'processing', 'failed', 'exhausted'] as const;
  const stateCounts = await Promise.all(states.map(state => db.from('messages')
    .select('id', { count: 'exact', head: true }).in('bot_id', botIds).eq('classification_state', state)));
  const [eligibleRes, queuedRes] = await Promise.all([
    db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', botIds)
      .in('classification_state', ['pending', 'failed', 'processing'])
      .lte('classification_next_at', new Date().toISOString()).lt('classification_attempts', 3),
    db.from('responses').select('id', { count: 'exact', head: true }).in('bot_id', botIds)
      .eq('response_type', 'loop_closed').is('delivered_at', null),
  ]);
  const statsError = [collectedRes, classifiedRes, prRes, returnedRes, ...stateCounts, eligibleRes, queuedRes].find(result => result.error)?.error;
  if (statsError) return NextResponse.json({ error: statsError.message }, { status: 500 });

  // ⚠️ 이 블록은 반드시 위 조회들 **뒤** 에 온다. `bySource` 는 화면에 아직 안 쓰는 계측이고,
  // 앞에 끼우면 다른 조회의 순서가 밀린다 — 순서로 응답을 짝짓는 테스트가 조용히 다른 값을
  // 읽게 된다(통합 중 실제로 그렇게 어긋났다). 실패는 관용한다(`?? 0`): 계측 하나 때문에
  // 대시보드 전체를 500 으로 만들지 않는다.
  // 입구별 카운트는 따로 묶는다 — 위 배열에 spread 로 섞으면 Promise.all 의 튜플 추론이
  // 배열로 무너져 위 네 개의 타입이 유니온이 된다.
  const sourceRes = await Promise.all(
    SOURCES.map((source) =>
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('bot_id', botIds)
        .eq('source', source),
    ),
  );

  const bySource = SOURCES.reduce(
    (acc, source, i) => ({ ...acc, [source]: sourceRes[i]?.count ?? 0 }),
    {} as SourceCounts,
  );

  const stats: LoopStats = {
    collected: collectedRes.count ?? 0,
    classified: classifiedRes.count ?? 0,
    prCreated: prRes.count ?? 0,
    returned: returnedRes.count ?? 0,
    bySource,
    returnQueued: queuedRes.count ?? 0,
    classification: {
      done: classifiedRes.count ?? 0,
      pending: stateCounts[0].count ?? 0, processing: stateCounts[1].count ?? 0,
      failed: stateCounts[2].count ?? 0, exhausted: stateCounts[3].count ?? 0,
      eligible: eligibleRes.count ?? 0,
    },
  };

  const [messagesRes, insightsRes, responsesRes, runsRes] = await Promise.all([
    db
      .from('messages')
      .select('id, conversation_id, author_name, body, source, detected_at, created_at')
      .in('bot_id', botIds)
      .order('detected_at', { ascending: false })
      .limit(RECENT_LIMIT),
    db
      .from('insights')
      .select('id, message_id, source_message_ids, group_id, category, summary, created_at')
      .in('bot_id', botIds)
      .order('created_at', { ascending: false }),
    db
      .from('responses')
      .select('trigger_message_id, conversation_id, response_type, response_body, sent_at, delivered_at, auto_dev_run_id')
      .in('bot_id', botIds),
    db
      .from('auto_dev_runs')
      .select('id, insight_id, group_id, status, pr_url, pr_number, closed_at, created_at')
      .in('bot_id', botIds)
      .order('created_at', { ascending: false }),
  ]);

  const firstError =
    messagesRes.error || insightsRes.error || responsesRes.error || runsRes.error;
  if (firstError) {
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  const messages = messagesRes.data ?? [];
  const insights = insightsRes.data ?? [];
  const responses = responsesRes.data ?? [];
  const runs = runsRes.data ?? [];

  // 루프 시간(C5) — 되돌림이 간 대화의 메시지만 더 읽는다. 위 `messages` 조회는 최근 50건이라
  // 통계의 표본으로 쓸 수 없다(평균이 「최근 50건에 걸린 것만」이 된다).
  // ⚠️ 이 조회는 반드시 위 Promise.all 들 **뒤** 에 온다 — 앞에 끼우면 응답을 «순서로» 짝짓는
  //    테스트가 다른 값을 읽는다(`bySource` 주석과 같은 사정).
  const loopConversationIds = loopClosedConversationIds(responses);
  const conversationChunks: string[][] = [];
  for (let i = 0; i < loopConversationIds.length; i += CONVERSATION_CHUNK) {
    conversationChunks.push(loopConversationIds.slice(i, i + CONVERSATION_CHUNK));
  }

  const anchorRes = await Promise.all(
    conversationChunks.map((chunk) =>
      db
        .from('messages')
        .select('id, conversation_id, detected_at')
        .in('bot_id', botIds)
        .in('conversation_id', chunk)
        // 「첫 제보」를 찾는 집계라 이른 것부터 받는다. 정렬이 없으면 어느 행이 잘릴지도 정해지지 않는다.
        .order('detected_at', { ascending: true })
        .limit(ANCHOR_ROW_LIMIT),
    ),
  );

  // 지표 하나 때문에 대시보드 전체를 500 으로 만들지 않는다. 대신 「집계 못 함」으로 «말한다» —
  // 0 으로 채워 「아직 없음」처럼 보이게 하면, 깨진 집계가 조용한 사실로 둔갑한다.
  const anchorError = anchorRes.find((chunk) => chunk.error)?.error;
  const anchorTruncated = anchorRes.some((chunk) => (chunk.data?.length ?? 0) >= ANCHOR_ROW_LIMIT);
  if (anchorError) console.error('[dashboard] 루프 시간 표본 조회 실패:', anchorError.message);
  if (anchorTruncated) console.error('[dashboard] 루프 시간 표본이 상한에 닿았습니다 — 평균을 내지 않습니다');

  const loopTime: LoopTimeStats =
    anchorError || anchorTruncated
      ? FAILED_LOOP_TIME
      : loopConversationIds.length === 0
        ? EMPTY_LOOP_TIME
        : loopTimeStats(responses, runs, insights, anchorRes.flatMap((chunk) => chunk.data ?? []));

  // 되돌림 확인(F5)과 체크리스트 ③ 의 재료. 서로 독립이라 한 번에 보낸다.
  // ⚠️ `Promise.all` 은 배열을 «순서대로» 만들며 `from()` 도 그 순서로 동기 호출된다 —
  //    응답을 순서로 짝짓는 테스트가 어긋나지 않는다.
  //
  // 세 되돌림 조회는 전부 **web 대화로 좁힌다**: 답을 받는 길이 위젯 카드뿐이라
  // (`confirm_widget_resolution` 이 `c.source='web'` 만 받는다) 다른 입구의 되돌림을 분모에
  // 넣으면 응답률이 구조적으로 낮게 나온다. 분자·분모가 같은 모집단을 봐야 한다.
  const webLoopClosed = () =>
    db
      .from('responses')
      .select('id, conversations!inner(source)', { count: 'exact', head: true })
      .in('bot_id', botIds)
      .eq('response_type', 'loop_closed')
      .eq('conversations.source', 'web');

  const [fixedRes, notFixedRes, deliveredWebRes, repoRes] = await Promise.all([
    webLoopClosed().eq('user_confirmation', 'fixed'),
    webLoopClosed().eq('user_confirmation', 'not_fixed'),
    webLoopClosed().not('delivered_at', 'is', null),
    // 체크리스트 ③ — 주소는 읽되 **id 목록으로 접어서** 내보낸다. 토큰·설치 컬럼은 읽지 않는다.
    db.from('bots').select('id, github_repo_url').in('id', botIds),
  ]);

  const confirmationError = fixedRes.error ?? notFixedRes.error ?? deliveredWebRes.error;
  if (confirmationError) console.error('[dashboard] 되돌림 확인 집계 실패:', confirmationError.message);

  const fixed = fixedRes.count ?? 0;
  const notFixed = notFixedRes.count ?? 0;
  const deliveredWeb = deliveredWebRes.count ?? 0;
  const confirmation: ConfirmationStats = confirmationError
    ? FAILED_CONFIRMATION
    : fixed + notFixed + deliveredWeb === 0
      ? EMPTY_CONFIRMATION
      : { state: 'ok', fixed, notFixed, delivered: deliveredWeb };

  // 실패하면 빈 목록이다 — ③ 이 「아직 안 됨」으로 보인다. 반대 방향(안 된 걸 됐다고)보다 낫다.
  if (repoRes.error) console.error('[dashboard] 저장소 지정 여부 조회 실패:', repoRes.error.message);
  const githubReadyBotIds = (repoRes.data ?? [])
    .filter((bot) => Boolean(bot.github_repo_url))
    .map((bot) => bot.id as string);

  const insightByMessage = new Map<string, (typeof insights)[number]>();
  for (const insight of insights) {
    for (const id of [insight.message_id, ...(insight.source_message_ids ?? [])]) {
      if (!insightByMessage.has(id)) insightByMessage.set(id, insight);
    }
  }

  // 말풍선에 띄울 봇 답변. 되돌림(loop_closed)은 따로 표시하므로 여기서 뺀다.
  const responseByMessage = new Map(
    responses
      .filter((r) => r.response_type !== 'loop_closed')
      .map((r) => [r.trigger_message_id, r]),
  );

  // 인사이트 하나에 실행이 여러 번 있을 수 있다 — 최신 성공 건을 대표로 삼는다.
  const runByInsight = new Map<string, (typeof runs)[number]>();
  const runByGroup = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    // 머지 없이 닫힌 PR 은 말풍선에 달지 않는다
    if (run.status !== 'completed' || !run.pr_url || run.closed_at) continue;
    if (run.insight_id && !runByInsight.has(run.insight_id)) runByInsight.set(run.insight_id, run);
    if (run.group_id && !runByGroup.has(run.group_id)) runByGroup.set(run.group_id, run);
  }

  const feedbacks: LoopFeedbackItem[] = messages.map((m) => {
    const insight = insightByMessage.get(m.id) ?? null;
    // 인사이트 직결 run 이 없으면 그 인사이트가 속한 묶음의 run 을 본다 (설계 §6).
    const run = insight
      ? runByInsight.get(insight.id) ??
        (insight.group_id ? runByGroup.get(insight.group_id) : undefined)
      : undefined;
    return {
      id: m.id,
      userName: m.author_name ?? personLabel(m.source ?? ''),
      content: m.body,
      source: m.source ?? 'telegram',
      createdAt: m.detected_at ?? m.created_at,
      botResponse: responseByMessage.get(m.id)?.response_body ?? null,
      insight: insight
        ? { id: insight.id, category: insight.category, summary: insight.summary }
        : null,
      pr: run?.pr_url ? { url: run.pr_url, number: run.pr_number ?? 0 } : null,
      ...messageDelivery({ id: m.id, conversation_id: m.conversation_id, detected_at: m.detected_at ?? m.created_at }, insights, runs, responses),
    };
  });

  // 활동 피드 — 분류·PR 이벤트를 시간순으로 섞는다.
  const summaryByInsight = new Map(insights.map((i) => [i.id, i.summary]));
  const events: LoopEvent[] = [
    ...insights.map<LoopEvent>((i) => ({
      id: `insight-${i.id}`,
      kind: 'classified',
      title: i.summary,
      detail: `분류: ${i.category}`,
      at: i.created_at,
    })),
    ...runs.map<LoopEvent>((r) => ({
      id: `run-${r.id}`,
      kind: r.status === 'completed' && r.pr_url ? 'pr_created' : 'pr_failed',
      title:
        r.status === 'completed' && r.pr_number
          ? `PR #${r.pr_number} 자동 생성`
          : '자동 수정 실행',
      detail:
        (r.insight_id ? summaryByInsight.get(r.insight_id) : null) ??
        (r.status === 'completed' ? '수정안 생성 완료' : `상태: ${r.status}`),
      at: r.created_at,
    })),
    ...responses
      .filter((r) => r.response_type === 'loop_closed')
      .map<LoopEvent>((r) => ({
        id: `return-${r.trigger_message_id ?? r.conversation_id}-${r.sent_at}`,
        kind: 'returned',
        title: r.response_body,
        detail: r.delivered_at ? '반영 알림 보냄' : '반영 알림 대기',
        at: r.delivered_at ?? r.sent_at,
      })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 20);

  return NextResponse.json({
    stats: { ...stats, loopTime, confirmation, githubReadyBotIds },
    feedbacks,
    events,
  });
}

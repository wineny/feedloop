// 대시보드 데이터 — 봇 파이프라인(messages → insights → auto_dev_runs)만 읽는다.
//
// 예전에는 `/api/feedback` 이 `feedbacks`/`classifications` 를 읽었는데, 그 테이블에는
// 쓰는 코드도 테넌트 컬럼도 없어서 화면이 영원히 0 이었다. 실데이터는 전부 이쪽에 있다.

import { NextResponse, type NextRequest } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { resolveAccessibleBots } from '@/lib/auth/ownership';
import { personLabelFor } from '@/lib/channel/labels-server';
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
import { isPayPalConnected } from '@/lib/paypal/bot';
import { PAYMENT_AGENT_RESPONSE_TYPE, PAYMENT_RESPONSE_TYPE } from '@/lib/paypal/response-types';
import { EMPTY_REFUND_REASONS, refundReasons as aggregateRefundReasons, type RefundReasons } from '@/lib/dashboard/refund-reasons';
import { serverT } from '@/i18n/server-messages';
import { localeFromRequest } from '@/i18n/server-locale';

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

/**
 * 대시보드의 PayPal 숫자 3개 + 「PayPal 연결하기」 카드 재료. `botIds`(선택한 봇 하나 또는 유저의 봇 전체)를
 * 합친 값이다.
 *
 * 연결 안 된 봇이어도 같은 모양으로 내려간다 — 숫자는 그대로 센다(예전에 연결했던 봇은 기록이 남아 있다).
 *
 * 화면 계약 — 두 칸이 각자 하나만 정한다:
 *  - `connected` 가 true 면 숫자 카드를 보인다.
 *  - `connectBotId` 가 null 이 아니면 「PayPal 연결하기」 카드를 보인다(그 봇의 PayPal 탭으로).
 *  둘이 동시에 켜질 수 있다 — 예: 전체 봇 보기에서 연결 안 된 자기 봇 + 승인자로 들어간 데모 봇.
 *
 * 숫자 칸의 `null` 은 「0」이 아니라 **「집계 못 함」** 이다(조회 실패·상한 도달). 0 으로 채우면 깨진 집계가
 * 「아직 없음」처럼 보인다 — `loopTime`·`confirmation` 과 같은 규칙.
 */
export interface DashboardPayments {
  /**
   * 보고 있는 봇(`botIds` — `?botId=` 면 그 봇 하나, 아니면 접근 가능한 봇 전체) 중 하나라도 PayPal 이
   * 연결돼 있다(`isPayPalConnected` — 자기 키 저장됨, 또는 데모 봇. 일시정지 봇 제외). 역할과 무관하다 —
   * 데모 봇의 승인자인 심사위원도 데모 숫자를 본다.
   */
  connected: boolean;
  /**
   * 「PayPal 연결하기」 카드가 열 봇 = 보고 있는 봇 중 **소유한** 봇에서 연결 안 된 첫 봇, 없으면 null.
   * PayPal 설정 탭은 소유자 전용(`resolveOwnedBots`)이라 승인자로만 들어간 봇은 고르지 않는다(403 이 된다).
   * `?botId=` 로 승인자 봇을 보고 있으면 null.
   */
  connectBotId: string | null;
  /** 지난 7일 결제 답(`payment`·`payment_agent`)이 1번이라도 나간 **대화 수**(행 수 아님). */
  inquiries7d: number | null;
  /**
   * 지난 7일 자동 실행된 환불. `count` 는 통화와 무관하게 센다. `amountCents`·`currency` 는 통화가 하나일 때만
   * 값이 있고, 통화가 섞이면 둘 다 null 이다(서로 다른 통화를 더한 숫자는 거짓말이다).
   */
  autoRefunds7d: { count: number; amountCents: number | null; currency: string | null } | null;
  /** 운영자 승인을 기다리는 실행(`payment_actions.status='pending'`). 기간 제한 없음. */
  pendingApprovals: number | null;
  /**
   * 환불 사유 카드 — 환불 요청(`payment_actions.kind='refund'`, 상태 무관·기간 제한 없음)을 그 대화에서 나온
   * 인사이트로 갈래(fix·feature·other·unclassified)를 나누고 많이 나온 사유 3개를 싣는다. 집계 규칙은
   * `lib/dashboard/refund-reasons.ts`. 다른 숫자와 같이 null = 집계 못 함(조회 실패·상한 도달).
   * 선택 필드인 이유: 이 필드가 없는 응답(예전 모양·테스트 고정값)은 카드를 그리지 않는다.
   */
  refundReasons?: RefundReasons | null;
}

const EMPTY_PAYMENTS: DashboardPayments = {
  connected: false,
  connectBotId: null,
  inquiries7d: 0,
  autoRefunds7d: { count: 0, amountCents: 0, currency: null },
  pendingApprovals: 0,
  refundReasons: EMPTY_REFUND_REASONS,
};

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
  payments: EMPTY_PAYMENTS,
};

/** 최근 목록에 싣는 메시지 수. 통계는 이 상한과 무관하게 전량을 센다. */
const RECENT_LIMIT = 50;

/**
 * 루프 시간 표본으로 읽는 메시지 수 상한(조회 한 번당). PostgREST 기본 상한(1000)에 기대지 않고
 * «우리가» 정한다 — 상한에 닿으면 잘렸다는 뜻이라 평균을 내지 않고 「집계 못 함」으로 보고한다.
 * 조용히 잘리면 첫 제보가 빠져 평균이 실제보다 **작게** 나온다(루프가 빨라 보인다).
 */
const ANCHOR_ROW_LIMIT = 1000;

/**
 * PayPal 숫자의 7일 창에서 읽는 행 수 상한. 결제 문의 대화 수는 PostgREST 로 DISTINCT 를 셀 수 없어서
 * `conversation_id` 만 받아 JS 에서 중복을 지운다. 해커톤 규모에서는 한참 아래다.
 *
 * 잘렸는지는 행 수가 아니라 `count: 'exact'` 로 판단한다(`count > data.length`) — 서버 쪽 상한(PostgREST
 * 기본 1000)이 우리 limit 보다 작아도 잡힌다. 잘렸으면 숫자를 내지 않고 「집계 못 함」(null)으로 말한다
 * (앵커 조회와 같은 규칙). 값은 `ANCHOR_ROW_LIMIT` 과 맞춘다.
 */
const PAYMENT_ROW_LIMIT = 1000;

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

/** `.in()` 한 번에 싣는 대화 id 수. 목록이 길어지면 URL 이 서버 상한을 넘겨 414 로 죽는다. */
const CONVERSATION_CHUNK = 200;

/**
 * 환불 사유 카드의 `.in()` 한 번에 싣는 id 수(대화·묶음). 대화 하나에 메시지가 여럿이라 한 조회가
 * `PAYMENT_ROW_LIMIT` 행을 넘기지 않게 작게 잡는다. 그래도 넘치면 숫자를 내지 않는다(null).
 */
const REFUND_CHUNK = 50;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

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
      // count: 환불 사유 카드가 «잘렸는지» 를 안다(PostgREST 기본 상한 1000). 다른 화면 동작은 그대로다.
      .select('id, message_id, source_message_ids, group_id, category, summary, created_at', { count: 'exact' })
      .in('bot_id', botIds)
      .order('created_at', { ascending: false }),
    db
      .from('responses')
      .select('trigger_message_id, conversation_id, response_type, response_body, sent_at, delivered_at, auto_dev_run_id')
      .in('bot_id', botIds),
    db
      .from('auto_dev_runs')
      .select('id, insight_id, group_id, status, pr_url, pr_number, closed_at, created_at', { count: 'exact' })
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

  // PayPal 숫자 3개 + 연결 여부(5단계). 서로 독립이라 한 번에 보낸다.
  // ⚠️ 이 블록도 위 조회들 **뒤** 에 온다 — 응답을 순서로 짝짓는 테스트가 어긋나지 않게(`bySource` 주석).
  const since7d = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const [inquiryRes, autoRefundRes, pendingRes, connectionRes] = await Promise.all([
    db
      .from('responses')
      .select('conversation_id', { count: 'exact' })
      .in('bot_id', botIds)
      .in('response_type', [PAYMENT_RESPONSE_TYPE, PAYMENT_AGENT_RESPONSE_TYPE])
      .gte('sent_at', since7d)
      .not('conversation_id', 'is', null)
      .limit(PAYMENT_ROW_LIMIT),
    // 기간은 `executed_at`(돈이 실제로 나간 시각, settleAction 이 'executed' 로 바꿀 때 찍는다)으로 자른다.
    // `created_at` 은 행이 생긴 시각이라 실행이 늦어진 건이 엉뚱한 주에 잡힌다.
    db
      .from('payment_actions')
      .select('amount_cents, currency', { count: 'exact' })
      .in('bot_id', botIds)
      .eq('kind', 'refund')
      .eq('origin', 'auto')
      .eq('status', 'executed')
      .gte('executed_at', since7d)
      .limit(PAYMENT_ROW_LIMIT),
    db.from('payment_actions').select('id', { count: 'exact', head: true }).in('bot_id', botIds).eq('status', 'pending'),
    // 연결 여부만 판단한다 — 암호문은 «있는지»만 보고 복호화하지 않으며, 응답에 싣지 않는다.
    db.from('bots').select('id, status, is_demo, paypal_client_id, paypal_secret_encrypted, currency').in('id', botIds),
  ]);

  // 실패하면 「연결 안 됨」으로 보인다 — 카드는 설정 화면으로 가는 링크라 잘못 떠도 해가 없다(③ 과 같은 방향).
  if (connectionRes.error) console.error('[dashboard] PayPal 연결 여부 조회 실패:', connectionRes.error.message);
  const paypalBots = connectionRes.data ?? [];
  const botCurrencies = new Set(paypalBots.map((bot) => bot.currency as string));

  let inquiries7d: number | null = null;
  if (inquiryRes.error) console.error('[dashboard] 결제 문의 집계 실패:', inquiryRes.error.message);
  else if ((inquiryRes.count ?? 0) > (inquiryRes.data?.length ?? 0)) console.error('[dashboard] 결제 문의 표본이 상한에 닿았습니다');
  else inquiries7d = new Set((inquiryRes.data ?? []).map((r) => r.conversation_id as string)).size;

  let autoRefunds7d: DashboardPayments['autoRefunds7d'] = null;
  if (autoRefundRes.error) console.error('[dashboard] 자동 환불 집계 실패:', autoRefundRes.error.message);
  else if ((autoRefundRes.count ?? 0) > (autoRefundRes.data?.length ?? 0)) console.error('[dashboard] 자동 환불 표본이 상한에 닿았습니다');
  else {
    const rows = autoRefundRes.data ?? [];
    // 통화가 하나일 때만 금액을 더한다. 섞이면 금액·통화를 비운다 — 건수는 그대로 맞다.
    // 봇 통화와 같은 행만 더하는 방법도 있지만, 그러면 화면의 금액이 건수와 안 맞는다. 데모는 USD 하나다.
    const rowCurrencies = new Set(rows.map((r) => r.currency as string | null));
    const mixed = rowCurrencies.size > 1;
    // 0건이면 봇 통화(`bots.currency`)를 쓴다 — 화면이 「$0.00」을 그릴 수 있게. 봇마다 다르면 null.
    const currencyPool = rows.length > 0 ? rowCurrencies : botCurrencies;
    autoRefunds7d = {
      count: rows.length,
      amountCents: mixed ? null : rows.reduce((sum, r) => sum + ((r.amount_cents as number | null) ?? 0), 0),
      currency: currencyPool.size === 1 ? ([...currencyPool][0] ?? null) : null,
    };
  }

  if (pendingRes.error) console.error('[dashboard] 승인 대기 집계 실패:', pendingRes.error.message);
  const pendingApprovals = pendingRes.error ? null : (pendingRes.count ?? 0);

  // 환불 사유 카드. 새 AI 호출 없이 이미 있는 행만 읽는다 — 환불 요청 → 그 대화의 메시지 → (위에서 읽은) 인사이트·실행.
  // ⚠️ 이 블록도 위 조회들 **뒤** 에 온다 — 응답을 순서로 짝짓는 테스트가 어긋나지 않게(`bySource` 주석).
  //    대화가 없으면 메시지 조회를, 묶음이 없으면 묶음 조회를 아예 하지 않는다.
  // 어느 재료든 잘렸으면(count > 받은 행) 숫자를 내지 않는다(null) — 틀린 숫자보다 「집계 못 함」이 낫다.
  const refundRes = await db
    .from('payment_actions')
    .select('id, conversation_id, reason, created_at', { count: 'exact' })
    .in('bot_id', botIds)
    .eq('kind', 'refund')
    .order('created_at', { ascending: false })
    .limit(PAYMENT_ROW_LIMIT);
  const cut = (res: { count: number | null; data: unknown[] | null }) => (res.count ?? 0) > (res.data?.length ?? 0);
  let refundReasons: RefundReasons | null = null;
  if (refundRes.error) console.error('[dashboard] 환불 사유 집계 실패:', refundRes.error.message);
  else if (cut(refundRes)) console.error('[dashboard] 환불 사유 표본이 상한에 닿았습니다');
  else if (cut(insightsRes) || cut(runsRes)) console.error('[dashboard] 환불 사유 — 인사이트·실행 목록이 상한에 닿았습니다');
  else {
    const refunds = refundRes.data ?? [];
    const refundConversationIds = [...new Set(refunds.map((r) => r.conversation_id as string | null).filter((id): id is string => Boolean(id)))];
    const refundMessageRes = await Promise.all(
      chunked(refundConversationIds, REFUND_CHUNK).map((chunk) =>
        db
          .from('messages')
          .select('id, conversation_id, created_at', { count: 'exact' })
          .in('bot_id', botIds)
          .in('conversation_id', chunk)
          .limit(PAYMENT_ROW_LIMIT),
      ),
    );
    const messageError = refundMessageRes.find((chunk) => chunk.error)?.error;
    if (messageError) console.error('[dashboard] 환불 대화 메시지 조회 실패:', messageError.message);
    else if (refundMessageRes.some(cut)) console.error('[dashboard] 환불 대화 메시지가 상한에 닿았습니다');
    else {
      const refundMessages = refundMessageRes.flatMap((chunk) => chunk.data ?? []);
      const refundMessageIds = new Set(refundMessages.map((m) => m.id as string));
      // 묶음 제목은 환불 대화에 걸린 인사이트의 묶음만 읽는다. 실패해도 숫자는 맞다 — 제목 대신 인사이트 요약을 쓴다.
      const groupIds = [
        ...new Set(
          insights
            .filter((i) => [i.message_id, ...(i.source_message_ids ?? [])].some((id) => refundMessageIds.has(id)))
            .map((i) => i.group_id as string | null)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const groupRes = await Promise.all(
        chunked(groupIds, REFUND_CHUNK).map((chunk) =>
          db.from('insight_groups').select('id, title').in('bot_id', botIds).in('id', chunk),
        ),
      );
      const groupError = groupRes.find((chunk) => chunk.error)?.error;
      if (groupError) console.error('[dashboard] 환불 사유 묶음 제목 조회 실패:', groupError.message);
      refundReasons = aggregateRefundReasons({
        refunds,
        messages: refundMessages,
        insights,
        runs,
        groups: groupRes.flatMap((chunk) => chunk.data ?? []),
      });
    }
  }

  // `connected` 는 보고 있는 봇 전체, 연결 카드는 «소유한» 봇만 본다(타입 주석).
  // 소유 봇은 `?botId=` 면 role 로, 아니면 ownedBotIds 로 가린다.
  const ownedIds = auth.role ? (auth.role === 'owner' ? botIds : []) : (auth.ownedBotIds ?? []);
  const connectedById = new Map(paypalBots.map((bot) => [bot.id as string, isPayPalConnected(bot)]));
  const payments: DashboardPayments = {
    connected: botIds.some((id) => connectedById.get(id) === true),
    connectBotId: ownedIds.find((id) => connectedById.get(id) !== true) ?? null,
    inquiries7d,
    autoRefunds7d,
    pendingApprovals,
    refundReasons,
  };

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
      userName: m.author_name ?? personLabelFor(m.source ?? '', localeFromRequest(req)),
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

  // 활동 피드 — 분류·PR 이벤트를 시간순으로 섞는다. 문구는 요청 언어로(messages/<locale>/server.json).
  const feedT = serverT(localeFromRequest(req), 'server.feed');
  const summaryByInsight = new Map(insights.map((i) => [i.id, i.summary]));
  const events: LoopEvent[] = [
    ...insights.map<LoopEvent>((i) => ({
      id: `insight-${i.id}`,
      kind: 'classified',
      title: i.summary,
      detail: feedT('classified', { category: i.category }),
      at: i.created_at,
    })),
    ...runs.map<LoopEvent>((r) => ({
      id: `run-${r.id}`,
      kind: r.status === 'completed' && r.pr_url ? 'pr_created' : 'pr_failed',
      title:
        r.status === 'completed' && r.pr_number
          ? feedT('prCreated', { number: r.pr_number })
          : feedT('autoFixRun'),
      detail:
        (r.insight_id ? summaryByInsight.get(r.insight_id) : null) ??
        (r.status === 'completed' ? feedT('fixCreated') : feedT('status', { status: r.status })),
      at: r.created_at,
    })),
    ...responses
      .filter((r) => r.response_type === 'loop_closed')
      .map<LoopEvent>((r) => ({
        id: `return-${r.trigger_message_id ?? r.conversation_id}-${r.sent_at}`,
        kind: 'returned',
        title: r.response_body,
        detail: r.delivered_at ? feedT('notified') : feedT('notifyPending'),
        at: r.delivered_at ?? r.sent_at,
      })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 20);

  return NextResponse.json({
    stats: { ...stats, loopTime, confirmation, githubReadyBotIds },
    feedbacks,
    events,
    payments,
  });
}

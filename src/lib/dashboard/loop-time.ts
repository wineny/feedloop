// 루프 시간 — 「제보가 들어와서 반영 소식이 그 사람에게 닿기까지」 평균.
//
// ── 정의 (분자·분모를 여기 적어 둔다. 화면 문구보다 이 주석이 기준이다) ──
//
// 표본 1건 = **전달된 되돌림 1건**(`responses.response_type='loop_closed'` 이고 `delivered_at` 이 있는 행).
//   분자: `delivered_at` − 그 되돌림이 답한 **첫 제보의 `messages.detected_at`**
//   분모: 그렇게 짝이 지어진 되돌림 건수
//
// 「그 되돌림이 답한 제보」를 고르는 법은 되돌림을 «누구에게 보낼지» 정한 규칙과 같은 것을 쓴다
// (`lib/auto-dev/loop-closed.ts` 의 `conversationsOf`): 되돌림을 만든 실행(run)에 묶인 인사이트들의
// 원본 메시지 중, **그 되돌림이 간 대화에 속한** 것만 본다. 한 대화에 여러 건이면 가장 이른 것이
// 「첫 제보」다. 인사이트가 중복 제보를 흡수한 경우(`source_message_ids`)도 같은 사람의 제보라
// 후보에 넣는다 — 그래야 「처음 말한 시각」이 된다.
//
// 이렇게 좁히는 이유: 한 대화에는 서로 다른 문제가 섞여 있고, 되돌림이 나간 뒤에 들어온 제보도
// 있다(`lib/dashboard/feedback-delivery.ts` 의 주석과 같은 사정). 대화의 첫 메시지를 그냥 쓰면
// 이 되돌림과 아무 상관 없는 제보가 분자를 부풀린다.
//
// 표본에서 **빼는** 것:
//   - 아직 전달되지 않은 되돌림(`delivered_at` NULL) — 아직 끝나지 않은 루프다
//   - 짝이 될 제보를 못 찾은 되돌림 — 시간을 추측하지 않는다
//   - 되돌림보다 «나중에» 들어온 제보만 남는 경우(음수 간격)
//
// ⚠️ 알려진 누락: 채널톡은 한 사람이 유저챗을 여러 개 열 수 있어, 되돌림이 «대표 대화» 하나로만
//    나간다(`loop-closed.ts` 의 `foldByPerson` — 대표는 `last_message_at` 이 가장 최근인 대화).
//    그 사람이 제보한 대화와 대표 대화가 다르면 이 되돌림은 같은 대화 안에서 짝을 못 찾아
//    표본에서 빠진다. 평균이 «틀리는» 게 아니라 그런 건이 «안 세어지는» 것이다.
//    사람 단위로 이으려면 `conversations.channel_person_id` 까지 읽어야 해서 지금은 하지 않는다.

export interface LoopTimeResponse {
  conversation_id: string | null;
  response_type: string;
  delivered_at: string | null;
  auto_dev_run_id: string | null;
}

export interface LoopTimeRun {
  id: string;
  insight_id: string | null;
  group_id: string | null;
}

export interface LoopTimeInsight {
  id: string;
  message_id: string | null;
  source_message_ids?: string[] | null;
  group_id: string | null;
}

export interface LoopTimeMessage {
  id: string;
  conversation_id: string | null;
  detected_at: string;
}

/**
 * `empty`(아직 표본이 없다)와 `error`(표본을 못 읽었다)는 **다른 사실**이다.
 * 둘을 같은 「아직 없음」으로 그리면, 집계가 깨진 화면이 「아직 아무 일도 없다」처럼 보인다.
 */
export type LoopTimeState = 'ok' | 'empty' | 'error';

export interface LoopTimeStats {
  state: LoopTimeState;
  /** 짝이 지어진 되돌림 건수 = 평균의 분모 */
  sampleSize: number;
  /** 평균 소요 시간(밀리초). 표본이 없으면 null — 0 으로 뭉개지 않는다 */
  averageMs: number | null;
}

export const EMPTY_LOOP_TIME: LoopTimeStats = { state: 'empty', sampleSize: 0, averageMs: null };

/** 표본을 못 읽었을 때. 숫자를 0 으로 채우지 않고 「집계 못 함」이라고 말한다. */
export const FAILED_LOOP_TIME: LoopTimeStats = { state: 'error', sampleSize: 0, averageMs: null };

/** 되돌림이 간 대화 id 들. 이 대화들의 메시지만 조회하면 되므로 쿼리 범위를 좁히는 데 쓴다. */
export function loopClosedConversationIds(responses: LoopTimeResponse[]): string[] {
  const ids = new Set<string>();
  for (const r of responses) {
    if (r.response_type !== 'loop_closed' || !r.delivered_at || !r.conversation_id) continue;
    ids.add(r.conversation_id);
  }
  return [...ids];
}

export function loopTimeStats(
  responses: LoopTimeResponse[],
  runs: LoopTimeRun[],
  insights: LoopTimeInsight[],
  messages: LoopTimeMessage[],
): LoopTimeStats {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const messageById = new Map(messages.map((m) => [m.id, m]));

  // 인사이트를 id·묶음으로 미리 색인한다. 예전엔 되돌림마다 인사이트 전체를 훑어
  // 되돌림 수 × 인사이트 수만큼 돌았다 — 실행 수백 개면 그대로 곱해진다.
  const insightById = new Map<string, LoopTimeInsight>();
  const insightsByGroup = new Map<string, LoopTimeInsight[]>();
  for (const insight of insights) {
    insightById.set(insight.id, insight);
    if (insight.group_id === null) continue;
    const bucket = insightsByGroup.get(insight.group_id);
    if (bucket) bucket.push(insight);
    else insightsByGroup.set(insight.group_id, [insight]);
  }

  // run 하나에 되돌림이 여러 건(사람 수만큼) 달리므로 실행당 한 번만 계산해 둔다.
  const messageIdsByRun = new Map<string, string[]>();
  const messagesOfRun = (runId: string): string[] => {
    const cached = messageIdsByRun.get(runId);
    if (cached) return cached;

    const run = runById.get(runId);
    const ids = new Set<string>();
    if (run) {
      // 직결 인사이트와 묶음 인사이트의 «합집합». 둘 다 그 실행이 고친 문제를 말한 제보다.
      const linked = [
        ...(run.insight_id !== null ? [insightById.get(run.insight_id)] : []),
        ...(run.group_id !== null ? insightsByGroup.get(run.group_id) ?? [] : []),
      ];
      for (const insight of linked) {
        if (!insight) continue;
        if (insight.message_id) ids.add(insight.message_id);
        for (const source of insight.source_message_ids ?? []) ids.add(source);
      }
    }

    const list = [...ids];
    messageIdsByRun.set(runId, list);
    return list;
  };

  let total = 0;
  let sampleSize = 0;

  for (const response of responses) {
    if (response.response_type !== 'loop_closed') continue;
    if (!response.delivered_at || !response.conversation_id || !response.auto_dev_run_id) continue;

    const deliveredAt = Date.parse(response.delivered_at);
    if (!Number.isFinite(deliveredAt)) continue;

    let firstReportAt = Number.POSITIVE_INFINITY;
    for (const messageId of messagesOfRun(response.auto_dev_run_id)) {
      const message = messageById.get(messageId);
      if (!message || message.conversation_id !== response.conversation_id) continue;
      const detectedAt = Date.parse(message.detected_at);
      if (!Number.isFinite(detectedAt)) continue;
      if (detectedAt < firstReportAt) firstReportAt = detectedAt;
    }

    if (!Number.isFinite(firstReportAt)) continue;
    const elapsed = deliveredAt - firstReportAt;
    if (elapsed < 0) continue;

    total += elapsed;
    sampleSize += 1;
  }

  if (sampleSize === 0) return EMPTY_LOOP_TIME;
  return { state: 'ok', sampleSize, averageMs: Math.round(total / sampleSize) };
}

/**
 * 사람이 읽는 단위 하나로만 말한다 — 「2.4일」·「5시간」·「37분」.
 * 초 단위는 쓰지 않는다(루프에 사람 손이 끼는 값이라 1분 밑은 의미가 없다).
 */
export function formatLoopDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '아직 없음';

  const minutes = ms / 60_000;
  if (minutes < 1) return '1분 미만';
  if (Math.round(minutes) < 60) return `${Math.round(minutes)}분`;

  const hours = minutes / 60;
  if (Math.round(hours) < 24) return `${Math.round(hours)}시간`;

  const days = Math.round((hours / 24) * 10) / 10;
  return Number.isInteger(days) ? `${days}일` : `${days.toFixed(1)}일`;
}

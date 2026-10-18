// 위젯 즉답이 «이 대화에서 앞서 오간 것»을 보게 만드는 재료.
//
// 왜 필요한가 (셀프 QA I-05) — 위젯 즉답은 이번 메시지 «한 줄»만 모델에 넘겼다.
// 카카오·텔레그램은 「최근 대화:」 를 싣는데 위젯만 안 실었다. 그래서 꼬리질문에 대한
// 답(「피씨야. aside」)을 받은 모델이 앞 제보를 못 보고 처음부터 다시 시작했고,
// 분류도 턴 단위라 **대화 하나가 인사이트 다섯 개**로 쪼개졌다. 카테고리가 다르면
// 묶기가 합치지 않으므로 그 조각들이 그대로 묶음이 되고 자동 PR 후보가 된다.
//
// 두 가지를 싣는다:
//   1. 최근 N턴  — 지금 메시지가 무엇에 «대한» 말인지 알게 한다.
//   2. 이 대화의 기존 제보 목록 — 지금 턴이 그중 하나의 «보충»이면 새 제보를 만들지
//      말고 그 제보를 갱신하라고 시킨다(프롬프트 「### 이어지는 제보」).

import { getServiceRoleClient } from '@/lib/supabase';
import { collapseWhitespace } from '@/lib/text';
import { buildRefMapBy } from '@/lib/classify/ref';
import type { TimelineItem, TimelineKind } from './conversations';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** 타임라인 뒤에서 몇 턴을 실을지. 8턴 × 300자 ≈ 2.4K자 — 위젯 10초 예산 안이다. */
export const RECENT_TURNS = 8;
/** 턴 하나의 상한. 방문자 본문은 2,000자까지 올 수 있어 그대로 실으면 한 턴이 맥락을 다 먹는다. */
export const TURN_CHARS = 300;
/** 갱신 후보로 보여줄 기존 제보 수. 늘리면 모델이 «아무거나 골라 붙일» 여지가 커진다. */
export const EXTENDABLE_LIMIT = 3;

export interface RecentTurn {
  kind: TimelineKind;
  body: string;
}

/**
 * 타임라인의 말하는 쪽을 프롬프트 라벨로 바꾼다.
 *
 * 운영자 답장도 «서비스 이름»으로 부른다 — 방문자 화면에도 그 이름으로 뜨기 때문이다.
 * AI 와 사람을 갈라 보여주면 모델이 「저건 내가 한 말이 아니다」로 읽고 맥락에서 뺀다.
 */
function turnLabel(kind: TimelineKind, serviceName: string): string {
  if (kind === 'user') return '방문자';
  if (kind === 'system' || kind === 'notice') return '안내';
  return serviceName;
}

/**
 * 최근 대화 블록. 없으면 빈 문자열(호출부가 그러면 그 줄을 통째로 뺀다).
 *
 * @param currentMessageId 지금 막 저장한 메시지. **반드시 뺀다** — 저장이 LLM 호출보다
 *        먼저라 타임라인에 이미 들어 있고, 그대로 두면 같은 문장이 「최근 대화」와
 *        「지금 메시지」에 두 번 실려 모델이 두 번 말한 것으로 읽는다.
 */
export function formatRecentContext(
  items: TimelineItem[],
  currentMessageId: string | null,
  serviceName: string,
): string {
  // 이름은 라벨 자리에 리터럴로 들어간다. 개행이 남으면 가짜 화자 줄을 만들 수 있다.
  const name = collapseWhitespace(serviceName) || '운영자';

  const turns: RecentTurn[] = items
    .filter((i) => i.id !== currentMessageId)
    .map((i) => ({ kind: i.kind, body: collapseWhitespace(i.body).slice(0, TURN_CHARS) }))
    .filter((t) => t.body !== '')
    .slice(-RECENT_TURNS);

  return turns.map((t) => `${turnLabel(t.kind, name)}: ${t.body}`).join('\n');
}

export interface ExtendableInsight {
  id: string;
  category: string;
  summary: string;
  source_message_ids: string[];
}

/**
 * 같은 대화에서 나온, 아직 묶이지 않고 PR 도 없는 인사이트 최신 3건.
 *
 * `group_id IS NULL` 로 거르는 이유: 이미 묶인 제보를 갱신하면 묶음의 근거가 사람 몰래
 * 바뀐다. 그 묶음으로 스펙 초안이 나갔거나 PR 이 떴을 수 있다.
 *
 * `auto_dev_runs` 가 있는 것도 뺀다. 리뷰어가 PR 본문에서 본 근거와 DB 의 근거가
 * 달라지는 것이 가장 나쁘다. 이건 **1차 방어**다 — 프롬프트에 안 보여주면 모델이
 * 고를 수 없다. 2차는 `extend_insight` 함수의 `NOT EXISTS` 이고, 그쪽이 진짜 경합
 * (후보를 고른 뒤 PR 이 생기는 10초)을 막는다.
 *
 * `messages!inner` 조인으로 대화를 좁힌다 — `insights` 에는 conversation_id 가 없고
 * message_id 만 있다.
 */
export async function listExtendableInsights(
  conversationId: string,
  before?: string,
): Promise<ExtendableInsight[]> {
  const { data, error } = await db()
    .from('insights')
    .select('id, category, summary, source_message_ids, created_at, messages!inner(conversation_id, detected_at)')
    .eq('messages.conversation_id', conversationId)
    .lte('messages.detected_at', before ?? new Date().toISOString())
    .is('group_id', null)
    .order('created_at', { ascending: false })
    .limit(EXTENDABLE_LIMIT);

  if (error) {
    if (before) throw new Error('recovery_insight_context_unavailable');
    // 맥락이 없어도 즉답은 나가야 한다. 다만 조용히 비면 「왜 갱신이 안 되지」를
    // 추적할 방법이 없으므로 반드시 남긴다(컬럼 하나가 없어도 여기로 온다).
    console.error('[reply-context] listExtendable error:', error.message);
    return [];
  }

  const rows = (data ?? []).map((row) => ({
    id: row.id as string,
    category: String(row.category ?? ''),
    summary: String(row.summary ?? ''),
    source_message_ids: (row.source_message_ids as string[] | null) ?? [],
  }));
  if (rows.length === 0) return [];

  const withRun = await findInsightsWithRun(rows.map((r) => r.id));
  return rows.filter((r) => !withRun.has(r.id));
}

/**
 * 이 인사이트들 중 자동 PR 실행 기록이 있는 것.
 *
 * 조회가 실패하면 **빈 집합**을 돌려준다 — 후보를 통째로 버리면 갱신 기능이 조용히
 * 멎고, 여기서 새는 경우도 `extend_insight` 의 `NOT EXISTS` 가 막는다.
 */
async function findInsightsWithRun(ids: string[]): Promise<Set<string>> {
  const { data, error } = await db()
    .from('auto_dev_runs')
    .select('insight_id')
    .in('insight_id', ids);

  if (error) {
    console.error('[reply-context] run lookup error:', error.message);
    return new Set();
  }
  return new Set(
    (data ?? [])
      .map((r) => (r as { insight_id?: string | null }).insight_id)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/**
 * ref → 인사이트. 배치 분류가 메시지에 쓰는 것과 **같은 규칙**이다(`classify/ref.ts`).
 * 모델에게 UUID 를 옮겨 적게 하면 한 글자를 틀리고, 그러면 갱신이 조용히 사라진다.
 */
export function buildInsightRefMap(
  insights: ExtendableInsight[],
): Map<string, ExtendableInsight> {
  return buildRefMapBy(insights, (i) => i.id);
}

/** 「이 대화의 기존 제보」 블록. 없으면 빈 문자열. */
export function formatExtendableSection(
  refMap: Map<string, ExtendableInsight>,
): string {
  if (refMap.size === 0) return '';

  const lines = [...refMap].map(([ref, insight]) => {
    // summary 는 모델이 쓴 값이지 방문자 입력이 아니다. 그래도 한 줄로 접는다 —
    // 개행이 있으면 목록의 «항목 경계»를 흉내 낼 수 있고, 한 줄이 규칙이면
    // 나중에 이 값의 출처가 바뀌어도(사람이 손으로 고친 summary 등) 안전하다.
    const summary = collapseWhitespace(insight.summary).slice(0, TURN_CHARS);
    const category = collapseWhitespace(insight.category) || 'other';
    return `- [${ref}] ${category} · ${summary}`;
  });

  return ['이 대화의 기존 제보 (보충이면 extends 에 ref):', ...lines].join('\n');
}

/**
 * 위젯 유저 턴 조립 — 카카오의 「최근 대화 / 지금 메시지」 틀을 그대로 쓴다.
 *
 * 순서가 중요하다. 근거 상기(`reminder`)는 **맨 끝**이어야 한다 — 저가 모델은 앞쪽
 * 규칙을 자주 놓치고, 마지막 줄은 덜 놓친다(2026-09-10 실측 4/9 → 7/9).
 */
export function buildWidgetUserTurn(p: {
  recent: string;
  extendable: string;
  /**
   * F1 「이미 접수된 문제」 블록(`groups/existing-match.ts`). `extendable` 과 «따로» 받는다 —
   * 호출부에서 둘을 미리 이어 붙이면 한쪽이 비었을 때의 구분자 처리가 라우트로 새고,
   * 블록 순서도 라우트가 정하게 된다. 순서는 여기 한 곳에서만 정한다.
   */
  knownIssues?: string;
  text: string;
  hintLine: string;
  reminder: string;
}): string {
  const blocks: string[] = [];
  if (p.recent) blocks.push(`최근 대화:\n${p.recent}`);
  if (p.extendable) blocks.push(p.extendable);
  if (p.knownIssues) blocks.push(p.knownIssues);
  blocks.push(`지금 메시지:\n사용자: ${p.text}${p.hintLine}\n${p.reminder}`);
  return blocks.join('\n\n');
}

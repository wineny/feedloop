// 피드백 묶기 — 비슷한 인사이트를 하나로 모아 묶음당 PR 1개를 만든다.
//
// 왜 묶는가: 같은 버그를 열 명이 제보하면 지금은 PR 이 열 개 생긴다.
// 묶어두면 PR 하나로 고치고, 되돌림은 그 묶음에 속한 사람 전원에게 간다.

import { getServiceRoleClient } from '@/lib/supabase';
import { getBotConfigFromDB } from '@/lib/bot/core';
import { callLlm, type BotConfig } from '@/lib/bot/handler';
import { GROUPABLE_CATEGORIES, isGroupable, normalizeCategory } from '@/lib/classify/taxonomy';
import { groupAction } from '@/lib/groups/policy';
import { scoreGroupImpact } from '@/lib/groups/priority';
import {
  closeLoopForRejoins,
  matchOutcome,
  EXISTING_GROUPS_LIMIT,
  type ExistingGroup,
  type RejoinedGroup,
} from '@/lib/groups/existing-match';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** 한 번에 묶을 인사이트 상한. 프롬프트가 커지면 모델이 대충 묶는다. */
const MAX_INSIGHTS_PER_RUN = 40;

/**
 * 모델을 태우지 않고 바로 닫는 입구.
 *
 * 이 한 값이 「채널톡 한정」의 전부다. 웹·카카오 인사이트는 분류가 무엇이든 종전 경로
 * 그대로다 — 기존 묶음이 대시보드에서 사라지면 안 된다.
 */
const AUTO_DISMISS_SOURCE = 'channel';

/** 자동 닫힘 묶음 제목 길이. 원문 요약을 그대로 쓰되 목록에서 넘치지 않게 자른다. */
const DISMISSED_TITLE_MAX = 80;

/** 자동 닫힘 후보를 고를 때 읽는 행. 조인은 객체 또는 배열로 온다. */
interface DismissableRow {
  id: string;
  bot_id: string;
  category: string;
  summary: string | null;
  message_id: string | null;
  messages: unknown;
}

/** 조인된 메시지의 `source`. 메시지가 없으면(=`message_id` 가 NULL) null. */
function joinedSource(raw: unknown): string | null {
  const msg = (Array.isArray(raw) ? raw[0] : raw) as { source?: string } | null;
  return msg?.source ?? null;
}

/**
 * 이 인사이트를 모델에 안 태우고 바로 `dismissed` 묶음으로 닫아도 되는가.
 *
 * 조건이 둘 다여야 한다 — 채널톡에서 왔고(`source`), 그 다음에 할 일이 없는 분류
 * (`groupAction === 'none'` = 칭찬·문의·기타)여야 한다. 채널톡 버그 제보는 여전히
 * 프롬프트로 간다. 그리고 `message_id` 가 NULL 이면 어느 입구인지 알 수 없으므로
 * **채널톡이 아닌 것으로 취급한다** — `saveInsight` 가 null 을 허용하는 실재 경로다.
 */
function isAutoDismissable(row: DismissableRow): boolean {
  return joinedSource(row.messages) === AUTO_DISMISS_SOURCE && groupAction(row.category) === 'none';
}

/**
 * 채널톡의 「할 일 없는」 인사이트를 모델 없이 1건짜리 `dismissed` 묶음으로 닫는다.
 *
 * ⚠️ 왜 `pipeline_group_snapshot` 이 아니라 따로 읽는가 — 그 RPC 는 서버에서
 * `category IN ('bug','ux','feature_request')` 로 거른다. 문의·칭찬은 아예 안 넘어오므로
 * 자동 닫힘을 거기에 얹을 수 없다. 두 집합은 카테고리로 배타적이라 스냅샷/커밋의
 * revision 잠금과 다투지 않는다 — 같은 인사이트를 두 경로가 만지는 일이 없다.
 *
 * 묶지 않고 두면 `group_id` 가 계속 NULL 이라 받은편지함에 영원히 미처리로 남는다.
 */
async function dismissChannelChatter(botId: string): Promise<number> {
  const { data, error } = await db()
    .from('insights')
    .select('id, bot_id, category, summary, message_id, messages(source)')
    .eq('bot_id', botId)
    .is('group_id', null)
    .not('category', 'in', `(${GROUPABLE_CATEGORIES.join(',')})`)
    .order('created_at', { ascending: false })
    .limit(MAX_INSIGHTS_PER_RUN);

  if (error) throw new Error(`auto_dismiss_lookup_failed: ${error.message}`);

  const rows = ((data ?? []) as unknown as DismissableRow[]).filter(isAutoDismissable);
  let dismissed = 0;

  for (const row of rows) {
    const summary = row.summary?.trim() || '내용 없음';
    const { data: group, error: insertError } = await db()
      .from('insight_groups')
      .insert({
        bot_id: row.bot_id,
        title: summary.slice(0, DISMISSED_TITLE_MAX),
        summary,
        category: row.category,
        status: 'dismissed',
      })
      .select('id')
      .single();

    if (insertError || !group) {
      console.error('[grouping] dismiss insert error:', insertError?.message);
      continue;
    }

    // 봇으로 한 번 더 좁힌다. `group_id IS NULL` 조건은 그사이 누가 묶었으면 건너뛰게 한다.
    const { error: linkError } = await db()
      .from('insights')
      .update({ group_id: group.id })
      .eq('id', row.id)
      .eq('bot_id', botId)
      .is('group_id', null);

    if (linkError) {
      console.error('[grouping] dismiss link error:', linkError.message);
      continue;
    }

    dismissed += 1;
  }

  return dismissed;
}

export interface UngroupedInsight {
  id: string;
  category: string;
  summary: string;
  /**
   * I-11 — 이 제보가 온 대화. 같은 사람이 이어 말한 조각을 모델이 알아보게 한다.
   * 스냅샷 RPC(`20260916_03`)가 싣는다. 메시지가 없는 인사이트(message_id NULL)는 null.
   */
  conversation_id?: string | null;
}

/** 프롬프트에 싣는 대화 라벨. 전체 uuid 는 토큰만 먹는다 — 앞 8자로 같은 대화인지만 알아보면 된다. */
export function conversationTag(conversationId: string | null | undefined): string | null {
  if (typeof conversationId !== 'string' || conversationId.length < 8) return null;
  return `#${conversationId.slice(0, 8)}`;
}

// 대조의 판단(어느 상태에 합류하는가·언제 되돌림을 만드는가)은 `existing-match.ts` 한 곳에 있다.
// 즉답(F1)도 같은 모듈을 쓰므로 여기서는 타입만 다시 내보낸다.
export type { ExistingGroup };

export interface ProposedGroup {
  /**
   * 이 묶음이 «기존 묶음» 과 같은 문제라면 그 id. 없으면 null/생략.
   * 백로그 B1 이 `matches_existing_group_id` 라 부른 것과 같은 값이다 — 모델이 그 이름으로
   * 답하는 경우도 있어 `validateGroups` 가 둘 다 받는다.
   */
  existing_group_id?: string;
  matches_existing_group_id?: string | null;
  title: string;
  summary: string;
  category: string;
  insight_ids: string[];
}

export function buildGroupingPrompt(insights: UngroupedInsight[], existing: ExistingGroup[] = []): string {
  const list = insights
    .map((i) => {
      const tag = conversationTag(i.conversation_id);
      return `- id: ${i.id}\n  분류: ${i.category}${tag ? `\n  대화: ${tag}` : ''}\n  요약: ${i.summary}`;
    })
    .join('\n');

  return `당신은 유저 피드백을 정리하는 전문가입니다. 아래 피드백들을 **같은 문제끼리** 묶으세요.

## 기존 묶음 (이 봇만, 최근 ${EXISTING_GROUPS_LIMIT}개 · 머지된 묶음도 포함)
${JSON.stringify(existing)}
같은 증상·문제이면 새 묶음을 만들지 말고 existing_group_id 에 기존 id 를 지정하세요.
**여기 없는 id 는 쓰지 마세요.** 새 id 를 지어내면 그 묶음은 통째로 버려집니다.
같은 문제가 아니면 existing_group_id 는 null 입니다.
status 가 뜻하는 것 — open: 아직 고치는 중 · pr_created: 수정 PR 을 기다리는 중 ·
merged: 수정이 반영됨 · dismissed: 운영자가 닫음.
머지됨(merged)은 배포·해결 확인이 아닙니다. 같은 증상이면 반드시 그 기존 묶음의 후속 확인입니다.
수정 대상(bug/ux)과 기능 명세(feature_request)는 합치지 마세요.

## 피드백 목록
${list}

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.

\`\`\`json
{
  "groups": [
    {
      "existing_group_id": null,
      "title": "쿠폰 적용 버튼이 눌리지 않음",
      "summary": "결제 화면에서 쿠폰 적용 버튼을 눌러도 반응이 없다는 제보. 모바일·PC 모두에서 보고됨.",
      "category": "bug",
      "insight_ids": ["${insights[0]?.id ?? ''}"]
    }
  ]
}
\`\`\`

## 규칙
- **insight_ids 의 모든 값은 위 목록에 있는 id 를 글자 그대로 써야 합니다.** 새 id 를 지어내지 마세요.
- **existing_group_id 는 「기존 묶음」 목록의 id 이거나 null 입니다.** 피드백 id 를 여기 쓰지 마세요.
- 같은 원인·같은 화면의 문제만 한 묶음으로. 애매하면 따로 두세요.
- **같은 「대화」에서 온 제보는 한 사람이 이어 말한 것일 가능성이 높습니다.** 같은 화면·같은 증상을
  더 자세히 말한 것이면 한 묶음으로 두세요. 단 같은 대화라도 다른 문제(예: 쿠폰함 흰 화면 vs 지도 안 뜸)면 따로 두세요.
- 혼자인 피드백도 **1개짜리 묶음**으로 만드세요. 빠뜨리지 마세요.
- title 은 개발자가 보고 바로 이해할 한 줄. summary 는 수정 작업의 근거가 되도록
  증상·재현 조건·영향 범위를 담으세요.
- category 는 그 묶음을 대표하는 값 하나 (bug | ux | feature_request).
  **고장이 있으면 bug, 고장은 없는데 쓰기 나쁘면 ux, 지금 없는 능력을 원하면 feature_request.**
  섞인 묶음이면 가장 많은 쪽을 따른다.`;
}

/**
 * 묶음의 대표 카테고리를 정한다.
 *
 * 모델이 `cs`·`other` 같은 묶음 밖 값을 주면 `groupAction` 이 'none' 을 돌려줘
 * **버튼이 하나도 없는 죽은 묶음**이 된다 — 운영자는 그걸 닫는 것 말고 할 게 없다.
 * 이때는 모델 말 대신 **속한 인사이트의 다수결**을 쓴다. 그 값들은 이미 taxonomy 로
 * 분류돼 `normalizeCategory` 를 통과한 것이라 믿을 만하다.
 */
export function resolveGroupCategory(
  raw: unknown,
  ids: string[],
  categoryOf?: ReadonlyMap<string, string>,
): string | null {
  const proposed = normalizeCategory(raw);
  if (isGroupable(proposed)) return proposed;
  // 판단 근거가 없으면 모델 값을 그대로 쓴다(옛 동작). 묶음이 죽을 수 있지만
  // 없는 근거로 지어내는 것보다 낫다.
  if (!categoryOf) return proposed;

  const tally = new Map<string, number>();
  for (const id of ids) {
    const c = categoryOf.get(id);
    if (c && isGroupable(c)) tally.set(c, (tally.get(c) ?? 0) + 1);
  }

  // ⚠️ `tally` 를 순회하지 않고 **`GROUPABLE_CATEGORIES` 를** 순회한다.
  // Map 순회는 삽입 순서 = `ids` 순서 = **모델이 insight_ids 를 나열한 순서**라,
  // 동률(ux 1 : feature_request 1)일 때 모델 출력 순서가 승자를 정했다. 그건
  // 라벨만의 문제가 아니다 — `groupAction` 이 'pr' 이냐 'spec' 이냐가 갈린다.
  // 이제 동률이면 언제나 bug > ux > feature_request 순으로 확정된다.
  let best: string | null = null;
  let bestCount = 0;
  for (const c of GROUPABLE_CATEGORIES) {
    const n = tally.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }

  // 전부 0 — 묶기 불가 카테고리만 든 묶음이다. 호출부가 이 묶음을 버린다.
  // 여기서 아무 값이나 채우면 「버튼 하나 없는 죽은 묶음」이 생긴다.
  return best;
}

/**
 * 모델 응답을 레코드로 만들기 전에 거른다 — 지어낸 id 와 빈 묶음을 버린다.
 *
 * @param categoryOf 인사이트 id → 카테고리. 모델이 묶음 밖 카테고리를 줬을 때
 *        다수결의 근거가 된다. 없으면 모델 값을 정규화만 해서 쓴다.
 */
export function validateGroups(
  proposed: ProposedGroup[],
  known: Set<string>,
  categoryOf?: ReadonlyMap<string, string>,
  existing: ExistingGroup[] = [],
): ProposedGroup[] {
  const used = new Set<string>();
  const result: ProposedGroup[] = [];

  for (const g of proposed) {
    if (typeof g?.title !== 'string' || g.title.trim() === '') continue;
    if (!Array.isArray(g.insight_ids)) continue;

    // 목록에 없는 id 는 버리고, 한 인사이트가 두 묶음에 들어가지 않게 한다.
    const ids = [...new Set(g.insight_ids)].filter((id) => known.has(id) && !used.has(id));
    if (ids.length === 0) continue;

    const category = resolveGroupCategory(g.category, ids, categoryOf);
    // 대표 카테고리를 정할 수 없는 묶음은 만들지 않는다 — 화면에 버튼이 하나도
    // 안 뜨고 운영자가 닫는 것 말고 할 게 없다. 그 인사이트들은 group_id 가 null 로
    // 남아 다음 묶기에서 다시 후보가 된다.
    if (!category) continue;

    // 백로그 B1 이 말하는 `matches_existing_group_id` 와 같은 값. 모델이 어느 이름으로 답하든 받는다.
    const claimed = g.existing_group_id ?? g.matches_existing_group_id ?? undefined;
    const found = claimed ? existing.find((e) => e.id === claimed) : undefined;
    // 목록 밖 id 는 지어낸 것이다 — 그 묶음은 통째로 버리고 다음 회차에 다시 후보가 되게 둔다
    // (`insight_ids` 의 지어낸 id 와 달리 여기서는 «어느 묶음인지» 자체를 못 믿는다).
    if (claimed && !found) continue;
    // 닫힌(dismissed) 묶음에는 합류하지 않는다. 버리지도 않는다 — 새 묶음으로 두고
    // 운영자가 다시 본다. 판단은 `existing-match.ts` 한 곳에 있다.
    const target = found && matchOutcome(found.status) === 'join' ? found : undefined;
    const isSpec = (c: string) => c === 'feature_request';
    if (categoryOf && ids.some((id) => isSpec(categoryOf.get(id) ?? '') !== isSpec(category))) continue;
    if (target && isSpec(target.category) !== isSpec(category)) continue;
    ids.forEach((id) => used.add(id));
    result.push({
      ...(target ? { existing_group_id: target.id } : {}),
      title: g.title.trim(),
      summary: typeof g.summary === 'string' && g.summary.trim() ? g.summary.trim() : g.title.trim(),
      category,
      insight_ids: ids,
    });
  }

  return result;
}

/** 묶기 호출 예산. 배치 분류(60초)와 같다 — 한 번에 최대 40건이 들어간다. */
const GROUPING_TIMEOUT_MS = 60_000;

const GROUPING_SYSTEM_PROMPT =
  '너는 서비스 피드백을 «같은 문제끼리» 묶는 도우미다. 지시된 JSON 형식으로만 답한다. JSON 밖의 문장은 버려진다.';

/**
 * 묶기 모델 호출 — **즉답·배치 분류와 같은 경로**(`callLlm`): 봇에 운영자 키가 있으면 그 키·모델,
 * 없으면 플랫폼 폴백(`PLATFORM_LLM_PROVIDER`/`PLATFORM_LLM_MODEL`).
 *
 * 2026-09-13 이전에는 `@google/generative-ai` 로 `gemini-flash-latest` **별칭**을 직접 불렀다(이슈 I-16).
 * 별칭은 Google 이 가리키는 모델을 바꾸면 우리 배포 없이 동작이 바뀌는 자리라 심사 기간에 위험했고,
 * 운영자 키·플랫폼 설정과도 따로 놀았다. 이제 모델은 한 곳(provider.ts)이 정한다.
 *
 * `recordKeyFailure:false` — 40건짜리 묶기 프롬프트가 60초를 넘긴 것은 키 문제가 아니다(배치 분류와 같은 이유).
 * 실패는 throw 로 올려 호출부가 「묶기 실패」로 보이게 한다 — 조용히 0건으로 접지 않는다.
 */
export async function proposeGroups(config: BotConfig, insights: UngroupedInsight[], existing: ExistingGroup[] = [], deadlineMs = Date.now() + GROUPING_TIMEOUT_MS): Promise<ProposedGroup[]> {
  const raw = await callLlm(config, GROUPING_SYSTEM_PROMPT, buildGroupingPrompt(insights, existing), {
    timeoutMs: Math.max(1, Math.min(GROUPING_TIMEOUT_MS, deadlineMs - Date.now())),
    recordKeyFailure: false,
  });
  if (!raw) throw new Error('묶기 모델 호출이 실패했습니다 (키·모델 설정 또는 시간 초과)');

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('묶기 응답에서 JSON을 찾지 못했습니다');

  const parsed = JSON.parse(match[0]) as { groups?: ProposedGroup[] };
  if (!Array.isArray(parsed.groups)) throw new Error('묶기 응답 groups 배열이 없습니다');
  return parsed.groups;
}

export interface GroupingResult {
  grouped: number;
  groups: { id: string; title: string; count: number }[];
  pending?: number;
  deferred?: number;
  failures?: { botId: string; reason: string }[];
  /** 모델을 안 태우고 바로 닫은 인사이트 수(채널톡 문의·칭찬). */
  dismissed?: number;
  /** B1 — 이미 머지된 묶음에 합류해서 「이미 반영됐어요」를 바로 받은 되돌림 수. */
  loopClosed?: number;
  /**
   * B1 되돌림이 실패한 이유. **`failures` 와 «따로» 둔다.**
   *
   * 여기 넣었다가 실제로 깨진 것 둘: ① `auto-pr.ts` 가 `failures` 가 있으면 묶음을 고르기
   * 전에 반환해 **자동 PR 이 통째로 멎었다** ② `runAutoGrouping` 의 `ok` 가 false 가 돼
   * 자동 묶기가 재무장되는데, 재실행은 이미 묶인 인사이트를 다시 안 보므로 **되돌림은
   * 재시도되지 않는다** — 값도 없이 모델 호출만 도는 셈이었다.
   * 묶기는 성공한 것이 맞다. 되돌림 회수는 `check-merged` 크론이 한다.
   */
  loopFailures?: string[];
}

/** Snapshot and commit share a per-bot revision. A stale proposal is never applied. */
export async function runGrouping(botIds: string[], deadlineMs = Date.now() + 240_000): Promise<GroupingResult> {
  const result: GroupingResult = { grouped: 0, groups: [], pending: 0, deferred: 0, failures: [], dismissed: 0, loopClosed: 0, loopFailures: [] };
  for (const botId of [...new Set(botIds)]) {
    if (Date.now() >= deadlineMs) { result.deferred!++; continue; }
    try {
      // 모델을 안 쓰는 값싼 단계라 먼저 한다. 여기서 실패해도 묶기는 계속해야 하므로
      // 바깥 catch 로 던지지 않는다 — 문의를 못 닫은 것과 묶기가 죽은 것은 다른 사건이다.
      try {
        result.dismissed! += await dismissChannelChatter(botId);
      } catch (dismissError) {
        result.failures!.push({
          botId,
          reason: dismissError instanceof Error ? dismissError.message : 'auto_dismiss_failed',
        });
      }

      const { data, error } = await db().rpc('pipeline_group_snapshot', { p_bot_id: botId, p_limit: MAX_INSIGHTS_PER_RUN });
      if (error) throw new Error(error.message);
      const snapshot = data as { revision: number; insights: UngroupedInsight[]; existing: ExistingGroup[]; pending: number };
      if (!snapshot.insights.length) continue;
      // 상한을 «여기서도» 건다. RPC(`20260917_01`)가 이미 자르지만 그 마이그레이션이 아직
      // 안 올라간 DB 에서는 묶음 전부가 실려 프롬프트가 부풀고 모델이 목록을 대충 읽는다.
      // 스냅샷은 오래된 것부터라 뒤에서 자른다 = 최근 N개.
      const existing = snapshot.existing.slice(-EXISTING_GROUPS_LIMIT);
      result.pending! += snapshot.pending;
      const config = await getBotConfigFromDB(botId);
      if (Date.now() >= deadlineMs) { result.deferred!++; continue; }
      const proposed = await proposeGroups(config, snapshot.insights, existing, deadlineMs);
      const valid = validateGroups(proposed, new Set(snapshot.insights.map((i) => i.id)),
        new Map(snapshot.insights.map((i) => [i.id, i.category])), existing);
      if (!valid.length) throw new Error('invalid_or_omitted_proposals');
      if (Date.now() >= deadlineMs) { result.deferred!++; continue; }
      const committed = await db().rpc('pipeline_commit_groups', {
        p_bot_id: botId, p_revision: snapshot.revision, p_groups: valid,
      });
      if (committed.error) throw new Error(committed.error.message);
      const receipt = committed.data as { grouped: number; groups: GroupingResult['groups'] };
      result.grouped += receipt.grouped;
      result.pending! -= receipt.grouped;
      result.groups.push(...receipt.groups);
      if (receipt.grouped < snapshot.insights.length) result.failures!.push({ botId, reason: 'partial_proposal_retryable' });

      // B1 — 이미 머지된 묶음에 합류한 제보에는 「이 문제는 이미 반영됐어요 (PR #N)」를 지금 돌려준다.
      // 커밋이 «성공한 뒤에만» 한다 — 합류가 안 됐는데 되돌림을 보내면 거짓말이 된다.
      // 열림·pr_created 묶음은 합류만 하고 되돌림은 머지 때 다른 사람들과 함께 나간다.
      const statusOf = new Map(existing.map((e) => [e.id, e.status]));
      const rejoined: RejoinedGroup[] = valid
        .filter((g) => g.existing_group_id)
        .map((g) => ({ groupId: g.existing_group_id!, status: statusOf.get(g.existing_group_id!) ?? '' }));
      if (rejoined.length) {
        const closed = await closeLoopForRejoins(botId, rejoined, { deadlineMs });
        result.loopClosed! += closed.delivered;
        // 실패는 삼키지 않되 `failures` 에는 «안» 넣는다 — 그러면 자동 PR 이 멎고
        // 자동 묶기가 값 없이 재무장된다(`loopFailures` 주석 참고). 회수는 크론 몫이다.
        result.loopFailures!.push(...closed.failures);
        if (closed.skippedDeadline > 0) {
          result.loopFailures!.push(`loop_closed_deferred: ${closed.skippedDeadline}건 (크론이 회수)`);
        }
      }
      // 사업 임팩트 실패는 이미 완료된 묶기를 실패로 바꾸지 않는다.
      try {
        await scoreGroupImpact(botId, config, { apply: true, groupIds: receipt.groups.map((g) => g.id), deadlineMs });
      } catch {
        console.warn('[grouping] impact scoring failed');
      }

    } catch (error) {
      result.failures!.push({ botId, reason: error instanceof Error ? error.message : 'grouping_failed' });
    }
  }
  return result;
}

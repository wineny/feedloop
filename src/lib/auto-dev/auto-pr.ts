// 자동 PR 모드 (설계 §5 · 크론 표) — pr_mode='auto' 인 봇마다 하루 1회.
//
// 봇당 **가장 큰 묶음 1개만** PR 을 만든다. 2-pass 엔진이 실측 85~128초라
// 함수 한도 300초 안에서 1개가 안전선이다. 나머지는 다음 날 차례가 온다.
// 승인 모드가 기본인 이유(수정이 옳은지는 사람이 본다)는 여기서도 그대로다 —
// 자동 모드는 "PR 을 여는 것"까지만 자동이고 머지는 여전히 사람이 한다.

import { getServiceRoleClient } from '@/lib/supabase';
import { runClassificationRecovery } from '@/lib/classify/recovery';
import { runGrouping } from '@/lib/groups/grouping';
import { claimRun, executeClaimedRun, loadRun } from '@/lib/auto-dev/execute-run';
import { isCodeFixable } from '@/lib/groups/policy';
import { groupPriority } from '@/lib/groups/priority';
import { isSampleConversation } from '@/lib/demo/sample-marker';

/**
 * 자동 모드가 익명 한 사람의 말만 듣고 PR 을 열지 않게 하는 최소 인원 (I-34 ③ · 심사 §7 T11).
 *
 * 위젯 POST 는 무인증이다 — 아무나 남의 사이트 봇에 `bug` 로 읽힐 문장을 넣을 수 있고,
 * 그 인사이트가 묶이면 크론이 사람 없이 남의 레포에 PR 을 연다. 채널톡 U4 가 같은 이유로
 * 「채널톡이 붙은 봇은 자동 PR 대상이 아니다」를 쿼리에 박아 뒀고, 이건 그 대칭이다.
 *
 * 왜 2인가. 「혼자 한 말」과 「여럿이 같은 말」을 가르는 가장 작은 수다.
 * 3 이상으로 올리면 실제 소규모 서비스에서 자동 모드가 사실상 안 돈다.
 *
 * ⚠️ **이건 우발적 중복을 거르는 장치이지 적대적 우회를 막는 장치가 아니다.**
 * `visitorId` 는 UUID 형식만 검사하므로 난수 두 개면 「서로 다른 대화 2개」가 되고,
 * 연락처 이메일도 형식만 본다(가짜 주소가 통과한다). 그러니 이 문을 「조작이 아님을
 * 증명한다」로 읽으면 안 된다 — 사람 없이 열리는 PR 의 최종 방어는 여전히 **사람이 하는
 * 머지**와 **봇당 하루 1건** 상한이고, 이 게이트는 그 앞에서 「한 사람이 한 번 흘린 말」이
 * 자동으로 PR 이 되는 가장 흔한 경로를 닫을 뿐이다.
 */
export const AUTO_PR_MIN_DISTINCT_CONVERSATIONS = 2;

export interface AutoPrCandidate {
  id: string;
  status: string;
  /** 묶음 대표 분류. 코드로 고칠 수 있는 것만 자동 모드가 집는다. */
  category: string;
  insightCount: number;
  personCount?: number;
  impactCore?: boolean | null;
  /** 이 묶음으로 만든 run 이 하나라도 있으면 true (상태 불문). */
  hasRun: boolean;
  followUpPending?: boolean;
  /**
   * 이 묶음에 인사이트를 낸 **서로 다른 대화** 수. `insightCount` 와 다르다 —
   * 한 사람이 같은 말을 다섯 번 하면 insightCount 는 5 지만 이 값은 1 이다.
   * 익명 1인을 가려내는 건 이쪽이다.
   */
  distinctConversations: number;
  /**
   * 포함된 대화 중 **닿을 수 있는 사람**이 하나라도 있는지. 둘 중 하나면 된다.
   *  - 연락처(이메일·전화)를 남겼다.
   *  - 입구가 사람을 식별한다 — 인증된 입구만 세는 **허용 목록**이다(채널톡·텔레그램).
   *    카카오는 경로 시크릿(I-34 ②)이 붙기 전까지 웹과 같이 취급한다.
   *    목록과 그 이유는 `loadAutoPrCandidates` 안의 `IDENTIFIED_SOURCES` 주석에 있다.
   *
   * 이름이 `hasContact` 가 아닌 이유: `bot/conversations.ts` 에 이름까지 세는 동명 헬퍼가
   * 따로 있어 정의가 다르다. 같은 이름을 두면 읽는 쪽이 둘을 같은 것으로 읽는다.
   */
  hasReachableContact: boolean;
  /**
   * Every conversation of this group is seeded sample history (web + `sample-` visitor,
   * scripts/seed-sample-history.ts). Never a PR: nobody real reported it.
   */
  sampleOnly?: boolean;
}

/**
 * 자동 모드가 이 묶음을 «사람이 뒤에 있는 것» 으로 볼 수 있는가.
 * 닿을 수 있는 사람이 있거나(익명 아님), 서로 다른 대화가 N개 이상이거나(혼자가 아님).
 * 판정의 한계는 `AUTO_PR_MIN_DISTINCT_CONVERSATIONS` 주석 참고 — 적대적 우회에는 약하다.
 */
function isIdentified(c: AutoPrCandidate): boolean {
  return c.hasReachableContact || c.distinctConversations >= AUTO_PR_MIN_DISTINCT_CONVERSATIONS;
}

/**
 * 오늘 PR 을 만들 묶음 하나를 고른다. 순수 함수라 테스트한다.
 *
 * - `open` 이 아닌 묶음은 제외 (pr_created·merged·dismissed).
 * - **코드로 고칠 수 없는 분류는 제외** (기능 요청·칭찬·문의). 자동 모드는 사람이 안 보고 있으므로
 *   수동 실행보다 엄격해야 한다. 기능 요청에 PR 을 열면 대개 쓸모없는 변경이 나온다.
 *   이게 없으면 open 묶음이 후속 문의 하나뿐일 때 크론이 거기에 PR 을 연다.
 * - run 이 있었던 묶음은 상태와 무관하게 제외한다. 실패한 run 을 매일 다시 돌리면
 *   같은 이유("고칠 파일이 없다")로 매일 같은 실패를 반복하며 토큰만 쓴다.
 *   실패 묶음은 운영자가 대시보드에서 직접 다시 시도한다.
 * - **익명 1인 묶음은 제외** (I-34 ③). 연락처가 있거나 서로 다른 대화 N명 이상이어야 한다.
 *   사람이 누르는 [PR 만들기](approve 경로)는 이 함수를 지나지 않으므로 영향이 없다 —
 *   거기엔 화면 앞에 사람이 있고, 이 게이트는 «사람이 없는» 크론만 조인다.
 * - **샘플 기록만 든 묶음은 제외** (`sampleOnly`). 시연용으로 심은 대화라 진짜 제보가 아니다.
 * - 남은 것 중 우선순위 점수가 가장 높은 묶음. 같으면 앞선 것(호출처가 최신순으로 준다).
 */
export function pickGroupForAutoPr(candidates: AutoPrCandidate[]): AutoPrCandidate | null {
  let best: AutoPrCandidate | null = null;
  for (const c of candidates) {
    if (c.status !== 'open' || c.hasRun || c.followUpPending || c.sampleOnly) continue;
    if (!isCodeFixable(c.category)) continue;
    if (!isIdentified(c)) continue;
    const score = (g: AutoPrCandidate) => groupPriority(g.personCount ?? g.distinctConversations, g.insightCount, g.impactCore ?? null).score;
    if (!best || score(c) > score(best)) best = c;
  }
  return best;
}

/**
 * 왜 오늘 이 봇은 PR 을 안 만들었나. `pickGroupForAutoPr` 가 null 을 준 뒤에만 부른다.
 *
 * `anonymous_only` 가 따로 있는 이유: 「고를 게 없었다」와 「익명이라 막았다」는 다른 사건이다.
 * 앞의 것은 평상시고, 뒤의 것은 **누가 익명으로 PR 을 만들려 했다**는 신호일 수 있다.
 * 둘을 같은 문자열로 묶으면 크론 로그에서 그 차이가 사라진다.
 */
export type AutoPrSkipReason = 'no_open_group' | 'anonymous_only' | 'no_eligible_group';

export function autoPrSkipReason(candidates: AutoPrCandidate[]): AutoPrSkipReason {
  if (candidates.length === 0) return 'no_open_group';
  const blockedByIdentity = candidates.some(
    (c) =>
      c.status === 'open' &&
      !c.hasRun &&
      !c.followUpPending &&
      !c.sampleOnly &&
      isCodeFixable(c.category) &&
      !isIdentified(c),
  );
  return blockedByIdentity ? 'anonymous_only' : 'no_eligible_group';
}

export interface AutoPrBotResult {
  botId: string;
  grouped: number;
  groupId: string | null;
  runId: string | null;
  prUrl: string | null;
  error: string | null;
  recovery?: {classified:number;noInsight:number;failed:number;exhausted:number;pending:number;deferred:boolean};
  /** PR 을 안 만들고 끝났을 때의 사유. 만들었으면 없다. */
  skippedReason?: AutoPrSkipReason;
}

function db() {
  return getServiceRoleClient();
}

/**
 * `in()` 한 번에 싣는 id 개수. PostgREST 는 이 목록을 URL 쿼리에 넣으므로 무한정 길면
 * 프록시가 자른다. UUID 36자 × 200 이면 약 7KB 로, 흔한 8KB 한도 아래다.
 */
const ID_CHUNK = 200;
/** 묶음 50개분 인사이트 조회의 상한. 닿으면 경고를 남긴다(아래). */
const MAX_INSIGHT_ROWS = 2000;
/** run 조회 상한. 묶음 50개에 run 이 이보다 많이 붙을 일은 없다 — 있으면 `hasRun` 은 어차피 true 다. */
const MAX_RUN_ROWS = 1000;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 선별기(`pickGroupForAutoPr`)가 보는 값을 DB 에서 만든다. **내보내는 이유**: 진단 스크립트가
 * 같은 값을 손으로 다시 만들면 익명 게이트 같은 조건이 한쪽에만 반영돼, 스크립트가
 * 「자동 모드라면 이걸 고른다」고 거짓말을 한다.
 */
export async function loadAutoPrCandidates(botId: string): Promise<AutoPrCandidate[]> {
  const candidates: AutoPrCandidate[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = await loadAutoPrCandidatePage(botId, offset);
    candidates.push(...page);
    if (page.length < 50) return candidates;
  }
}

async function loadAutoPrCandidatePage(botId: string, offset: number): Promise<AutoPrCandidate[]> {
  const { data: groups,error:groupsError } = await db()
    .from('insight_groups')
    .select('id, status, category, follow_up_pending, impact_core')
    .eq('bot_id', botId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + 49);
  if(groupsError) throw new Error(groupsError.message);
  if (!groups || groups.length === 0) return [];

  const ids = groups.map((g) => g.id as string);
  const [insightsRes, runsRes] = await Promise.all([
    db().from('insights').select('group_id, message_id').in('group_id', ids).limit(MAX_INSIGHT_ROWS),
    db().from('auto_dev_runs').select('group_id').in('group_id', ids).limit(MAX_RUN_ROWS),
  ]);

  if(insightsRes.error || runsRes.error) throw new Error(insightsRes.error?.message ?? runsRes.error?.message);
  const insights = insightsRes.data ?? [];
  // 상한에 «닿으면» 뒤쪽 인사이트가 잘렸다는 뜻이다. 잘린 채로 세면 인원이 실제보다 적게
  // 나오므로 게이트는 닫히는 쪽으로 틀린다(안전한 방향) — 다만 그때 「왜 오늘도 PR 이 안
  // 열리지」의 답이 이 줄이라, 조용히 넘기지 않고 남긴다.
  if (insights.length >= MAX_INSIGHT_ROWS) {
    console.warn(`[auto-pr] ${botId}: insight lookup hit the cap of ${MAX_INSIGHT_ROWS} — the reporter count may be low`);
  }
  const count = new Map<string, number>();
  for (const i of insights) {
    const gid = i.group_id as string;
    count.set(gid, (count.get(gid) ?? 0) + 1);
  }
  const withRun = new Set((runsRes.data ?? []).map((r) => r.group_id as string));

  // 「누가 냈나」를 인사이트 → 메시지 → 대화 로 거슬러 올라간다 (I-34 ③).
  //
  // 조인 한 방이 아니라 조회 셋으로 나눈 이유: 이 값은 «PR 을 열지 말지» 를 정하는
  // 보안 게이트라, 중첩 임베드 문법이 스키마 변화에 조용히 어긋나는 위험을 안 지고 간다.
  // 크론은 봇당 하루 한 번 도니 왕복 몇 번이 더 드는 건 문제가 아니다.
  //
  // `in()` 은 id 를 URL 에 싣는다 — 한 번에 다 넣으면 긴 목록에서 URL 이 잘리거나 거부된다.
  // 그래서 청크로 나눠 돈다. 각 조회에 상한도 명시한다(청크 크기와 같다 — 한 청크가
  // 그보다 많은 행을 줄 수 없다. id 로 찾는 조회라 행 수가 곧 id 수다).
  //
  // 조회가 «실패하면 던진다» — 호출부가 그 봇을 error 로 끝낸다. 셀 수 없는 상태에서
  // 「연락처가 없다」로 읽으면 게이트가 열리는 쪽이 아니라 닫히는 쪽으로 틀리지만,
  // 「2명이다」로 읽으면 열린다. 애매함을 남기지 않고 fail-closed 로 끝낸다.
  const messageIds = [...new Set(insights.map((i) => i.message_id as string | null).filter((m): m is string => Boolean(m)))];
  const conversationByMessage = new Map<string, string>();
  for (const chunk of chunked(messageIds, ID_CHUNK)) {
    const { data, error } = await db()
      .from('messages')
      .select('id, conversation_id')
      .in('id', chunk)
      .limit(ID_CHUNK);
    if (error) throw new Error(error.message);
    for (const m of data ?? []) {
      const cid = m.conversation_id as string | null;
      if (cid) conversationByMessage.set(m.id as string, cid);
    }
  }

  // 「닿을 수 있는 사람」이 있는 대화. 둘 중 하나면 된다.
  //  - 연락처(이메일·전화)를 남겼다.
  //  - 입구 자체가 사람을 식별한다 — 플랫폼 계정이 있고 그 계정으로 답장이 간다.
  //    그런 입구에서는 `conversations` 의 연락처 칸이 비어 있는 게 정상이라, 컬럼만 보면
  //    그 대화가 전부 익명으로 걸려 자동 모드가 거기서는 영영 안 돈다.
  //
  // ⚠️ **이 규칙은 입구가 인증돼 있다는 전제 위에 선다 — 카카오는 I-34 ② 뒤에 추가한다.**
  // 그래서 「web 이 아니면」이라는 차단 목록이 아니라 **허용 목록**이다. 차단 목록으로 두면
  // 비웹 입구 중 «가장 약한 인증»이 이 게이트의 강도를 정한다. 카카오 웹훅은 아직 서명도
  // 경로 시크릿도 없어(I-34 ②, 지금은 `KAKAO_WEBHOOK_ENABLED` 로 닫혀 있다) 누가 다시 켜는
  // 순간 무인증 POST 한 번이 만든 대화가 「식별됨」으로 세어진다. 그때까지 `kakao` 는 web 과
  // 같이 취급한다 — 연락처를 남겼으면 통과, 아니면 인원으로만 센다.
  const IDENTIFIED_SOURCES = new Set([
    'channel', // 채널톡 — 웹훅 토큰 대조가 있다
    'telegram', // 텔레그램 — 봇 토큰 경로
  ]);
  const conversationIds = [...new Set(conversationByMessage.values())];
  const reachableConversations = new Set<string>();
  const sampleConversations = new Set<string>();
  const personKey = new Map<string, string>();
  for (const chunk of chunked(conversationIds, ID_CHUNK)) {
    const { data, error } = await db()
      .from('conversations')
      .select('id, source, external_user_id, contact_email, contact_phone, channel_person_id')
      .in('id', chunk)
      .limit(ID_CHUNK);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) {
      personKey.set(c.id as string, (c.channel_person_id as string | null) ?? (c.id as string));
      const reachable =
        IDENTIFIED_SOURCES.has(c.source as string) ||
        Boolean(c.contact_email) ||
        Boolean(c.contact_phone);
      if (reachable) reachableConversations.add(c.id as string);
      if (isSampleConversation(c as { source?: string | null; external_user_id?: string | null })) sampleConversations.add(c.id as string);
    }
  }

  const conversationsByGroup = new Map<string, Set<string>>();
  for (const i of insights) {
    const mid = i.message_id as string | null;
    const cid = mid ? conversationByMessage.get(mid) : undefined;
    if (!cid) continue;
    const gid = i.group_id as string;
    const set = conversationsByGroup.get(gid) ?? new Set<string>();
    set.add(cid);
    conversationsByGroup.set(gid, set);
  }

  return groups.map((g) => {
    const gid = g.id as string;
    const convs = conversationsByGroup.get(gid) ?? new Set<string>();
    return {
      id: gid,
      status: g.status as string,
      category: (g.category as string) ?? 'other',
      insightCount: count.get(gid) ?? 0,
      followUpPending: g.follow_up_pending === true,
      hasRun: withRun.has(gid),
      distinctConversations: convs.size,
      personCount: new Set([...convs].map((id) => personKey.get(id) ?? id)).size,
      impactCore: g.impact_core ?? null,
      hasReachableContact: [...convs].some((c) => reachableConversations.has(c)),
      sampleOnly: convs.size > 0 && [...convs].every((c) => sampleConversations.has(c)),
    };
  });
}

/** 봇 하나에 대해 묶기 → 묶음 하나 고르기 → run 생성 → 실행. */
export async function runAutoPrForBot(botId: string, deadline = Date.now() + 240_000): Promise<AutoPrBotResult> {
  const result: AutoPrBotResult = {
    botId,
    grouped: 0,
    groupId: null,
    runId: null,
    prUrl: null,
    error: null,
  };

  // Finish a durable publication before creating another candidate. No new generation.
  const {data:pending,error:pendingError}=await db().from('auto_dev_runs')
    .select('id,group_id').eq('bot_id',botId).eq('publication_status','pending')
    .in('status',['failed','unverifiable','stopped','in_progress'])
    .order('created_at',{ascending:true}).limit(1).maybeSingle();
  if(pendingError){result.error=pendingError.message;return result;}
  if(pending){
    result.runId=pending.id;result.groupId=pending.group_id;
    try {
      const token=await claimRun(pending.id);
      if(!token){result.error='Could not acquire the run lease';return result;}
      const loaded=await loadRun(pending.id);
      if(!loaded)throw new Error('Could not reload the run');
      const pr=await executeClaimedRun(loaded,token,(m)=>console.log(`[auto-pr] ${botId}: ${m}`),deadline);
      result.prUrl=pr.pr_url;
    }catch(error){result.error=error instanceof Error?error.message:'publication_recovery_failed';}
    return result;
  }

  // 1. 아직 안 묶인 인사이트가 있으면 먼저 묶는다. 실패해도 기존 묶음으로 계속 간다.
  try {
    const recovery=await runClassificationRecovery([botId],deadline);
    result.recovery=recovery;
    if(recovery.failed || recovery.deferred || recovery.exhausted) {result.error=`classification recovery: ${JSON.stringify(recovery)}`;return result;}
    const grouping = await runGrouping([botId], deadline);
    result.grouped = grouping.grouped;
    if (grouping.failures?.length || grouping.deferred) { result.error = JSON.stringify({failures:grouping.failures,deferred:grouping.deferred}); return result; }
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'grouping_failed';
    return result;
  }

  // 2. 오늘의 묶음 하나
  let picked:AutoPrCandidate|null;
  let candidates:AutoPrCandidate[];
  try {candidates=await loadAutoPrCandidates(botId);picked=pickGroupForAutoPr(candidates);} catch(error) {result.error=error instanceof Error ? error.message : 'candidate_lookup_failed';return result;}
  if(Date.now()>=deadline){result.error='deadline_exceeded';return result;}
  // 왜 안 만들었는지를 남긴다 — 특히 `anonymous_only` 는 익명 경로가 PR 로 못 갔다는 신호다(I-34 ③).
  if (!picked) {result.skippedReason=autoPrSkipReason(candidates);return result;}
  result.groupId = picked.id;

  // 3. run 생성 — 대시보드 [PR 만들기] 와 같은 행. 크론이 만든 것은 화면에서도 똑같이 보인다.
  const {data: runId,error:runError} = await db().rpc('create_pipeline_run',{p_bot_id:botId,p_group_id:picked.id,p_insight_id:null});
  const run = runId ? {id:runId} : null;
  if (runError || !run) {
    result.error = `Could not create the run: ${runError?.message ?? 'unknown'}`;
    return result;
  }
  result.runId = run.id as string;

  // 4. 실행권 획득 후 실행. 실패는 execute-run 이 DB 에 남기므로 여기서는 요약만 담는다.
  const leaseToken = await claimRun(result.runId);
  if (!leaseToken) {
    result.error = 'Could not acquire the run lease';
    return result;
  }
  const loaded = await loadRun(result.runId);
  if (!loaded) {
    result.error = 'Could not reload the run';
    return result;
  }

  try {
    const pr = await executeClaimedRun(loaded, leaseToken, (m) => console.log(`[auto-pr] ${botId}: ${m}`), deadline);
    result.prUrl = pr.pr_url;
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'unknown';
  }
  return result;
}

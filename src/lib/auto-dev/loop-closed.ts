// 루프를 닫는다 — PR 이 머지되면 그 피드백을 준 사람들에게 "반영됐어요" 를 돌려준다.
//
// 크론(자동)과 대시보드 버튼(수동)이 같은 함수를 쓴다.
// 전달 자체는 채널이 맡는다: 웹은 위젯 폴링이 바로 가져가고(delivered_at=now()),
// 카카오는 선톡이 안 되니 대기열에 남겨(null) 그 유저가 다음에 말 걸 때 나간다.
// 채널톡은 우리가 **여기서 직접 보낸다** — 이 채널에서 우리가 하는 유일한 말이다.
//
// ── 시간 예산 (두 호출처 모두 maxDuration = 120) ──────────────────────────
//   채널톡 전송   공유 30초 + 마감 직전 시작분 1건 3초 = 최대 33초
//   GitHub 왕복   20 run × 5초 = 100초 → run 루프 마감 70초로 절단
//   run 당 DB     3~13초 (예산 밖 — 아래 주 참고)
//   합계 최악     ≈ 116초 < 120초
//
// 예산을 **호출부에서 재고, 이 파일의 두 반복 모두에** 건다(원칙 6). run 당 상한만 두면
// 호출부가 20번 부를 때 20배가 된다. 전송에만 걸면 GitHub 루프로 예산이 샌다.

import { octokitForBot, noteGithubError } from '@/lib/auto-dev/github-auth';
import { parseRepoInfo } from '@/lib/github/repo-url';
import { getServiceRoleClient } from '@/lib/supabase';
import { emailResponse } from '@/lib/email/notify';
import { markResponsesDelivered } from '@/lib/bot/conversations';
import { sendBotMessage } from '@/lib/channel/client';
import { recordDeliveryFailure, MAX_DELIVERY_ATTEMPTS } from '@/lib/channel/redeliver';
import { reviewAndPromoteDraft } from '@/lib/auto-dev/draft-promotion';
import { hasDraftWaitMarker } from '@/lib/auto-dev/draft-markers';
import { isChipOnlyText } from '@/lib/widget/chips';

/** 호출 1회(크론 또는 버튼) 전체가 채널톡 전송에 쓸 수 있는 총량. run 수와 무관하다. */
export const CHANNEL_SEND_BUDGET_MS = 30_000;
/** 전송 1건. 마감 직전에 시작된 한 건이 예산을 이만큼 넘길 수 있다. */
export const CHANNEL_SEND_TIMEOUT_MS = 3_000;
/** run 1개가 쓸 수 있는 최대 전송 건수. 한 run 이 예산을 독식하지 않게 한다. */
export const CHANNEL_SEND_MAX_PER_RUN = 5;
/** run 루프를 «새로» 시작할 수 있는 마지막 시각. 진행 중인 run 은 이 안에 흡수된다. */
export const RUN_LOOP_DEADLINE_MS = 70_000;
/**
 * `getPrState` 1회. 지금까지 타임아웃이 없어 「20회 ≈ 20초」는 추정치였다 —
 * GitHub 이 느린 날 한 번이면 크론과 **대시보드 버튼이 함께** 120초에서 잘린다.
 */
export const GITHUB_TIMEOUT_MS = 5_000;
/** 추가 검사·페이지네이션을 포함한 한 PR의 GitHub 총 예산. */
export const DRAFT_GATE_BUDGET_MS = 15_000;

type Db = ReturnType<typeof getServiceRoleClient>;

let _db: Db | null = null;
function db(): Db {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** Supabase 조인은 객체 또는 배열로 온다. */
function one<T>(raw: unknown): T | null {
  if (!raw) return null;
  return ((Array.isArray(raw) ? raw[0] : raw) ?? null) as T | null;
}

/**
 * `run.pr_url`(…/pull/N) 또는 레포 URL 에서 owner/repo. 둘 다 앵커된 형식만 받는다 —
 * 예전의 `match(/github\.com\/([^/]+)\/([^/]+)/)` 는 어디서든 맞아 `..`·퍼센트 인코딩이 통과했고,
 * 여기가 운영자 토큰이 owner/repo 를 고르는 마지막 느슨한 자리였다(보안 리뷰 L5).
 */
export function parseRepo(url: string): { owner: string; repo: string } | null {
  const pr = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+\/?$/);
  if (pr) return { owner: pr[1], repo: pr[2] };
  try {
    return parseRepoInfo(url);
  } catch {
    return null;
  }
}

/** 따옴표 안에 넣을 한 줄. 줄바꿈·연속 공백을 접고 `max` 자에서 자른다(코드 포인트 기준). */
function quoteText(raw: string, max = 60): string {
  const flat = raw.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/**
 * 되돌림 본문. PR URL 을 본문 끝에 그대로 싣는다 — 위젯(`widget.js` systemCard)이
 * 본문에서 URL 을 뽑아 「PR 보기 →」 링크로 바꾸고, 카카오는 텍스트 그대로 나간다.
 * 리허설(2026-09-06)에서 "(PR #5)" 텍스트만 있어 카드에 링크가 안 붙는 걸 발견해 추가했다.
 *
 * 무엇을 따옴표로 인용하나 — 묶음 제목은 사업자 언어(OWNER_CONTENT_LOCALE = en)로 만들어져 방문자 언어와 다를 수 있다.
 * 한국어 문장 안에 영어 제목을 인용하면 방문자가 자기가 쓴 적 없는 말을 보게 된다. 그래서:
 *   · 제목의 언어(한글이 있으면 ko, 아니면 en)가 본문 언어와 같으면 제목을 인용하고,
 *   · 다르면 `ownMessage`(그 방문자가 처음 남긴 말)를 인용하고, 그것도 없으면 인용 없이 쓴다.
 */
export function buildLoopClosedBody(
  title: string,
  prNumber: number | null,
  prUrl: string | null = null,
  /**
   * 본문 언어. 되돌림은 PR 이 머지될 때 «요청 없이» 만들어지므로 대화에 저장된 언어(conversations.locale)를
   * 넘긴다. 안 주면(NULL — 옛 행·카카오·채널톡) 제목에 한글이 있을 때만 ko(한국어로 받은 제보의 제목은 한국어), 아니면 en 이다.
   */
  locale: 'en' | 'ko' = /[가-힣]/.test(title) ? 'ko' : 'en',
  /** 그 방문자가 처음 남긴 말. 제목 언어가 본문 언어와 다를 때만 쓴다 */
  ownMessage?: string | null,
): string {
  const titleLocale = /[가-힣]/.test(title) ? 'ko' : 'en';
  const quoted = titleLocale === locale ? quoteText(title) : ownMessage ? quoteText(ownMessage) : '';
  const lead = quoted ? `"${quoted}" ` : '';
  const head =
    locale === 'ko'
      ? `${lead}말씀해주신 문제를 고쳤어요. 서비스에 반영되기까지 조금 걸릴 수 있어요.`
      : `${lead}The problem you reported is fixed. It may take a little while to reach the service.`;
  const withNumber = prNumber ? `${head} (${locale === 'ko' ? '수정' : 'fix'} #${prNumber})` : head;
  return prUrl ? `${withNumber} ${prUrl}` : withNumber;
}

/**
 * 대화마다 방문자가 처음 남긴 말(칩 라벨만 있는 «시작 신호»는 건너뜀). 조회가 실패하면 빈 맵 — 인용 없이 쓰면 되므로
 * 되돌림을 막지 않는다.
 */
async function firstOwnMessages(conversationIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (conversationIds.length === 0) return out;
  const { data, error } = await db()
    .from('messages')
    .select('conversation_id, body, detected_at')
    .in('conversation_id', conversationIds)
    .order('detected_at', { ascending: true })
    .limit(500);
  if (error) {
    console.error('[loop-closed] 첫 메시지 조회 실패 — 인용 없이 보낸다:', error.message);
    return out;
  }
  for (const m of (data ?? []) as { conversation_id: string | null; body: string | null }[]) {
    if (!m.conversation_id || out.has(m.conversation_id) || !m.body?.trim() || isChipOnlyText(m.body)) continue;
    out.set(m.conversation_id, m.body);
  }
  return out;
}

export interface CloseResult {
  runId: string;
  error?: string;
  prNumber: number | null;
  merged: boolean;
  closed: boolean;     // 머지 없이 닫힘 — 되돌림은 나가지 않는다
  delivered: number;   // 새로 만든 되돌림 수
  skipped: number;     // 이미 되돌림을 받은 사람 수
  emailed: number;     // 그중 이메일로도 나간 수(연락처에 이메일이 있는 대화만)
  /**
   * 예산이나 run 당 상한 때문에 **전송을 시도조차 못 한** 채널톡 건수.
   * 실패(시도했으나 거부됨)와 다르다. 이 행들은 `delivered_at = NULL` 로 남아
   * 그 유저의 다음 발화나 수동 재전송 버튼이 회수한다.
   */
  deferred: number;
}

/** GitHub 이 말하는 PR 의 두 사실 — 머지됐는가, (머지 없이) 닫혔는가 */
export interface PrState {
  merged: boolean;
  closed: boolean;
  mergeSha?: string | null;
}

/**
 * 이 run 의 PR 이 머지됐는지·닫혔는지 GitHub 에 물어본다.
 * 웹훅을 안 쓰는 이유: 운영자 레포마다 웹훅 등록을 요구하게 된다.
 */
async function getPrState(repoUrl: string, prNumber: number, botId: string): Promise<PrState> {
  const parsed = parseRepo(repoUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${repoUrl}`);

  // 설치 → 봇 토큰 → 공용 (B5 + 안 B). 옛 PR 이 다른 레포에 있으면 설치 계정과 소유자가 달라 토큰 경로로 간다.
  // 타임아웃은 이 호출에만 건다 — 없으면 「20회 ≈ 20초」가 강제되지 않아 GitHub 이 느린 날
  // 한 번이면 크론과 대시보드 버튼이 함께 120초에서 잘린다. 기본값으로 올리면 엔진의 getTree 가 같이 잘린다
  const { octokit, source } = await octokitForBot(botId, { repoUrl, timeoutMs: GITHUB_TIMEOUT_MS });
  let data: { merged?: boolean | null; state: string; merge_commit_sha?: string | null; draft?: boolean; body?: string | null };
  try {
    ({ data } = await octokit.pulls.get({ ...parsed, pull_number: prNumber }));
  } catch (err) {
    await noteGithubError(botId, source, err);
    throw err;
  }
  if (data.state === 'open' && !data.merged && data.draft && hasDraftWaitMarker(data.body)) {
    // 크론과 수동 머지 확인 모두 열린 초안을 검사한다. PR URL 은 레포 URL 로 정규화한다.
    try {
      await reviewAndPromoteDraft(`https://github.com/${parsed.owner}/${parsed.repo}`, prNumber, {
        botId, timeoutMs: GITHUB_TIMEOUT_MS, signal: AbortSignal.timeout(DRAFT_GATE_BUDGET_MS),
      });
    } catch (error) {
      // 머지 감지는 이미 성공했다. 부수적인 게이트 오류가 PrState를 무효화하면 안 된다.
      console.warn('[loop-closed] draft gate skipped', { prNumber, reason: error instanceof Error ? error.message : 'gate unavailable' });
    }
  }
  const merged = data.merged === true;
  return { merged, closed: !merged && data.state === 'closed', mergeSha: merged ? data.merge_commit_sha : null };
}

/**
 * 이 run 이 고친 문제를 말한 대화들을 찾는다.
 * 묶음 run 이면 묶음 전체, 인사이트 직결 run 이면 그 하나.
 */
async function conversationsOf(run: {
  id: string;
  group_id: string | null;
  insight_id: string | null;
}): Promise<string[]> {
  const query = db().from('insights').select('id, messages(conversation_id)');
  const { data, error } = run.group_id
    ? await query.eq('group_id', run.group_id)
    : await query.eq('id', run.insight_id ?? '');

  if(error) throw new Error(error.message);
  const ids = new Set<string>();
  for (const i of data ?? []) {
    const msg = one<{ conversation_id?: string | null }>(i.messages);
    if (msg?.conversation_id) ids.add(msg.conversation_id);
  }
  return [...ids];
}

// ── person 접기 ─────────────────────────────────────

interface ConversationMeta {
  id: string;
  source: string;
  external_user_id: string;
  channel_person_id: string | null;
  last_message_at: string | null;
  /** 방문자가 위젯에서 쓴 언어(conversations.locale). NULL = 모름(옛 행·카카오·채널톡) */
  locale?: 'en' | 'ko' | null;
}

/**
 * 되돌림을 «사람당 1건» 으로 접는 키.
 *
 * 웹·카카오는 `channel_person_id` 가 NULL 이라 키가 곧 `conversation_id` 이고,
 * 그래서 **기존 동작이 비트 단위로 같다**(원칙 1). 채널톡만 한 사람이 유저챗을 여러 개
 * 열 수 있어 접기가 필요하다 — 안 접으면 챗 3개인 사람이 같은 소식을 세 번 받는다.
 */
function personKey(c: Pick<ConversationMeta, 'id' | 'channel_person_id'>): string {
  return c.channel_person_id ?? c.id;
}

/** 사람마다 대표 대화 1개. `last_message_at` 이 가장 최근인 것 — 열려 있을 가능성이 높다. */
function foldByPerson(convs: ConversationMeta[]): Map<string, ConversationMeta> {
  const byPerson = new Map<string, ConversationMeta>();
  for (const c of convs) {
    const key = personKey(c);
    const cur = byPerson.get(key);
    if (!cur) {
      byPerson.set(key, c);
      continue;
    }
    const a = cur.last_message_at ? new Date(cur.last_message_at).getTime() : 0;
    const b = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
    if (b > a) byPerson.set(key, c);
  }
  return byPerson;
}

/**
 * run 하나를 닫는다. 머지 안 됐으면 아무것도 하지 않는다.
 * 이미 되돌림을 보낸 «사람» 은 건너뛴다 — 크론이 반복 실행돼도 두 번 가지 않는다.
 *
 * @param opts.sendDeadline 채널톡 전송의 **공유** 마감시각(epoch ms).
 * @param opts.skipEmail 이 호출이 만드는 되돌림에 **메일을 붙이지 않는다**(보안 리뷰 HIGH).
 *        머지 «이벤트» 가 아니라 «재제보 합류»(B1)로 부를 때 쓴다. 그 경로는 방문자가
 *        스스로 연 새 대화라 이메일이 형식 검증만 거친 값이고, 대화가 새로 생기므로
 *        `(auto_dev_run_id, conversation_id)` 유니크 인덱스도 못 막는다 — 남의 주소를
 *        적어 넣고 같은 제보를 반복하면 그 주소로 메일이 계속 나갔다.
 *        만든 행에 `email_delivery_status='skipped'` 를 찍어 **크론의 회수에서도 빠진다.**
 *
 * ⚠️ **재발 조건** — 기본값 `Date.now() + CHANNEL_SEND_BUDGET_MS` 는 «호출처가
 * `checkMergedRuns` 하나뿐» 이라는 전제 위에서만 안전하다. 새 호출처가 생겨 이 함수를
 * 반복 안에서 부르면서 `sendDeadline` 을 안 넘기면 **예산이 호출마다 30초씩 리셋되어**
 * run 20개 × 30초 = 600초 폭주가 되살아난다. 반복 안에서 부르는 호출처는 반드시
 * 자기 `started` 로 만든 `sendDeadline` 을 주입할 것.
 */
export async function closeLoopForRun(
  run: {
    id: string;
    bot_id: string;
    group_id: string | null;
    insight_id: string | null;
    pr_url: string | null;
    pr_number: number | null;
    merged_at: string | null;
    title: string;
    /** 머지 커밋. 배포 확인(`checkDeployment`)이 이 SHA 로 배포를 찾는다. */
    merge_commit_sha?: string | null;
  },
  opts: { sendDeadline?: number; skipEmail?: boolean } = {},
): Promise<CloseResult> {
  const deadline = opts.sendDeadline ?? Date.now() + CHANNEL_SEND_BUDGET_MS;

  const base: CloseResult = {
    runId: run.id,
    prNumber: run.pr_number,
    merged: false,
    closed: false,
    delivered: 0,
    skipped: 0,
    emailed: 0,
    deferred: 0,
  };

  if (!run.pr_url || !run.pr_number) return base;
  await checked(db().from('auto_dev_runs').update({follow_up_checked_at:new Date().toISOString()}).eq('id',run.id));

  // 이미 머지로 확정된 run 은 GitHub 에 다시 묻지 않는다.
  const state: PrState = run.merged_at
    ? { merged: true, closed: false, mergeSha: run.merge_commit_sha }
    : await getPrState(run.pr_url, run.pr_number, run.bot_id);

  // 머지 없이 닫힌 PR — 되돌림은 없다. 시각만 찍어 화면이 「열림」이라고 거짓말하지 않게 한다.
  // 묶음이 PR 을 기다리던 상태(pr_created)였다면 다시 열어 새 PR 을 만들 수 있게 한다.
  if (state.closed) {
    await checked(db()
      .from('auto_dev_runs')
      .update({ closed_at: new Date().toISOString() })
      .eq('id', run.id));
    if (run.group_id) {
      await checked(db()
        .from('insight_groups')
        .update({ status: 'open' })
        .eq('id', run.group_id)
        .eq('status', 'pr_created'));
    }
    return { ...base, closed: true };
  }

  if (!state.merged) return base;

  if (!run.merged_at) {
    await checked(db()
      .from('auto_dev_runs')
      .update({ merged_at: new Date().toISOString(), merge_commit_sha:state.mergeSha })
      .eq('id', run.id));
  }
  if (run.group_id) await checked(db().from('insight_groups').update({status:'merged',follow_up_pending:true}).eq('id',run.group_id));

  const deployment = await checkDeployment(run.pr_url,state.mergeSha,run.bot_id);
  const {error:followError}=await db().from('auto_dev_runs').update({deployment_status:deployment.status,deployment_reason:deployment.reason,follow_up_checked_at:new Date().toISOString(),follow_up_error:null}).eq('id',run.id);
  if(followError) throw new Error(followError.message);
  const conversationIds = await conversationsOf(run);
  if (conversationIds.length === 0) return { ...base, merged: true };

  // 대화의 채널과 사람을 알아야 «누구에게, 언제» 를 정한다.
  // ⚠️ 조회 실패를 삼키지 않는다 — 빈 배열로 흘리면 「보낼 사람이 없다」로 읽혀 되돌림이
  //    조용히 사라지고, 화면에는 「확인 완료」로 뜬다.
  const { data: convRows, error: convMetaError } = await db()
    .from('conversations')
    .select('id, source, external_user_id, channel_person_id, last_message_at, locale')
    .in('id', conversationIds);
  if (convMetaError) throw new Error(convMetaError.message);

  const convs = (convRows ?? []) as ConversationMeta[];
  const byPerson = foldByPerson(convs);
  if (byPerson.size === 0) return { ...base, merged: true };

  // 이 run 으로 이미 되돌림을 받은 대화 → **사람 키로 환산해** 건너뛴다.
  const { data: already, error: alreadyError } = await db()
    .from('responses')
    .select('conversation_id')
    .eq('auto_dev_run_id', run.id)
    .eq('response_type', 'loop_closed');
  if (alreadyError) throw new Error(alreadyError.message);

  const metaById = new Map(convs.map((c) => [c.id, c]));
  const doneKeys = new Set(
    (already ?? []).map((r) => {
      const id = r.conversation_id as string;
      const meta = metaById.get(id);
      return meta ? personKey(meta) : id;
    }),
  );

  const targets = [...byPerson.entries()]
    .filter(([key]) => !doneKeys.has(key))
    .map(([, conv]) => conv);

  const skipped = byPerson.size - targets.length;
  if (targets.length === 0) return { ...base, merged: true, skipped };

  // 한 묶음의 대화가 여러 언어일 수 있다 — 대화마다 자기 언어로 쓴다. 언어를 모르면(NULL) 카카오·채널톡은 한국어
  // 서비스라 ko(메일의 visitorMailLocale 과 같은 규칙), 웹은 제목의 한글 여부로 추정한다.
  // 카카오·채널톡을 제목으로 추정하지 않는 이유: 묶음 제목은 사업자 언어(OWNER_CONTENT_LOCALE = en)로 생성된다.
  const localeOf = (c: ConversationMeta) => c.locale ?? (c.source !== 'web' ? 'ko' : undefined);
  // 제목 언어가 그 대화의 언어와 다르면 제목 대신 방문자 자신의 말을 인용한다 — 그런 대화만 첫 메시지를 읽는다
  const titleLocale = /[가-힣]/.test(run.title) ? 'ko' : 'en';
  const needsOwn = targets.filter((c) => (localeOf(c) ?? titleLocale) !== titleLocale);
  const ownById = await firstOwnMessages(needsOwn.map((c) => c.id));
  const bodyOf = (c: ConversationMeta) =>
    buildLoopClosedBody(run.title, run.pr_number, run.pr_url, localeOf(c), ownById.get(c.id) ?? null);
  const now = new Date().toISOString();

  const rows = targets.map((c) => ({
    bot_id: run.bot_id,
    conversation_id: c.id,
    response_type: 'loop_closed',
    response_body: bodyOf(c),
    auto_dev_run_id: run.id,
    // 웹은 위젯이 폴링으로 바로 가져간다. 카카오는 대기열에 남겨 다음 발화 때 보낸다.
    // 채널톡은 일단 대기열로 만들고 바로 아래에서 보내 본다 — 보내기 전에 delivered 로
    // 찍으면 전송이 실패했을 때 «보냈다고 기록된 안 보낸 행» 이 남는다.
    delivered_at: c.source === 'web' ? now : null,
    // 메일을 안 붙이는 호출이면 «행에» 남긴다. 이 표시가 없으면 다음 크론이 같은 행을
    // pending 으로 보고 주워서 결국 메일이 나간다 — 옵션이 한 번의 호출만 막는 꼴이 된다.
    ...(opts.skipEmail ? { email_delivery_status: 'skipped' } : {}),
  }));

  // 원자적 중복 방어. 위의 사람 기준 중복 제거를 통과해도 크론과 대시보드 버튼이 겹치면
  // 같은 run·같은 대화에 되돌림이 두 번 생길 수 있다 — 읽고-쓰기 사이에 원자성이 없다.
  // `(auto_dev_run_id, conversation_id)` 유니크 제약이 그것을 DB 에서 막고,
  // `ignoreDuplicates` 라 이미 있는 건 조용히 건너뛴다.
  // ⚠️ 이 제약이 **없는** DB 에 이 코드가 올라가면 upsert 가 통째로 실패한다(42P10).
  //    마이그레이션을 코드보다 먼저 적용할 것.
  let delivered = 0;
  let created: Array<{ id: string; conversation_id: string }> = [];
  if (rows.length > 0) {
    const { data: insertedRows, error } = await db()
      .from('responses')
      .upsert(rows, { onConflict: 'auto_dev_run_id,conversation_id', ignoreDuplicates: true })
      .select('id, conversation_id');
    if (error) {
      console.error('[loop-closed] insert error:', error.message);
      throw new Error(error.message);
    }
    created = (insertedRows ?? []) as Array<{ id: string; conversation_id: string }>;
    delivered = created.length;
  }

  // 채널톡만 지금 보낸다. 웹은 위에서 이미 delivered 로 찍혔고, 카카오는 대기열이다.
  // ⚠️ 메일보다 **먼저** 부른다 — 채널톡 전송은 공유 마감(`deadline`)을 쓰는데 메일을 먼저
  // 돌리면 그 시간이 예산을 갉아먹어, 보낼 수 있었던 건이 deferred 로 밀린다.
  // 방금 만든 행만 보낸다 — 이미 있던 행은 지난 회차가 이미 보내거나 대기열에 넣었다.
  const deferred = await deliverChannelRows(run.bot_id, created, targets, bodyOf, deadline);

  // 이메일을 남긴 방문자에게는 메일로도 알린다. 채널 전달과 별개로 지금 나간다 — 되돌림은
  // 며칠 뒤에 오는 소식이라 방문자가 사이트를 다시 열 이유가 없기 때문이다.
  // ⚠️ 방금 만든 것(`created`)이 아니라 이 run 의 되돌림 **전부**를 다시 읽는다. upsert 가
  // 중복을 건너뛰면 `created` 가 비므로, 지난 회차에 만들어졌지만 메일이 못 나간 행이
  // 영영 안 나가게 된다. 재발송은 `emailResponse` 가 `email_sent_at` 으로 막는다.
  let emailed = 0;
  if (!opts.skipEmail) {
    // `skipped` 행은 질의에서 뺀다. `claim_response_email` 이 pending·failed 만 잡으므로
    // 실제 발송은 어차피 막히지만, 그러면 매 크론마다 본문을 렌더하고 claim 을 시도하다
    // 「delivery_unknown」 이라는 **틀린 이유**를 돌려받는다. 안 읽는 편이 정직하고 싸다.
    const { data: notifications, error: notificationError } = await db()
      .from('responses')
      .select('id, conversation_id')
      .eq('auto_dev_run_id', run.id)
      .eq('response_type', 'loop_closed')
      .neq('email_delivery_status', 'skipped');
    if (notificationError) throw new Error(notificationError.message);
    for (const c of notifications ?? []) {
      const outcome = await emailResponse({
        kind: 'loop_closed',
        responseId: c.id as string,
        conversationId: c.conversation_id as string,
        botId: run.bot_id,
        title: run.title,
        prNumber: run.pr_number,
        prUrl: run.pr_url,
      });
      if (outcome.sent) emailed += 1;
    }
  }

  return { ...base, merged: true, delivered, skipped, deferred, emailed };
}

/**
 * 방금 만든 되돌림 중 채널톡 것을 지금 보낸다. 돌려주는 값은 **시도조차 못 한 건수**다.
 *
 * 예산을 넘긴 것과 run 당 상한을 넘긴 것은 `delivered_at = NULL` 로 남는다 —
 * 그 유저의 다음 발화나 수동 재전송 버튼이 회수한다. 실패(시도했으나 거부됨)는
 * `delivery_attempts` 를 올려 5회에서 멈추게 한다.
 */
async function deliverChannelRows(
  botId: string,
  insertedRows: Array<{ id: string; conversation_id: string }>,
  targets: ConversationMeta[],
  bodyOf: (c: ConversationMeta) => string,
  deadline: number,
): Promise<number> {
  const channelTargets = targets.filter((c) => c.source === 'channel');
  const chatByConv = new Map(channelTargets.map((c) => [c.id, c.external_user_id]));
  const metaByConv = new Map(channelTargets.map((c) => [c.id, c]));

  const channelRows = insertedRows.filter((r) => chatByConv.has(r.conversation_id));
  if (channelRows.length === 0) return 0;

  const sendable = channelRows.slice(0, CHANNEL_SEND_MAX_PER_RUN);
  let deferred = channelRows.length - sendable.length;

  for (const row of sendable) {
    // 공유 마감. run 이 몇 개든 채널톡 몫은 여기서 잘린다.
    if (Date.now() >= deadline) {
      deferred += 1;
      continue;
    }

    const result = await sendBotMessage(botId, chatByConv.get(row.conversation_id)!, bodyOf(metaByConv.get(row.conversation_id)!), {
      timeoutMs: CHANNEL_SEND_TIMEOUT_MS,
    });

    if (result.ok) {
      await markResponsesDelivered([row.id]);
    } else {
      // 방금 만든 행이라 시도 횟수는 0 에서 시작한다.
      await recordDeliveryFailure(row.id, 0, result.message);
    }
  }

  return deferred;
}

/**
 * 머지 여부를 아직 모르는 run 들을 훑는다 (크론 · 수동 모두).
 *
 * 예산을 **여기서** 잡는다(원칙 6). 이 함수 안에 반복이 둘이라 둘 다에 건다 —
 * 채널톡 전송에는 공유 `sendDeadline` 을, GitHub 왕복에는 `RUN_LOOP_DEADLINE_MS` 를.
 * 하나만 걸면 남은 하나로 예산이 샌다.
 *
 * @returns `skipped` 는 루프 마감에 걸려 **보지도 못한 run 수**다.
 *          `CloseResult.skipped`(이미 되돌림을 받은 사람 수)와 다른 값이다.
 */
export async function checkMergedRuns(
  botIds: string[],
): Promise<{ results: CloseResult[]; skipped: number }> {
  if (botIds.length === 0) return { results: [], skipped: 0 };

  const started = Date.now();
  const sendDeadline = started + CHANNEL_SEND_BUDGET_MS;

  const { data: runs, error: runsError } = await db()
    .from('auto_dev_runs')
    .select('id, bot_id, group_id, insight_id, pr_url, pr_number, merged_at, merge_commit_sha, insight_groups(title), insights(summary)')
    .in('bot_id', botIds)
    .is('closed_at', null)
    .not('pr_url', 'is', null)
    .order('follow_up_checked_at', { ascending: true, nullsFirst:true })
    .limit(20);

  if (runsError) throw new Error(`follow_up_lookup_failed: ${runsError.message}`);
  const results: CloseResult[] = [];
  let skipped = 0;

  for (const r of runs ?? []) {
    // 새 run 을 시작할 시간이 남았는가. 진행 중인 run 의 DB 왕복은 이 안에 흡수된다.
    if (Date.now() - started > RUN_LOOP_DEADLINE_MS) {
      skipped += 1;
      continue;
    }

    const group = one<{ title?: string }>(r.insight_groups);
    const insight = one<{ summary?: string }>(r.insights);
    const title = group?.title || insight?.summary || 'Requested change';

    try {
      results.push(
        await closeLoopForRun(
          {
            id: r.id,
            bot_id: r.bot_id,
            group_id: r.group_id ?? null,
            insight_id: r.insight_id ?? null,
            pr_url: r.pr_url,
            pr_number: r.pr_number,
            merged_at: r.merged_at ?? null,
            title,
            merge_commit_sha: r.merge_commit_sha,
          },
          { sendDeadline },
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'check_failed';
      const { error: recordError } = await db().from('auto_dev_runs').update({ follow_up_checked_at: new Date().toISOString(), follow_up_error: message }).eq('id', r.id);
      results.push({
        runId: r.id,
        prNumber: r.pr_number ?? null,
        merged: Boolean(r.merged_at),
        closed: false,
        delivered: 0,
        skipped: 0,
        emailed: 0,
        // 실패한 run 은 채널톡 전송까지 못 갔다 — 「미룬 것」이 아니라 「못 본 것」이다.
        deferred: 0,
        error: recordError ? `${message}; failure_record_failed: ${recordError.message}` : message,
      });
      // PR 이 지워졌거나 토큰이 막혀도 나머지 run 은 계속 본다.
      console.error(`[loop-closed] run ${r.id} check failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { results, skipped };
}

// 봇 토큰도 여기를 탄다(B5) — 직접 `new Octokit({auth: process.env.GITHUB_TOKEN})` 을 쓰면
// 운영자 토큰을 넣은 봇의 배포 확인만 공용 계정으로 나가 남의 레포에서 조용히 실패한다.
export async function checkDeployment(repoUrl:string,sha?:string|null,botId?:string|null):Promise<{status:string;reason:string}> {
 const environment=process.env.FEEDLOOP_DEPLOYMENT_ENVIRONMENT;
 if(!environment || !sha) return {status:'unknown',reason:!environment?'environment_not_configured':'merge_sha_unknown'};
 const parsed=parseRepo(repoUrl); if(!parsed) return {status:'unknown',reason:'invalid_repository'};
 try {
  const { octokit: client } = await octokitForBot(botId);
  const {data:deployments}=await client.repos.listDeployments({...parsed,sha,environment,per_page:100});
  if(deployments.length===100) return {status:'unknown',reason:'deployment_history_truncated'};
  const latest=deployments.filter(d=>d.sha===sha && d.environment===environment).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  if(!latest) return {status:'unknown',reason:'no_exact_sha_deployment'};
  const {data:statuses}=await client.repos.listDeploymentStatuses({...parsed,deployment_id:latest.id,per_page:100});
  if(statuses.length===100) return {status:'unknown',reason:'deployment_status_history_truncated'};
  const status=statuses.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  if(!status || status.environment!==environment) return {status:'unknown',reason:'deployment_status_unknown'};
  return {status:status.state==='success'?'success':['failure','error'].includes(status.state)?'failed':['queued','pending','in_progress'].includes(status.state)?'pending':'unknown',reason:status.state};
 } catch { return {status:'unknown',reason:'deployment_lookup_failed'}; }
}

async function checked(result: PromiseLike<{error:{message:string}|null}>):Promise<void> { const {error}=await result;if(error) throw new Error(error.message); }

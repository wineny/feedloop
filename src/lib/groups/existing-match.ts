// B1·F1 — 「이미 있는 묶음」과 대조한다.
//
// 왜: [지금 묶기]는 아직 안 묶인 인사이트끼리만 비교했다. 같은 문제가 다시 들어오면
// (후속 문의·재제보) 새 묶음이 되고 [PR 만들기]가 또 뜬다. 리허설 두 번이 여기서 걸렸다.
//
// 이 파일이 「대조」의 판단 한 곳이다. 두 호출처가 같은 재료를 쓴다:
//   ① 묶기(`grouping.ts`) — 스냅샷 RPC(`pipeline_group_snapshot`)가 실어 준 기존 묶음
//   ② 즉답(F1, 위젯 messages 라우트) — 스냅샷을 안 타므로 `listRecentGroups` 가 직접 읽는다
// 판단을 두 벌 만들면 「묶기는 합류라는데 즉답은 처음 듣는 문제라고 답하는」 상태가 된다.

import { getServiceRoleClient } from '@/lib/supabase';
import { closeLoopForRun, CHANNEL_SEND_BUDGET_MS } from '@/lib/auto-dev/loop-closed';
import { buildRefMapBy, normalizeRef } from '@/lib/classify/ref';
import { collapseWhitespace } from '@/lib/text';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/**
 * 프롬프트에 싣는 기존 묶음 수의 상한.
 *
 * 묶음이 쌓일수록 입력이 커져 모델이 대충 읽는다(백로그 B1 「주의」). 스냅샷 RPC
 * (`20260917_01`)도 같은 값으로 자르므로, 여기 값을 바꿀 때 그 마이그레이션도 같이 본다.
 */
export const EXISTING_GROUPS_LIMIT = 30;

/**
 * 즉답(F1)이 프롬프트에 싣는 묶음 수의 상한. 묶기(30)보다 «작다».
 *
 * 묶기는 60초 예산에 40건을 한 번에 넣는 배치지만, 즉답은 방문자가 기다리는 10초 안에
 * 끝나야 한다. 목록이 길어진 만큼 입력 토큰과 지연이 «매 메시지마다» 붙는다.
 * 판단(어느 상태에 합류·언제 되돌림)은 두 경로가 이 파일의 같은 함수를 쓰고,
 * 다른 것은 「몇 개를 보여주는가」뿐이다.
 */
export const REPLY_GROUPS_LIMIT = 12;

/** 프롬프트와 대조에 쓰는 기존 묶음 한 줄. 스냅샷 RPC 가 주는 모양과 같다. */
export interface ExistingGroup {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
}

/** 기존 묶음 + 그 묶음을 고친 PR. 즉답이 「(PR #N)」 을 «서버가» 말하려면 필요하다. */
export interface ReplyGroup extends ExistingGroup {
  prNumber: number | null;
  prUrl: string | null;
}

/** 대조 결과 — 그 묶음에 합류할 것인가, 새 묶음으로 갈 것인가. */
export type MatchOutcome = 'join' | 'new';

/**
 * 이 상태의 묶음에 «합류해도» 되는가.
 *
 * `dismissed` 만 거른다 — 운영자가 닫은 이유는 「같은 문제가 아니다」일 수도, 「고치지
 * 않기로 했다」일 수도 있다. 거기 합류시키면 새 제보가 닫힌 채로 묻힌다. 합류 대신
 * 새 묶음으로 두고 운영자가 다시 판단하게 한다(백로그 B1, 「단순하게 간다」).
 */
export function matchOutcome(status: string): MatchOutcome {
  return status === 'dismissed' ? 'new' : 'join';
}

/**
 * 이 묶음에 합류했을 때 되돌림(`loop_closed`)을 «지금» 만들어야 하는가.
 *
 * `merged` 만 그렇다. `open` 은 아직 고치는 중이고, `pr_created` 는 PR 을 기다리는 중이라
 * 합류만 하고 되돌림은 머지 때 다른 사람들과 «함께» 나간다(백로그 B1).
 */
export function needsLoopClosed(status: string): boolean {
  return status === 'merged';
}

/**
 * 이 묶음을 고친 PR 하나를 고른다. 머지된 것이 있으면 그것, 없으면 가장 최근 PR.
 *
 * 한 묶음에 run 이 여럿일 수 있다(PR 이 닫혀서 다시 만든 경우). 방문자에게 말할 번호는
 * «마지막으로 성사된» 것 하나다.
 *
 * ⚠️ 정렬 기준을 «반드시» 값으로 둔다. 예전에는 비머지 폴백이 `withPr[withPr.length-1]`,
 * 즉 **PostgREST 가 임베드를 돌려준 순서**에 기댔다. 그 순서는 보장이 없어서 같은 묶음이
 * 요청마다 다른 PR 번호를 말할 수 있었다 — 방문자에게 나가는 숫자가 그렇게 흔들리면 안 된다.
 */
function pickRun(raw: unknown): { prNumber: number | null; prUrl: string | null } {
  const runs = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
    pr_number?: number | null;
    pr_url?: string | null;
    merged_at?: string | null;
    created_at?: string | null;
  }[];
  const withPr = runs.filter((r) => typeof r.pr_number === 'number');
  // 시각이 없거나 같으면 PR 번호가 큰 쪽(나중에 연 것)이 이긴다 — 완전한 전순서를 만든다.
  const newest = (key: 'merged_at' | 'created_at') => (a: typeof withPr[number], b: typeof withPr[number]) =>
    Date.parse(b[key] ?? '') - Date.parse(a[key] ?? '') || (b.pr_number ?? 0) - (a.pr_number ?? 0);
  const merged = withPr.filter((r) => r.merged_at).sort(newest('merged_at'));
  const best = merged[0] ?? withPr.slice().sort(newest('created_at'))[0];
  return { prNumber: best?.pr_number ?? null, prUrl: best?.pr_url ?? null };
}

/**
 * 이 봇의 기존 묶음 최근 N개. 즉답(F1)처럼 스냅샷 RPC 를 안 타는 경로가 쓴다.
 *
 * 스냅샷과 같은 순서로 돌려준다 — 최근 N개를 고른 뒤 오래된 것부터. 목록 순서가
 * 호출처마다 다르면 같은 재료인데 모델이 다르게 읽는다.
 *
 * PR 은 «한 번의 조회»로 같이 읽는다(역조인). 즉답은 10초 예산이라 왕복 하나가 아깝다.
 *
 * @param opts.joinableOnly 닫힌(dismissed) 묶음을 아예 빼고 읽는다. 즉답은 거기에
 *        해줄 말이 없다 — 「이미 접수됐어요」도 「반영됐어요」도 거짓이 된다.
 */
export async function listRecentGroups(
  botId: string,
  opts: { limit?: number; joinableOnly?: boolean } = {},
): Promise<ReplyGroup[]> {
  let q = db()
    .from('insight_groups')
    .select('id, title, summary, category, status, auto_dev_runs(pr_number, pr_url, merged_at, created_at)')
    .eq('bot_id', botId);
  if (opts.joinableOnly) q = q.neq('status', 'dismissed');
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.max(1, opts.limit ?? EXISTING_GROUPS_LIMIT));
  if (error) throw new Error(`existing_groups_lookup_failed: ${error.message}`);

  return ((data ?? []) as (ExistingGroup & { auto_dev_runs?: unknown })[])
    .map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.category,
      status: row.status,
      ...pickRun(row.auto_dev_runs),
    }))
    .reverse();
}

// ── F1 「이미 알고 있어요」 — 즉답이 기존 묶음과 대조한다 ────────────────────
//
// 왜 여기 있는가: 묶기(B1)와 «같은 판단»을 써야 한다. 묶기는 합류시키는데 즉답은
// 「처음 듣는 문제네요」라고 답하면 방문자가 보는 것과 운영자가 보는 것이 갈린다.
//
// 모델은 «어느 묶음이 같은 문제인가»만 고른다. 진행 상황 문장(PR 번호·반영 여부)은
// **서버가 조립한다** — 모델에게 맡기면 없는 PR 번호를 지어낸다.

/** 프롬프트에 싣는 제목 길이. `formatExtendableSection` 과 같은 상한을 쓴다. */
const TITLE_CHARS = 300;

/** 모델이 읽을 상태 라벨. 영문 status 코드(pr_created 등)를 그대로 주면 저가 모델이 뜻을 헷갈린다. */
function statusLabel(status: string): string {
  if (status === 'merged') return 'fixed';
  if (status === 'pr_created') return 'being fixed';
  return 'reported';
}

/** ref → 묶음. 배치 분류·「이 대화의 기존 제보」와 **같은 규칙**(`classify/ref.ts`). */
export function buildGroupRefMap(groups: ReplyGroup[]): Map<string, ReplyGroup> {
  return buildRefMapBy(groups, (g) => g.id);
}

/**
 * 「이미 접수된 문제」 블록. 없으면 빈 문자열(호출부가 그 줄을 통째로 뺀다).
 *
 * 제목은 모델이 쓴 값이지 방문자 입력이 아니지만 한 줄로 접는다 — 개행이 있으면
 * 목록의 «항목 경계»를 흉내 낼 수 있다(`formatExtendableSection` 과 같은 이유).
 */
export function formatKnownIssuesSection(refMap: Map<string, ReplyGroup>): string {
  if (refMap.size === 0) return '';
  const lines = [...refMap].map(([ref, g]) => {
    const title = collapseWhitespace(g.title).slice(0, TITLE_CHARS);
    return `- [${ref}] ${statusLabel(g.status)} · ${title}`;
  });
  return ['Known issues (if it is the same problem, put its ref in matches_existing_group_id):', ...lines].join('\n');
}

/**
 * 서버가 확정한 한 문장을 «모델 답변 대신 쓸지, 뒤에 덧붙일지».
 *
 * `merged`·`pr_created` 는 **대체**한다. 서버가 아는 사실(고쳤다·고치는 중이다)이 모델의
 * 짐작보다 정확하고, 둘을 같이 두면 「처음 듣는 문제네요. 이미 반영됐어요」처럼 한 말풍선
 * 안에서 모순이 난다.
 *
 * `open` 은 **덧붙인다**. 「접수돼 있다」는 그 사람의 질문에 대한 답이 아니다 — 재현 조건을
 * 묻는 꼬리질문이나 공감이 여전히 필요하고, 그걸 지우면 대화가 거기서 끊긴다(코드 리뷰 LOW 8).
 */
export type KnownIssueMode = 'replace' | 'append';

export function knownIssueMode(status: string): KnownIssueMode {
  return status === 'merged' || status === 'pr_created' ? 'replace' : 'append';
}

/**
 * 방문자에게 나갈 한 문장. **서버가 확정한다.**
 *
 * 제목을 되풀이하지 않는다 — 그 제목은 «다른 방문자» 의 말에서 나온 요약이다.
 * PR 번호가 없으면 번호를 빼고 말한다. 지어내느니 덜 말하는 편이 낫다.
 * 닫힌 묶음은 null — 해줄 말이 없다(`matchOutcome` 이 같은 판단을 한다).
 */
export function buildKnownIssueReply(group: ReplyGroup, locale: 'en' | 'ko' = 'ko'): string | null {
  if (matchOutcome(group.status) === 'new') return null;
  const en = locale === 'en';
  const pr = group.prNumber ? (en ? ` (fix #${group.prNumber})` : ` (수정 #${group.prNumber})`) : '';
  if (group.status === 'merged') {
    return en
      ? `This has already been fixed${pr}. If it still happens, please let us know 🙏`
      : `이 문제는 이미 반영됐어요${pr}. 혹시 아직 그대로면 알려주세요 🙏`;
  }
  if (group.status === 'pr_created') {
    return en
      ? `We already got the same report and are fixing it now${pr}. We'll let you know here when it's fixed 🙏`
      : `같은 내용을 이미 받아서 지금 고치는 중이에요${pr}. 반영되면 여기로 알려드릴게요 🙏`;
  }
  // 덧붙는 줄이라 짧게. 진행 상황을 단정하지 않는다 — PR 이 아직 없다.
  return en
    ? "Someone else reported the same problem, and we're looking at it 🙏"
    : '같은 문제를 말한 분이 또 있어 함께 보고 있어요 🙏';
}

/**
 * 모델이 고른 ref 를 묶음으로 바꾸고, 방문자에게 나갈 최종 문장을 만든다.
 *
 * 목록 밖 ref 는 «버린다» — 지어낸 것이다. `validateGroups` 와 같은 규칙이다.
 * 답할 문장이 없으면(닫힌 묶음) null 이라 호출부가 모델 답변을 그대로 둔다.
 *
 * @param modelResponse 모델이 쓴 답변. `append` 모드에서 앞에 남는다. 없으면 서버 문장만.
 */
export function resolveKnownIssue(
  ref: unknown,
  refMap: Map<string, ReplyGroup>,
  modelResponse?: string | null,
  /** 방문자 언어(위젯 대화 언어). 기본 ko 는 종전 동작 */
  locale: 'en' | 'ko' = 'ko',
): { group: ReplyGroup; reply: string; mode: KnownIssueMode } | null {
  const key = normalizeRef(ref);
  if (!key) return null;
  const group = refMap.get(key);
  if (!group) return null;
  const line = buildKnownIssueReply(group, locale);
  if (!line) return null;

  const mode = knownIssueMode(group.status);
  const model = typeof modelResponse === 'string' ? modelResponse.trim() : '';
  // 모델이 이미 같은 말을 했으면 두 번 쓰지 않는다.
  const reply = mode === 'append' && model && !model.includes(line) ? `${model}\n\n${line}` : line;
  return { group, reply, mode };
}

/** 이번 묶기에서 «기존 묶음에 합류한» 한 건. */
export interface RejoinedGroup {
  groupId: string;
  /** 합류 «전» 의 상태. 합류가 상태를 바꾸지는 않는다. */
  status: string;
}

/**
 * 한 번의 묶기가 되돌림을 만들 수 있는 묶음 수의 상한.
 *
 * 묶기 한 회차가 머지된 묶음 여럿에 합류하면 묶음마다 대화 조회·되돌림 upsert·채널톡
 * 전송이 붙는다. 자동 묶기 예산(100초) 안에서 도는 일이라 상한이 없으면 한 회차가
 * 예산을 다 먹고 잠금이 고아가 된다. 넘긴 것은 «잃는» 게 아니다 — `check-merged` 크론이
 * 머지 run 을 계속 다시 보므로 다음 회차에 회수된다.
 */
export const REJOIN_MAX_GROUPS = 5;

export interface RejoinCloseResult {
  /** 되돌림을 만들려고 시도한 묶음 수(= merged 묶음에 합류한 건수). */
  attempted: number;
  /** 새로 만든 되돌림 수. 이미 받은 사람은 안 센다. */
  delivered: number;
  /** 머지 run 을 못 찾아 건너뛴 묶음 수 — PR 번호가 없으면 할 말이 없다. */
  skippedNoRun: number;
  /**
   * 상한·마감에 걸려 **손도 못 댄** 묶음 수. 실패(시도했으나 안 됨)와 다르다.
   * 이 묶음들은 `check-merged` 크론이 줍는다.
   */
  skippedDeadline: number;
  failures: string[];
}

/**
 * 이미 머지된 묶음에 새 제보가 합류했으면, 그 사람에게 「이미 반영됐어요」를 지금 돌려준다.
 *
 * 되돌림 «생성·전달» 은 새로 만들지 않고 `closeLoopForRun` 을 그대로 쓴다(중복 구현 금지).
 * 그 함수가 이미 이 일의 전부를 한다 — 본문은 `buildLoopClosedBody`, 웹은 `delivered_at=now()`,
 * 카카오는 `null`(대기열), 채널톡은 여기서 직접 발송, 이메일을 남긴 사람에겐 메일까지.
 * 멱등도 거기 있다: `responses(auto_dev_run_id, conversation_id)` 유니크 인덱스
 * (`20260913_11`) + 사람 단위 중복 제거라 같은 대화·같은 run 에 두 번 생기지 않는다.
 *
 * ⚠️ **메일은 붙이지 않는다**(`skipEmail`, 보안 리뷰 HIGH). 이 경로는 방문자가 스스로 연
 * «새» 대화에서 출발한다. 연락처 이메일은 형식만 검증하고 저장하므로 남의 주소를 적어
 * 넣을 수 있고, 대화가 새로 생기니 `(auto_dev_run_id, conversation_id)` 유니크 인덱스도
 * 못 막는다 — 같은 제보를 반복하면 그 주소로 메일이 계속 나갔다. 메일은 실제 «머지
 * 이벤트» 경로(크론·대시보드 버튼)에만 남는다. 여기서 만든 행은 `skipped` 로 찍혀
 * 크론의 회수에서도 빠진다.
 *
 * ⚠️ 여기서 실패하거나 상한(`REJOIN_MAX_GROUPS`)·마감에 걸려도 되돌림이 영영 사라지지는
 * 않는다 — `check-merged` 크론이 `closed_at` 이 비어 있는 머지 run 을 계속 다시 보고,
 * 그때 새로 합류한 대화를 줍는다. 그래도 실패는 삼키지 않고 호출부가 로그로 남긴다.
 */
export async function closeLoopForRejoins(
  botId: string,
  rejoined: RejoinedGroup[],
  opts: { deadlineMs?: number } = {},
): Promise<RejoinCloseResult> {
  const out: RejoinCloseResult = { attempted: 0, delivered: 0, skippedNoRun: 0, skippedDeadline: 0, failures: [] };
  // 같은 묶음이 두 제안에 나뉘어 들어올 수 있다(모델이 쪼갠 경우). 묶음 단위로 접는다 —
  // 안 접으면 같은 묶음에 `closeLoopForRun` 을 두 번 태운다(행은 유니크 인덱스가 막지만
  // 대화 조회·GitHub 배포 확인은 두 번 돈다).
  const unique = [...new Map(rejoined.map((r) => [r.groupId, r])).values()];
  const eligible = unique.filter((r) => needsLoopClosed(r.status));
  if (eligible.length === 0) return out;

  const targets = eligible.slice(0, REJOIN_MAX_GROUPS);
  out.skippedDeadline += eligible.length - targets.length;

  // 채널톡 전송 예산은 이 호출 전체가 «공유» 한다. 묶음마다 새로 주면 묶음 수만큼 곱해진다
  // (`closeLoopForRun` 주석의 재발 조건).
  const deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const sendDeadline = Math.min(deadlineMs, Date.now() + CHANNEL_SEND_BUDGET_MS);

  for (const { groupId } of targets) {
    // 마감을 넘겼으면 «시작하지» 않는다. 진행 중인 한 건은 흡수된다(loop-closed.ts 와 같은 규칙).
    if (Date.now() >= deadlineMs) {
      out.skippedDeadline += 1;
      continue;
    }
    out.attempted += 1;
    try {
      const { data, error } = await db()
        .from('auto_dev_runs')
        .select('id, bot_id, group_id, insight_id, pr_url, pr_number, merged_at, merge_commit_sha, insight_groups(title)')
        .eq('group_id', groupId)
        .eq('bot_id', botId)
        .not('merged_at', 'is', null)
        .order('merged_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);

      const run = (data ?? [])[0] as
        | {
            id: string;
            bot_id: string;
            group_id: string | null;
            insight_id: string | null;
            pr_url: string | null;
            pr_number: number | null;
            merged_at: string | null;
            merge_commit_sha?: string | null;
            insight_groups?: unknown;
          }
        | undefined;

      // 머지 run 이 없는 `merged` 묶음(운영자가 손으로 상태만 바꾼 경우 등)은 건너뛴다.
      // PR 번호 없이 「이미 반영됐어요」라고만 하면 방문자가 확인할 방법이 없다.
      if (!run || !run.pr_url || !run.pr_number) {
        out.skippedNoRun += 1;
        continue;
      }

      const joined = run.insight_groups;
      const groupRow = (Array.isArray(joined) ? joined[0] : joined) as { title?: string } | null;

      const closed = await closeLoopForRun(
        {
          id: run.id,
          bot_id: run.bot_id,
          group_id: run.group_id ?? null,
          insight_id: run.insight_id ?? null,
          pr_url: run.pr_url,
          pr_number: run.pr_number,
          merged_at: run.merged_at,
          // 제목이 없을 때의 대체 글자는 다른 호출처(loop-closed 크론·run-access)와 같은 'Requested change' —
          // 묶음 제목은 사업자 언어(en)라 영어로 둔다. 본문 언어는 `buildLoopClosedBody` 가 대화 언어로 고르고,
          // 한국어 대화에는 이 영어 글자 대신 방문자 자신의 말을 인용한다.
          title: groupRow?.title || 'Requested change',
          merge_commit_sha: run.merge_commit_sha,
        },
        // 메일은 «안» 붙인다(보안 리뷰 HIGH). 아래 주석 참고.
        { sendDeadline, skipEmail: true },
      );
      out.delivered += closed.delivered;
    } catch (err) {
      out.failures.push(
        `loop_closed_failed(${groupId}): ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  return out;
}

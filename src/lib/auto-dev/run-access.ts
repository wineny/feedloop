// 「수정 PR」 하나에 대한 행동 라우트(pr · merge · close · verify)가 공유하는 접근 규칙.
//
// 넷 다 같은 순서다 — 세션 → 그 유저의 봇 → 그 봇의 run → 레포 URL(run 의 pr_url, 없으면 봇 행).
// 레포 URL 은 **DB 에서만** 읽는다. 요청 본문에서 받으면 플랫폼 공용 GITHUB_TOKEN 이
// 남의 레포로 향한다(confused deputy). 남의 봇 run 은 존재 여부를 알려주지 않으려고 404 다.

import { apiText } from '@/lib/http/api-text';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { parseStoredExplanation, type RunExplanation } from '@/lib/auto-dev/explanation';

export interface OwnedRun {
  id: string;
  botId: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: string | null;
  closedAt: string | null;
  groupId: string | null;
  insightId: string | null;
  /** PR 이 실제로 열린 레포. `pr_url`(엔진이 쓴 값)에서 뽑고, 없으면 봇 행의 레포 */
  repoUrl: string | null;
  title: string;
  explanation: RunExplanation | null;
  filesChanged: { path: string; action: string }[];
}

export type RunAccess =
  | { ok: true; run: OwnedRun; userId: string }
  | { ok: false; status: 401 | 403 | 404 | 500; error: string };

function one<T>(raw: unknown): T | null {
  if (!raw) return null;
  return ((Array.isArray(raw) ? raw[0] : raw) ?? null) as T | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR 이 열린 레포는 `pr_url` 이 안다. 봇 행의 `github_repo_url` 은 나중에 바뀔 수 있다 —
 * 널널투어 봇은 9/10 에 데모 레포 → 라이브 레포로 바뀌어 그 전 PR(#3~#6)을 라이브에서 찾다 404 가 났다.
 * `pr_url` 은 엔진(service_role)만 쓰는 값이라 요청 본문과 달리 믿어도 된다. 앵커된 형식만 받는다.
 */
export function repoUrlOfPr(prUrl: string | null | undefined): string | null {
  const m = prUrl?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export async function loadOwnedRun(runId: string, req?: Request): Promise<RunAccess> {
  const auth = await resolveOwnedBots();
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
  // UUID 가 아니면 Postgres 22P02 가 500 으로 새어 나간다 — 없는 것과 같은 404
  if (!UUID_RE.test(runId)) return { ok: false, status: 404, error: apiText(req, 'runNotFound') };

  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('auto_dev_runs')
    .select(
      `id, bot_id, status, pr_url, pr_number, merged_at, closed_at, group_id, insight_id, explanation, files_changed,
       insight_groups(title), insights(summary), bots(github_repo_url)`,
    )
    .eq('id', runId)
    .maybeSingle();

  // DB 오류를 404 로 뭉개면 운영자가 엉뚱한 곳을 찾는다 (마이그레이션 누락 등). 원문은 로그에만
  if (error) {
    console.error('[run-access] load failed', { runId, message: error.message });
    return { ok: false, status: 500, error: apiText(req, 'runReadRetry') };
  }
  if (!data || !auth.botIds.includes(data.bot_id as string)) {
    return { ok: false, status: 404, error: apiText(req, 'runNotFound') };
  }

  const group = one<{ title?: string }>(data.insight_groups);
  const insight = one<{ summary?: string }>(data.insights);
  const bot = one<{ github_repo_url?: string | null }>(data.bots);

  return {
    ok: true,
    userId: auth.userId,
    run: {
      id: data.id as string,
      botId: data.bot_id as string,
      status: (data.status as string) ?? 'running',
      prUrl: (data.pr_url as string | null) ?? null,
      prNumber: (data.pr_number as number | null) ?? null,
      mergedAt: (data.merged_at as string | null) ?? null,
      closedAt: (data.closed_at as string | null) ?? null,
      groupId: (data.group_id as string | null) ?? null,
      insightId: (data.insight_id as string | null) ?? null,
      repoUrl: repoUrlOfPr(data.pr_url as string | null) ?? bot?.github_repo_url ?? null,
      title: group?.title || insight?.summary || 'Requested change',
      explanation: parseStoredExplanation(data.explanation),
      filesChanged: Array.isArray(data.files_changed) ? (data.files_changed as OwnedRun['filesChanged']) : [],
    },
  };
}

/** 이 라우트들이 받는 본문은 작다(사유·index). 상한을 넘으면 읽지도 않는다 */
export const ACTION_BODY_MAX = 16 * 1024;

export async function readJsonBounded(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: 400 | 413 }> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > ACTION_BODY_MAX) return { ok: false, error: apiText(req, 'bodyTooLarge'), status: 413 };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, error: apiText(req, 'badRequest'), status: 400 };
  }
  if (raw.length > ACTION_BODY_MAX) return { ok: false, error: apiText(req, 'bodyTooLarge'), status: 413 };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: apiText(req, 'badRequest'), status: 400 };
  }
}

/**
 * 상태를 바꾸는 POST 는 같은 사이트에서만. next-auth 쿠키가 SameSite=Lax 라 교차 사이트 POST 는
 * 원래 세션이 안 붙지만, 본문 없는 POST 한 번이 프로덕션 머지와 방문자 통지·메일을 동시에 일으키므로
 * Origin 헤더가 있으면 호스트를 한 번 더 본다. 헤더가 없는 요청(curl·같은 출처 일부)은 통과.
 */
export function crossOriginProblem(req: Request): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  try {
    const expected = new URL(req.url).host;
    const forwarded = req.headers.get('x-forwarded-host');
    const got = new URL(origin).host;
    if (got === expected || (forwarded && got === forwarded)) return null;
  } catch {
    // 파싱 실패는 아래에서 거절
  }
  return apiText(req, 'crossOrigin');
}

/**
 * squash 커밋 제목 — 방문자 텍스트에서 파생된 값이라 길이·개행을 정리한다.
 */
export function commitTitleFrom(title: string, prNumber: number): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  const suffix = ` (#${prNumber})`;
  const room = 72 - suffix.length;
  return (flat.length > room ? `${flat.slice(0, room - 1)}…` : flat) + suffix;
}

/**
 * 「열린 PR」 인가 — 반영·반영하지 않기·확인시키기는 여기서만 뜻이 있다.
 * 아니면 이유를 돌려준다(라우트가 409 로 답한다).
 */
export function openPrProblem(run: OwnedRun, req?: Request): string | null {
  if (run.status !== 'completed' || !run.prUrl || !run.prNumber) return apiText(req, 'noPrYet');
  if (!run.repoUrl) return apiText(req, 'noRepo');
  if (run.mergedAt) return apiText(req, 'blockedMerged');
  if (run.closedAt) return apiText(req, 'runClosedAlready');
  return null;
}

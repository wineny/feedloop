// 「수정 PR」 상세가 GitHub 에서 읽어 오는 것 — diff · 프리뷰 URL · 빌드 상태 — 와
// 앱 안에서 하는 두 행동(반영 = squash 머지 · 반영하지 않기 = 닫기) (I-19).
//
// 실측(2026-09-13, 데모 레포 PR #8·#10)으로 정한 출처:
//   - 프리뷰 URL: `repos.listDeployments({ sha: head.sha })` → 배포 상태의 `environment_url`.
//     브랜치명(`ref`)으로 찾으면 머지 뒤 브랜치가 지워져 0건이다 — sha 로 찾는다.
//   - 빌드 상태: commit statuses 와 check runs 의 모든 페이지를 함께 판정한다.
//     「Vercel Preview Comments」 체크는 안내용이라 제외한다.
//   - diff: `pulls.listFiles` 의 `patch`. 바이너리·아주 큰 파일은 patch 가 없다.
//
// 토큰은 봇에 등록된 것이 우선이고 없으면 플랫폼 공용 `GITHUB_TOKEN` 이다(B5, `github-auth.ts`).
// 어느 레포로 향할지는 **봇 행의 `github_repo_url`(또는 run 의 `pr_url`)** 만 정한다 —
// 요청 본문의 URL 을 받으면 토큰이 남의 레포로 간다.

import type { Octokit } from '@octokit/rest';
import { parseRepoInfo } from '@/lib/github/repo-url';
import { octokitForBot, noteGithubError, type TokenSource } from '@/lib/auto-dev/github-auth';

/** 어느 봇의 토큰으로 갈지. 비우면 공용 토큰 */
export interface GithubOpts {
  botId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BuildState = 'success' | 'pending' | 'failure' | 'unknown';
export type PreviewState = 'ready' | 'building' | 'failed' | 'unknown';

export interface PrFile {
  path: string;
  /** GitHub 의 status — added · modified · removed · renamed … */
  status: string;
  additions: number;
  deletions: number;
  /** unified diff 조각. 바이너리·거대 파일이면 null */
  patch: string | null;
  /** 상한을 넘어 잘랐는가 */
  patchTruncated: boolean;
}

export interface PrReview {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  draftGate: 'waiting' | 'awaiting_human' | 'failed' | 'promoted' | 'not_draft' | 'unsupported';
  /** 조회는 유지하되 자동 쓰기를 생략한 이유. GitHub의 draft/draftGate 상태를 덮지 않는다. */
  draftGateBlocked?: 'lock_unavailable' | 'write_failed' | 'gate_failed' | 'manual_draft' | 'checks_unavailable';
  createdAt: string;
  /** GitHub 가 아직 계산 중이면 null */
  mergeable: boolean | null;
  mergeableState: string;
  headRef: string;
  headSha: string;
  /** PR 의 head 가 사는 레포(`owner/repo`). fork 에서 온 PR 이면 base 와 다르다 — 브랜치 삭제 가드가 본다 */
  headRepo: string | null;
  baseRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
  /** 100개 넘는 파일은 안 실었다 */
  filesTruncated: boolean;
  preview: { url: string | null; state: PreviewState };
  build: {
    state: BuildState;
    description: string | null;
    /** Vercel 대시보드 등 빌드 로그로 가는 링크 */
    targetUrl: string | null;
    updatedAt: string | null;
    /**
     * Checks·Commit statuses 중 하나라도 권한(403/404) 때문에 못 읽었는가.
     * 전체 통과를 증명할 수 없어 자동 승격은 막고, 조회에는 확인 불가를 표시한다.
     */
    unavailable: boolean;
    failedChecks?: { name: string; url: string | null }[];
  };
  body: string | null;
}

/** 파일 하나의 diff 상한. 화면에 이 이상 그리면 담당자는 어차피 안 읽는다 */
export const PATCH_CHARS_MAX = 20_000;

async function githubClient(opts: GithubOpts | undefined, repoUrl: string): Promise<{ octokit: Octokit; source: TokenSource; botId: string | null }> {
  const botId = opts?.botId ?? null;
  // repoUrl 을 넘긴다 — 옛 PR 이 봇의 지금 레포와 다른 레포(run-access 가 pr_url 우선)면 설치 대신 토큰으로
  const { octokit, source } = await octokitForBot(botId, { repoUrl, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) });
  return { octokit, source, botId };
}

/** 봇 토큰이 거부됐으면 배지가 켜지게 적고, 에러는 그대로 다시 던진다 */
async function rethrowNoted(client: { source: TokenSource; botId: string | null }, err: unknown): Promise<never> {
  await noteGithubError(client.botId, client.source, err);
  throw err;
}

// ─── 순수 판정 — 테스트가 이걸 본다 ─────────────────────────────────────────────

export interface RawStatus {
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
  updated_at?: string;
}

export interface RawCheck {
  name: string;
  status: string;
  conclusion?: string | null;
  details_url?: string | null;
}

/** Both CI sources must pass. Skipped and informational checks are not evidence of a pass. */
export function summarizeBuild(statuses: RawStatus[], checks: RawCheck[]): Omit<PrReview['build'], 'unavailable'> {
  // Commit statuses are newest first; retain only the current result for each context.
  const current = new Map<string, RawStatus>();
  for (const status of [...statuses].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))) {
    if (!current.has(status.context)) current.set(status.context, status);
  }
  const signals = [...current.values()].map((s) => ({
    state: s.state === 'failure' || s.state === 'error' ? 'failure' : s.state === 'success' ? 'success' : 'pending',
    name: s.context, description: s.description ?? null, url: s.target_url ?? null, updatedAt: s.updated_at ?? null,
  }));
  for (const c of checks) {
    if (/preview comments/i.test(c.name) || (c.status === 'completed' && c.conclusion === 'skipped')) continue;
    signals.push({
      state: ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure'].includes(c.conclusion ?? '')
        ? 'failure'
        : c.status === 'completed' && ['success', 'neutral'].includes(c.conclusion ?? '') ? 'success' : 'pending',
      name: c.name, description: c.name, url: c.details_url ?? null, updatedAt: null,
    });
  }
  const state: BuildState = signals.some((s) => s.state === 'failure') ? 'failure'
    : signals.some((s) => s.state === 'pending') ? 'pending'
    : signals.length > 0 ? 'success' : 'unknown';
  const representative = signals.find((s) => s.state === state) ?? signals[0];
  return {
    state,
    failedChecks: signals.filter((s) => s.state === 'failure').map((s) => ({ name: s.name, url: safeExternalUrl(s.url) })),
    description: representative?.description ?? null,
    targetUrl: representative?.url ?? null,
    updatedAt: representative?.updatedAt ?? null,
  };
}

export interface RawDeploymentStatus {
  state: string;
  environment_url?: string | null;
  created_at?: string;
}

/** 배포 상태 목록(최신 우선)에서 프리뷰 URL 과 상태를 고른다. */
export function pickPreview(statuses: RawDeploymentStatus[]): PrReview['preview'] {
  if (statuses.length === 0) return { url: null, state: 'unknown' };
  const latest = [...statuses].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  const withUrl = statuses.find((s) => s.environment_url);
  const state: PreviewState =
    latest.state === 'success'
      ? 'ready'
      : ['pending', 'in_progress', 'queued'].includes(latest.state)
        ? 'building'
        : ['failure', 'error'].includes(latest.state)
          ? 'failed'
          : 'unknown';
  return { url: withUrl?.environment_url ?? null, state };
}

/**
 * 프리뷰는 Vercel 도메인만 링크로 내보낸다 — 배포 상태는 그 레포에 status 를 쓸 수 있는 주체(협업자·
 * 설치된 App·CI)가 정하는 값이라 그대로 믿지 않는다. `*.vercel.app` 전체를 허용하므로 호스트 단위까지는
 * 못 막는다(같은 신뢰 경계라 수용).
 */
export function safePreviewUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.endsWith('.vercel.app') || u.hostname === 'vercel.com')
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * 빌드 로그 링크(commit status 의 target_url)는 https 만 통과시킨다. `javascript:` 는 React 19 가 렌더 중
 * throw 해 상세 패널 전체가 죽고, `data:`·`vbscript:` 는 막히지 않는다 — 서버에서 걸러 화면 두 곳을 따로 안 고친다.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function truncatePatch(patch: string | null | undefined): { patch: string | null; truncated: boolean } {
  if (typeof patch !== 'string') return { patch: null, truncated: false };
  if (patch.length <= PATCH_CHARS_MAX) return { patch, truncated: false };
  return { patch: `${patch.slice(0, PATCH_CHARS_MAX)}\n… (rest omitted)`, truncated: true };
}

/**
 * 반영을 막아야 하는가. 빌드가 실패했거나 아직 도는 중이면 막는다 — 담당자가 비개발자라면 빌드
 * 로그를 보고 우회를 판단할 수 없고, PR #5 는 실제로 빌드가 깨진 채 머지될 뻔했다.
 * 실제 검사가 없는 `unknown`과 권한 부족(unavailable)은 담당자 판단으로 반영할 수 있다.
 * 화면과 라우트가 같은 함수를 본다.
 */
export function mergeBlockedBy(review: Pick<PrReview, 'build' | 'state' | 'merged' | 'mergeable'>):
  | 'merged'
  | 'closed'
  | 'build_failed'
  | 'build_pending'
  | 'conflict'
  | null {
  if (review.merged) return 'merged';
  if (review.state === 'closed') return 'closed';
  if (review.build.state === 'failure') return 'build_failed';
  if (review.build.state === 'pending') return 'build_pending';
  // GitHub 가 계산을 끝냈고 충돌이라고 말할 때만. null 은 아직 모른다는 뜻이라 막지 않는다
  if (review.mergeable === false) return 'conflict';
  return null;
}

// ─── GitHub 호출 ───────────────────────────────────────────────────────────────

export async function getPrReview(repoUrl: string, prNumber: number, opts?: GithubOpts): Promise<PrReview> {
  const client = await githubClient(opts, repoUrl);
  const { octokit } = client;
  const { owner, repo } = parseRepoInfo(repoUrl);

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber }).catch((e) => rethrowNoted(client, e));

  // diff 는 필수(Pull requests 권한이면 반드시 된다). 아래 셋은 fine-grained 토큰에 **Deployments·Checks·
  // Commit statuses 권한이 따로** 있어야 하고, 없으면 빈 목록이 아니라 403 이 온다. 그걸 throw 로 올리면
  // 우리가 안내한 최소 권한(Contents·Pull requests)으로 만든 PR 을 앱에서 검토·반영·닫기 전부 못 한다
  // (코드 리뷰 BLOCKER). 없으면 unavailable을 표시하고 자동 승격만 막는다. 담당자는 확인 없이 반영할 수 있다.
  // «못 물어봤다»(403 권한 없음·레이트리밋 / 404)만 빈 목록으로 내리고 표시한다. 5xx·네트워크는 진짜 장애라 올린다 —
  // 삼키면 「모름」이 「CI 없음」과 구분되지 않고, 토큰이 멀쩡한데 레이트리밋에 걸린 60초 폴링이 빌드 게이트를 조용히 푼다
  const denied = { deployments: false, checks: false, statuses: false };
  // 빈 값은 «우리가 읽는 필드»만 가진 부분 응답이다(Octokit 응답의 headers·status 는 안 쓴다)
  const optional = <D,>(p: Promise<{ data: D }>, empty: D, key: keyof typeof denied): Promise<{ data: D }> =>
    p.catch((e: unknown) => {
      const st = statusOf(e);
      if (st === 403 || st === 404) {
        denied[key] = true;
        console.warn('[pr-review] optional signal unavailable', { key, status: st, owner, repo, prNumber });
        return { data: empty };
      }
      throw e;
    });
  const [filesRes, deploymentsRes, checksRes, statusesRes] = await Promise.all([
    octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }).catch((e) => rethrowNoted(client, e)),
    optional(octokit.repos.listDeployments({ owner, repo, sha: pr.head.sha, per_page: 5 }), [], 'deployments'),
    optional(octokit.paginate(octokit.checks.listForRef, { owner, repo, ref: pr.head.sha, per_page: 100, filter: 'latest' }).then((data) => ({ data: [...data] })), [], 'checks'),
    optional(
      octokit.paginate(octokit.repos.listCommitStatusesForRef, { owner, repo, ref: pr.head.sha, per_page: 100 }).then((data) => ({ data })),
      [],
      'statuses',
    ),
  ]);

  // 배포는 보통 1개다. 여러 개면 전부의 상태를 모아 최신 것을 본다
  const deploymentStatuses: RawDeploymentStatus[] = [];
  for (const d of deploymentsRes.data.slice(0, 3)) {
    const { data: statuses } = await optional(
      octokit.repos.listDeploymentStatuses({ owner, repo, deployment_id: d.id, per_page: 5 }),
      [],
      'deployments',
    );
    for (const s of statuses) {
      deploymentStatuses.push({ state: s.state, environment_url: s.environment_url, created_at: s.created_at });
    }
  }

  const preview = pickPreview(deploymentStatuses);
  const build = summarizeBuild(
    statusesRes.data.map((s) => ({
      context: s.context, state: s.state, description: s.description, target_url: s.target_url, updated_at: s.updated_at,
    })),
    checksRes.data.map((c) => ({
      name: c.name, status: c.status, conclusion: c.conclusion, details_url: c.details_url,
    })),
  );
  const buildUnavailable = denied.checks || denied.statuses;

  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged: pr.merged === true,
    draft: pr.draft === true,
    draftGate: pr.draft ? (build.state === 'failure' ? 'failed' : build.state !== 'pending' && buildUnavailable ? 'awaiting_human' : 'waiting') : (pr.body?.includes('<!-- feedloop:draft-unsupported -->') ? 'unsupported' : 'not_draft'),
    createdAt: pr.created_at,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? 'unknown',
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepo: pr.head.repo?.full_name ?? null,
    baseRef: pr.base.ref,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    files: filesRes.data.map((f) => {
      const { patch, truncated } = truncatePatch(f.patch);
      return {
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch,
        patchTruncated: truncated,
      };
    }),
    filesTruncated: (pr.changed_files ?? 0) > filesRes.data.length,
    preview: { url: safePreviewUrl(preview.url), state: preview.state },
    // 어느 출처든 못 읽었으면 전체 검사 통과를 입증할 수 없다.
    build: { ...build, state: buildUnavailable && build.state === 'success' ? 'unknown' : build.state, targetUrl: safeExternalUrl(build.targetUrl), unavailable: buildUnavailable },
    body: pr.body ?? null,
  };
}

export interface MergeOutcome {
  sha: string;
  /** 레포가 squash 를 꺼 뒀으면 merge 커밋으로 폴백한다 — 화면이 그 사실을 적는다 */
  method: 'squash' | 'merge';
  branchDeleted: boolean;
}

/**
 * squash 로 머지한다. 사람이 PR 브랜치에 보강 커밋을 얹어도(PR #5 때 번역 키 커밋) 히스토리엔
 * 한 줄로 남고, 커밋 제목이 「수정안 제목 (#N)」 이라 나중에 레포에서 Feedloop 이 만든 변경을 찾을 수 있다.
 * 405 = 레포 설정이 그 방식을 막았다는 뜻이라 merge 커밋으로 한 번 더 시도한다.
 */
/** 브랜치 삭제가 허용되는 조건 — 같은 레포의 브랜치이고 base 브랜치가 아닐 때만 */
export interface BranchRef {
  headRef: string;
  headRepo: string | null;
  baseRef: string;
}

export async function mergePr(
  repoUrl: string,
  prNumber: number,
  opts: { title: string; message: string; expectedHeadSha: string } & BranchRef,
  gh?: GithubOpts,
): Promise<MergeOutcome> {
  const client = await githubClient(gh, repoUrl);
  const { octokit } = client;
  const { owner, repo } = parseRepoInfo(repoUrl);

  let method: MergeOutcome['method'] = 'squash';
  let sha: string;
  try {
    const { data } = await octokit.pulls.merge({
      owner, repo, pull_number: prNumber,
      sha: opts.expectedHeadSha,
      merge_method: 'squash',
      commit_title: opts.title,
      commit_message: opts.message,
    });
    if (data.merged !== true) throw new MergeError('unconfirmed', 409);
    sha = data.sha;
  } catch (err) {
    // 405 는 「squash 금지」라는 레포 설정이지 토큰 문제가 아니다 — 그건 merge 로 다시 시도한다(아래).
    // 배지는 405 가 아닐 때만 켠다(보안 리뷰 L2)
    if (statusOf(err) !== 405) {
      await noteGithubError(client.botId, client.source, err, { write: true });
      throw describeMergeError(err);
    }
    method = 'merge';
    try {
      const { data } = await octokit.pulls.merge({
        owner, repo, pull_number: prNumber,
        sha: opts.expectedHeadSha,
        merge_method: 'merge',
        commit_title: opts.title,
        commit_message: opts.message,
      });
      if (data.merged !== true) throw new MergeError('unconfirmed', 409);
      sha = data.sha;
    } catch (err2) {
      await noteGithubError(client.botId, client.source, err2, { write: true });
      throw describeMergeError(err2);
    }
  }

  return { sha, method, branchDeleted: await deleteBranch(octokit, owner, repo, opts) };
}

/** 머지 없이 닫는다. 브랜치도 지운다 — 남겨 두면 레포에 쓰레기 브랜치가 쌓인다. */
export async function closePr(
  repoUrl: string,
  prNumber: number,
  branch: BranchRef,
  gh?: GithubOpts,
): Promise<{ branchDeleted: boolean }> {
  const client = await githubClient(gh, repoUrl);
  const { octokit } = client;
  const { owner, repo } = parseRepoInfo(repoUrl);
  await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' }).catch(async (e) => {
    await noteGithubError(client.botId, client.source, e, { write: true });
    throw e;
  });
  return { branchDeleted: await deleteBranch(octokit, owner, repo, branch) };
}

/**
 * 지워도 되는 브랜치인가. fork 에서 온 PR 은 `head.ref` 가 fork 쪽 이름이라 base 레포의 동명 브랜치를
 * 지우게 된다 — head 레포가 이 레포일 때만. base 브랜치(main 이든 develop 이든)는 이름과 무관하게 안 지운다.
 */
export function canDeleteBranch(branch: BranchRef, ownerRepo: string): boolean {
  if (!branch.headRef || branch.headRef === branch.baseRef) return false;
  if (!branch.headRepo || branch.headRepo.toLowerCase() !== ownerRepo.toLowerCase()) return false;
  return true;
}

/** PR 에 댓글을 단다 — [AI 에게 확인시키기] 결과를 GitHub 쪽에도 남기려고. 실패해도 throw 하지 않는다. */
export async function commentOnPr(repoUrl: string, prNumber: number, body: string, gh?: GithubOpts): Promise<boolean> {
  let client: { source: TokenSource; botId: string | null } | null = null;
  try {
    const c = await githubClient(gh, repoUrl);
    client = c;
    const { owner, repo } = parseRepoInfo(repoUrl);
    await c.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
    return true;
  } catch (err) {
    // 댓글은 부수 경로라 삼키지만, 봇 토큰이 거부된 사실은 남긴다 — 다음 행동에서 원인을 찾게.
    // 기록 자체가 실패해도 이 함수의 계약(throw 안 함)은 지킨다 — 판정은 이미 저장된 뒤다
    if (client) await noteGithubError(client.botId, client.source, err).catch(() => {});
    console.error('[pr-review] comment failed', err instanceof Error ? err.message : err);
    return false;
  }
}

/** PR 헤드 시점의 파일 원본. [AI 에게 확인시키기] 가 못 읽었던 파일을 읽는 데 쓴다. */
export async function fetchFileAtRef(
  repoUrl: string,
  path: string,
  ref: string,
  gh?: GithubOpts,
): Promise<string | null> {
  const client = await githubClient(gh, repoUrl);
  const { owner, repo } = parseRepoInfo(repoUrl);
  try {
    const { data } = await client.octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (statusOf(err) === 404) return null;
    await noteGithubError(client.botId, client.source, err);
    throw err;
  }
}

async function deleteBranch(octokit: Octokit, owner: string, repo: string, branch: BranchRef): Promise<boolean> {
  if (!canDeleteBranch(branch, `${owner}/${repo}`)) {
    console.warn('[pr-review] branch delete skipped', { headRef: branch.headRef, headRepo: branch.headRepo, baseRef: branch.baseRef });
    return false;
  }
  try {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch.headRef}` });
    return true;
  } catch (err) {
    // 이미 지워졌거나(422) 보호 브랜치면 그냥 둔다 — 머지·닫기 자체는 끝났다
    console.error('[pr-review] branch delete failed', branch.headRef, err instanceof Error ? err.message : err);
    return false;
  }
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : null;
}

/** GitHub 의 머지 실패 사유를 코드로. 상태코드는 남겨 라우트가 그대로 돌려준다. */
export type MergeErrorCode = 'unconfirmed' | 'blocked' | 'conflict' | 'not_found' | 'forbidden' | 'failed';

/** `code` 는 라우트가 요청 언어 문구(errors.api `merge_<code>`)로 바꾼다. `detail` 은 GitHub 원문(failed 일 때만). */
export class MergeError extends Error {
  constructor(public readonly code: MergeErrorCode, public readonly status: number, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

function describeMergeError(err: unknown): Error {
  const status = statusOf(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (status === 405) return new MergeError('blocked', 409);
  if (status === 409) return new MergeError('conflict', 409);
  if (status === 404) return new MergeError('not_found', 404);
  if (status === 403) return new MergeError('forbidden', 403);
  return new MergeError('failed', 502, raw);
}

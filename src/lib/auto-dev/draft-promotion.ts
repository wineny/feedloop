import { acquireDraftGateLease, DraftGateLockError, type DraftGateLease } from './draft-gate-lock';
import { readGithubAppConfig } from '@/lib/github/app';
import { parseRepoInfo } from '@/lib/github/repo-url';
import { octokitForBot, noteGithubError } from './github-auth';
import { DRAFT_PROMOTED_MARKER, hasDraftWaitMarker, hasPromotedMarker } from './draft-markers';
import { getPrReview, mergeBlockedBy, safeExternalUrl, type GithubOpts, type PrReview } from './pr-review';

export const DRAFT_GRACE_MS = 10 * 60 * 1000;
export const DRAFT_FAILED_MARKER = '<!-- feedloop:draft-gate:failed -->';
export const DRAFT_PROMOTION_MARKER = '<!-- feedloop:draft-gate:promotion -->';
const GRACE_REASON = '<!-- feedloop:draft-gate:reason:grace -->';
const GRACE_TEXT = '생성 후 10분 동안 확인할 수 있는 검사가 없어 검토 요청으로 바꿨습니다';
const PROMOTED_TEXT = '자동 검사를 통과해 검토 요청으로 바꿨습니다';
const HUMAN_REASON = '<!-- feedloop:draft-gate:reason:human-unavailable -->';
const HUMAN_TEXT = '검사 결과를 읽을 권한이 없어 담당자 판단으로 반영하기 위해 검토 요청으로 바꿨습니다';

export interface DraftPromotionOpts extends GithubOpts {
  /** 소유 확인과 Origin 검사를 지난 명시적 반영 요청에서만 사용한다. */
  allowUnavailableForMerge?: boolean;
}

function humanUnavailablePromotion(review: PrReview, opts?: DraftPromotionOpts): boolean {
  return opts?.allowUnavailableForMerge === true && review.draft && review.build.unavailable
    && mergeBlockedBy(review) === null;
}

export function decideDraftPromotion(input: {
  draft: boolean;
  build: Pick<PrReview['build'], 'state' | 'unavailable'>;
  createdAt: string;
  now?: number | Date;
}): 'promote' | 'wait' | 'keep_failed' | 'not_draft' {
  if (!input.draft) return 'not_draft';
  if (input.build.state === 'failure') return 'keep_failed';
  if (input.build.unavailable) return 'wait';
  if (input.build.state === 'success') return 'promote';
  if (input.build.state === 'pending') return 'wait';
  const age = Number(input.now ?? Date.now()) - Date.parse(input.createdAt);
  return age >= DRAFT_GRACE_MS ? 'promote' : 'wait';
}

// Queue local requests and acquire a shared database lease before GitHub writes.
const locks = new Map<string, Promise<PrReview>>();
export async function reviewAndPromoteDraft(repoUrl: string, prNumber: number, opts?: DraftPromotionOpts): Promise<PrReview> {
  opts = { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 15000, 15000) };
  const { owner, repo } = parseRepoInfo(repoUrl);
  const key = `${owner}/${repo}/${prNumber}`.toLowerCase();
  const previous = locks.get(key);
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(async (): Promise<PrReview> => {
    const review = await getPrReview(repoUrl, prNumber, opts);
    const humanPromotion = humanUnavailablePromotion(review, opts);
    if (review.draft && review.state === 'open' && !review.merged && review.draftGate !== 'unsupported'
      && hasDraftWaitMarker(review.body) && review.build.unavailable && !humanPromotion) {
      return { ...review, draftGateBlocked: 'checks_unavailable' };
    }
    if (!humanPromotion && isNoop(review)) return review;
    let logged = false;
    const logSkipped = (error: unknown) => {
      if (!logged) console.warn('[draft-gate] skipped', { key, reason: error instanceof Error ? error.message : 'lease busy' });
      logged = true;
    };
    let lease: DraftGateLease | null;
    try { lease = await acquireDraftGateLease(key, opts?.signal); }
    catch (error) {
      logSkipped(error);
      return { ...review, draftGateBlocked: 'lock_unavailable' };
    }
    if (!lease) {
      logSkipped(null);
      return { ...review, draftGateBlocked: 'lock_unavailable' };
    }
    try { return await applyGate(repoUrl, prNumber, review, lease, opts); }
    catch (error) {
      logSkipped(error);
      // A transition might already have succeeded before ownership/release failed.
      return { ...review, draftGateBlocked: error instanceof DraftGateLockError ? 'lock_unavailable' : error instanceof GateWriteError ? 'write_failed' : 'gate_failed' };
    } finally {
      try { await lease.release(); }
      catch (error) { logSkipped(error); }
    }
  });
  locks.set(key, task);
  try { return await task; }
  finally { if (locks.get(key) === task) locks.delete(key); }
}

function markdownText(value: string): string {
  return value.replace(/@/g, '@\u200b').replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()<>!#]/g, '\\$&');
}

function isNoop(review: PrReview): boolean {
  return review.state !== 'open' || review.merged || review.draftGate === 'unsupported'
    || !review.draft || !hasDraftWaitMarker(review.body)
    || decideDraftPromotion(review) === 'wait';
}

class GateWriteError extends Error {}

async function applyGate(repoUrl: string, prNumber: number, review: PrReview, lease: DraftGateLease, opts?: DraftPromotionOpts): Promise<PrReview> {
  const humanPromotion = humanUnavailablePromotion(review, opts);
  const successText = humanPromotion ? HUMAN_TEXT : review.build.state === 'unknown' ? GRACE_TEXT : PROMOTED_TEXT;
  const decision = humanPromotion ? 'promote' : decideDraftPromotion(review);
  if (decision === 'wait') return review;
  const botId = opts?.botId ?? null;
  const { octokit, source } = await octokitForBot(botId, { repoUrl, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.signal ? { signal: opts.signal } : {}) });
  const { owner, repo } = parseRepoInfo(repoUrl);
  const issue = { owner, repo, issue_number: prNumber };
  // Classify only the operation that actually failed; secondary rate limits are not permission failures.
  const github = async <T>(write: boolean, call: () => Promise<T>): Promise<T> => {
    try { return await call(); }
    catch (error) {
      const failure = error as { message?: string; response?: { headers?: Record<string, string> } };
      const headers = failure.response?.headers;
      const rateLimited = /rate.?limit|abuse/i.test(failure.message ?? '') || headers?.['retry-after'] !== undefined || headers?.['x-ratelimit-remaining'] === '0';
      if (!rateLimited) await noteGithubError(botId, source, error, { write }).catch(() => undefined);
      if (write) throw new GateWriteError(error instanceof Error ? error.message : 'GitHub write failed');
      throw error;
    }
  };
  const login = source === 'installation' ? null : (await github(false, () => octokit.users.getAuthenticated())).data.login.toLowerCase();
  const slug = source === 'installation' ? readGithubAppConfig()?.slug.toLowerCase() : null;
  if (source === 'installation' && !slug) throw new Error('GitHub App actor unavailable');
  const comments = await github(false, () => octokit.paginate(octokit.issues.listComments, { ...issue, per_page: 100 }));
  const trusted = comments.filter(c => source === 'installation'
    ? c.user?.type === 'Bot' && c.user.login.toLowerCase() === `${slug}[bot]` && c.performed_via_github_app?.slug?.toLowerCase() === slug
    : c.user?.login.toLowerCase() === login);
  const promotion = trusted.find(c => c.body?.includes(DRAFT_PROMOTION_MARKER));
  if (!humanPromotion && trusted.some(c => c.body?.includes(DRAFT_PROMOTION_MARKER) && hasPromotedMarker(c.body))) {
    return { ...review, draftGateBlocked: 'manual_draft' };
  }
  // A manual convert-to-draft survives even if the completion comment was lost.
  // An explicit merge click is a new human decision, unlike automatic polling.
  if (!humanPromotion) {
    const timeline = await github(false, () => octokit.graphql<{
      repository: { pullRequest: { timelineItems: { nodes: { id: string }[] } } };
    }>('query DraftHistory($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { timelineItems(last: 1, itemTypes: [CONVERT_TO_DRAFT_EVENT]) { nodes { ... on ConvertToDraftEvent { id } } } } } }', { owner, repo, number: prNumber }));
    const conversions = timeline.repository?.pullRequest?.timelineItems?.nodes;
    if (!Array.isArray(conversions)) throw new Error('GitHub draft history unavailable');
    if (conversions.length) return { ...review, draftGateBlocked: 'manual_draft' };
  }
  const promotionText = `${DRAFT_PROMOTED_MARKER}\n${successText}`;
  const reasonMarker = humanPromotion ? HUMAN_REASON : review.build.state === 'unknown' ? GRACE_REASON : '';
  if (decision === 'keep_failed') {
    if (!trusted.some((c) => c.body?.includes(DRAFT_FAILED_MARKER))) {
      const failures = (review.build.failedChecks ?? []).map((c) => {
        const url = safeExternalUrl(c.url);
        return `- ${markdownText(c.name)}${url ? ` — <${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : ''}`;
      });
      await lease.assertOwned();
      await github(true, () => octokit.issues.createComment({ ...issue, body: `${DRAFT_FAILED_MARKER}\n자동 검사가 실패해 초안으로 유지합니다.\n${failures.join('\n')}` }));
    }
    return review;
  }
  if (!promotion) await lease.assertOwned();
  const intentText = humanPromotion ? '검사 결과를 읽을 권한이 없어 담당자 판단으로 반영할 준비를 합니다.' : '자동 검사 판정을 마쳐 검토 요청으로 전환합니다.';
  const intent = promotion ?? (await github(true, () => octokit.issues.createComment({ ...issue, body: `${DRAFT_PROMOTION_MARKER}\n${reasonMarker}\n${intentText}` }))).data;
  if (promotion && (humanPromotion || Boolean(promotion.body?.includes(GRACE_REASON)) !== Boolean(reasonMarker))) {
    await lease.assertOwned();
    await github(true, () => octokit.issues.updateComment({ owner, repo, comment_id: promotion.id, body: `${DRAFT_PROMOTION_MARKER}\n${reasonMarker}\n${intentText}` }));
  }
  // Recheck state/head immediately before the write; new commits require fresh signals.
  const { data: current } = await github(false, () => octokit.pulls.get({ owner, repo, pull_number: prNumber }));
  if (current.state !== 'open' || current.merged || current.head.sha !== review.headSha) return getPrReview(repoUrl, prNumber, opts);
  if (current.draft) {
    await lease.assertOwned();
    try {
      const result = await github(true, () => octokit.graphql<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } } }>(
        'mutation Ready($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { isDraft } } }',
        { pullRequestId: current.node_id },
      ));
      if (result.markPullRequestReadyForReview.pullRequest.isDraft !== false) throw new GateWriteError('GitHub did not confirm draft promotion');
    } catch (error) {
      // Another instance (or a lost response) may already have completed this transition.
      const { data: after } = await github(false, () => octokit.pulls.get({ owner, repo, pull_number: prNumber }));
      if (after.draft !== false || after.state !== 'open' || after.merged || after.head.sha !== review.headSha) throw error;
    }
  }
  review.draft = false;
  review.draftGate = 'promoted';
  await lease.assertOwned();
  await github(true, () => octokit.issues.updateComment({ owner, repo, comment_id: intent.id, body: `${DRAFT_PROMOTION_MARKER}\n${reasonMarker}\n${promotionText}` }));
  return { ...review, draft: false, draftGate: 'promoted' };
}

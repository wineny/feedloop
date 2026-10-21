import type { Octokit } from '@octokit/rest';
import { DRAFT_WAIT_MARKER } from './draft-markers';

export const DRAFT_UNSUPPORTED_NOTICE = "This repository doesn't support draft PRs, so a regular PR was opened";
export const DRAFT_UNSUPPORTED_MARKER = '<!-- feedloop:draft-unsupported -->';

function draftUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as {
    status?: number;
    message?: unknown;
    response?: { data?: { message?: unknown; errors?: Array<{ message?: unknown }> } };
  };
  if (failure.status !== 422) return false;
  const messages = [failure.message, failure.response?.data?.message,
    ...(failure.response?.data?.errors ?? []).map(item => item.message)];
  return messages.some(message => typeof message === 'string' &&
    /draft pull requests? (?:are|is) not supported (?:in|for) this repository/i.test(message));
}

/** Only retry GitHub's explicit unsupported-draft response, never generic validation failures. */
export async function createDraftPr(
  octokit: Octokit,
  params: { owner: string; repo: string; title: string; body: string; head: string; base: string },
  beforeWrite: () => Promise<void>,
) {
  const body = `${params.body}\n\n${DRAFT_WAIT_MARKER}\n## Waiting for automatic checks\nThis PR is marked ready for review when automatic checks pass. If there are no checks to run, it is marked ready for review 10 minutes after it was created.`;
  await beforeWrite();
  try {
    return await octokit.pulls.create({ ...params, body, draft: true });
  } catch (error) {
    if (!draftUnsupported(error)) throw error;
    console.warn(`[auto-dev] ${params.owner}/${params.repo}: ${DRAFT_UNSUPPORTED_NOTICE}`);
    await beforeWrite();
    return octokit.pulls.create({
      ...params,
      body: `${body}\n\n${DRAFT_UNSUPPORTED_MARKER}\n${DRAFT_UNSUPPORTED_NOTICE}`,
    });
  }
}

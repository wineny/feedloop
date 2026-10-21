import type { Octokit } from '@octokit/rest';
import { DRAFT_WAIT_MARKER } from './draft-markers';

export const DRAFT_UNSUPPORTED_NOTICE = '이 레포는 초안 PR 을 지원하지 않아 일반 PR 로 열었습니다';
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
  const body = `${params.body}\n\n${DRAFT_WAIT_MARKER}\n## 자동 검사 대기\n자동 검사가 통과하면 초안에서 검토 요청으로 바뀝니다. 확인할 검사가 없으면 PR 생성 후 10분 뒤 검토 요청으로 바뀝니다.`;
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

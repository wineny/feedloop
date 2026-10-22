import { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr, DRAFT_UNSUPPORTED_MARKER, DRAFT_UNSUPPORTED_NOTICE } from '../src/lib/auto-dev/draft-pr-create';

const params = { owner: 'fixture', repo: 'repository', title: 'Fix', body: 'Existing body', head: 'fix', base: 'main' };
const unsupported = 'Draft pull requests are not supported in this repository.';

// Use real Octokit serialization and RequestError parsing; only replace HTTP transport.
function client(responses: Array<{ status: number; data: unknown }>) {
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra request');
    return new Response(JSON.stringify(response.data), {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  });
  return { octokit: new Octokit({ request: { fetch } }), requests };
}

afterEach(() => vi.restoreAllMocks());

describe('createDraftPr', () => {
  it('sends draft:true and the waiting explanation with existing body intact', async () => {
    const { octokit, requests } = client([{ status: 201, data: { number: 7 } }]);
    const beforeWrite = vi.fn(async () => {});
    const result = await createDraftPr(octokit, params, beforeWrite);
    expect(result.data.number).toBe(7);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ title: params.title, head: params.head, base: params.base, draft: true, body: expect.stringContaining('Existing body') });
    expect(requests[0].body).toContain('## Waiting for automatic checks');
    expect(requests[0].body).toContain('<!-- feedloop:draft-wait -->');
    expect(requests[0].body).toContain('ready for review');
    expect(beforeWrite).toHaveBeenCalledOnce();
  });

  it.each([
    { message: unsupported },
    { message: 'Validation Failed', errors: [{ message: unsupported }] },
  ])('retries an explicit unsupported-draft 422 once without draft and records it: %j', async data => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { octokit, requests } = client([{ status: 422, data }, { status: 201, data: { number: 8 } }]);
    const beforeWrite = vi.fn(async () => {});
    await createDraftPr(octokit, params, beforeWrite);
    expect(requests).toHaveLength(2);
    expect(requests[0].draft).toBe(true);
    expect(requests[1]).not.toHaveProperty('draft');
    expect(requests[1].body).toContain(DRAFT_UNSUPPORTED_NOTICE);
    expect(requests[1].body).toContain(DRAFT_UNSUPPORTED_MARKER);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(DRAFT_UNSUPPORTED_NOTICE));
    expect(beforeWrite).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 422, message: 'No commits between main and fix' },
    { status: 422, message: 'A pull request already exists for fixture:fix.' },
    { status: 422, message: 'Draft pull request validation failed.' },
    { status: 403, message: unsupported },
  ])('does not hide other failures: $status $message', async ({ status, message }) => {
    const { octokit, requests } = client([{ status, data: { message } }]);
    await expect(createDraftPr(octokit, params, async () => {})).rejects.toMatchObject({ status });
    expect(requests).toHaveLength(1);
  });

  it('propagates a fallback failure without a third attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { octokit, requests } = client([
      { status: 422, data: { message: unsupported } },
      { status: 422, data: { message: unsupported } },
    ]);
    await expect(createDraftPr(octokit, params, async () => {})).rejects.toMatchObject({ status: 422 });
    expect(requests).toHaveLength(2);
  });

  it('rechecks publication ownership before fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { octokit, requests } = client([{ status: 422, data: { message: unsupported } }]);
    const beforeWrite = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'));
    await expect(createDraftPr(octokit, params, beforeWrite)).rejects.toThrow('lease lost');
    expect(requests).toHaveLength(1);
  });
});

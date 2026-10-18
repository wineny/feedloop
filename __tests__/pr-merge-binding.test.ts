import { beforeEach, expect, it, vi } from 'vitest';
const { merge, deleteRef } = vi.hoisted(() => ({ merge: vi.fn(), deleteRef: vi.fn() }));
vi.mock('@octokit/rest', () => ({ Octokit: function () { return { pulls: { merge }, git: { deleteRef } }; } }));
import { mergePr } from '@/lib/auto-dev/pr-review';
const opts = { title: 't', message: 'm', expectedHeadSha: 'a'.repeat(40), headRef: 'fix/x', headRepo: 'o/r', baseRef: 'main' };
beforeEach(() => { vi.resetAllMocks(); process.env.GITHUB_TOKEN = 'test-only'; });
it('sends the reviewed SHA on squash and on the fallback', async () => {
 merge.mockRejectedValueOnce({status:405}).mockResolvedValueOnce({data:{merged:true,sha:'merged'}});
 await mergePr('https://github.com/o/r',1,opts);
 expect(merge).toHaveBeenNthCalledWith(1,expect.objectContaining({sha:opts.expectedHeadSha,merge_method:'squash'}));
 expect(merge).toHaveBeenNthCalledWith(2,expect.objectContaining({sha:opts.expectedHeadSha,merge_method:'merge'}));
});
it('a changed head is rejected without deleting the branch', async () => {
 merge.mockRejectedValue({status:409});
 await expect(mergePr('https://github.com/o/r',1,opts)).rejects.toMatchObject({status:409});
 expect(deleteRef).not.toHaveBeenCalled();
});
it.each([false,undefined])('a SHA alone is not merge success: merged=%s', async merged => {
 merge.mockResolvedValue({data:{merged,sha:'not-proof'}});
 await expect(mergePr('https://github.com/o/r',1,opts)).rejects.toMatchObject({status:409});
 expect(deleteRef).not.toHaveBeenCalled();
});

it('fallback response must also explicitly confirm merged', async () => {
 merge.mockRejectedValueOnce({status:405}).mockResolvedValueOnce({data:{merged:false,sha:'not-proof'}});
 await expect(mergePr('https://github.com/o/r',1,opts)).rejects.toMatchObject({status:409});
 expect(deleteRef).not.toHaveBeenCalled();
});

// Explicitly authorized disposable probe; this cannot target the live repository.
import { config } from 'dotenv';
import { octokitForBot } from '../src/lib/auto-dev/github-auth';
import { createDraftPr } from '../src/lib/auto-dev/draft-pr-create';

config({ path: '.env.local', quiet: true });

async function main() {
  const owner = 'wineny';
  const repo = 'nullnul-tour-demo';
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const { octokit } = await octokitForBot(null, { repoUrl, timeoutMs: 15_000 });
  const { data: repository } = await octokit.repos.get({ owner, repo });
  const base = repository.default_branch;
  const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
  const branch = `feedloop/probe-draft-gate-${Date.now().toString(36)}`;
  let branchCreated = false;
  let prNumber: number | undefined;
  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseRef.object.sha });
    branchCreated = true;
    const { data: file } = await octokit.repos.getContent({ owner, repo, path: 'README.md', ref: base });
    if (Array.isArray(file) || file.type !== 'file') throw new Error('README.md unavailable');
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, branch, path: 'README.md', sha: file.sha,
      message: 'chore: disposable draft PR gate probe (never merge)',
      content: Buffer.from(`${Buffer.from(file.content, 'base64').toString('utf8')}\n<!-- ${branch} -->\n`).toString('base64'),
    });
    const { data: pr } = await createDraftPr(octokit, {
      owner, repo, head: branch, base,
      title: '[probe] 초안 PR 지원 실측 — 머지 금지',
      body: '초안 지원 여부를 확인한 뒤 닫고 브랜치를 지웁니다.',
    }, async () => {});
    prNumber = pr.number;
    const { data: observed } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
    console.log(JSON.stringify({ repository: `${owner}/${repo}`, private: repository.private,
      pr: observed.number, url: observed.html_url, draft: observed.draft,
      unsupportedFallback: observed.body?.includes('<!-- feedloop:draft-unsupported -->') ?? false,
      branch }, null, 2));
  } finally {
    // Even if closing fails, attempt branch cleanup; report failures to the caller.
    try {
      if (prNumber) {
        await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
        const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
        if (data.state !== 'closed' || data.merged) throw new Error('Probe PR cleanup not confirmed');
        console.log(`CLEANUP PR #${prNumber}: closed, unmerged`);
      }
    } finally {
      if (branchCreated) {
        await octokit.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
        try {
          await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
          throw new Error('Probe branch still exists');
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
        }
        console.log(`CLEANUP branch ${branch}: deleted`);
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Probe failed');
  process.exitCode = 1;
});

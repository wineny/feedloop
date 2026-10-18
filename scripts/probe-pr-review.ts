// GitHub 가 PR 하나에 대해 무엇을 주는지 실측한다 — 「수정 PR」 상세의 diff·프리뷰·빌드 상태 재료.
//
//   npx tsx scripts/probe-pr-review.ts --repo wineny/nullnul-tour-demo --pr 10
//   npx tsx scripts/probe-pr-review.ts --repo wineny/nullnul-tour-demo --open   # 프로브용 PR 을 새로 연다
//
// 프리뷰 URL 이 Deployments(environment_url)에 오는지, Checks 와 Combined Status 중 어느 쪽에
// Vercel 이 쓰는지는 레포마다 다를 수 있어 코드를 쓰기 전에 눈으로 본다.
import { config } from 'dotenv';
import { Octokit } from '@octokit/rest';

config({ path: '.env.local', quiet: true });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN 없음');
  const [owner, repo] = (arg('repo') ?? 'wineny/nullnul-tour-demo').split('/');
  const octokit = new Octokit({ auth: token });

  let prNumber = arg('pr') ? Number(arg('pr')) : null;

  if (process.argv.includes('--open')) {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const base = repoData.default_branch;
    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
    const branch = `feedloop/probe-${Date.now().toString(36)}`;
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.object.sha });
    // README 끝에 한 줄 — 빌드에 영향 없는 변경으로 Vercel 프리뷰를 유발한다
    const path = 'README.md';
    const { data: file } = await octokit.repos.getContent({ owner, repo, path, ref: base });
    if (Array.isArray(file) || file.type !== 'file') throw new Error('README 없음');
    const content = Buffer.from(file.content, 'base64').toString('utf-8') + `\n<!-- feedloop probe ${branch} -->\n`;
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path, branch, sha: file.sha,
      message: 'chore: feedloop PR 검토 화면 실측용 (머지하지 않음)',
      content: Buffer.from(content).toString('base64'),
    });
    const { data: pr } = await octokit.pulls.create({
      owner, repo, head: branch, base,
      title: '[probe] Feedloop PR 검토 화면 실측 — 머지하지 않음',
      body: 'Deployments / Checks / Combined Status 필드 실측용. 확인 뒤 닫는다.',
    });
    prNumber = pr.number;
    console.log('opened PR', pr.number, pr.html_url, 'branch', branch);
  }

  if (!prNumber) throw new Error('--pr 또는 --open 필요');

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  console.log('\n=== pulls.get');
  console.log({
    state: pr.state, merged: pr.merged, mergeable: pr.mergeable, mergeable_state: pr.mergeable_state,
    head: pr.head.ref, headSha: pr.head.sha, base: pr.base.ref,
    additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files,
    merged_by: pr.merged_by?.login, merge_commit_sha: pr.merge_commit_sha,
  });

  const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 });
  console.log('\n=== pulls.listFiles');
  for (const f of files) {
    console.log({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patchLen: f.patch?.length ?? null });
    if (f.patch) console.log(f.patch.split('\n').slice(0, 6).join('\n'));
  }

  const { data: deployments } = await octokit.repos.listDeployments({ owner, repo, ref: pr.head.ref, per_page: 5 });
  console.log('\n=== repos.listDeployments (ref=head.ref)', deployments.length);
  for (const d of deployments) {
    console.log({ id: d.id, sha: d.sha.slice(0, 7), environment: d.environment, task: d.task, created: d.created_at, creator: d.creator?.login });
    const { data: statuses } = await octokit.repos.listDeploymentStatuses({ owner, repo, deployment_id: d.id, per_page: 5 });
    for (const s of statuses) {
      console.log('   status', { state: s.state, environment_url: s.environment_url, target_url: s.target_url, log_url: s.log_url, created: s.created_at });
    }
  }
  // sha 로도 조회해 본다 — 브랜치명보다 정확할 수 있다
  const { data: bySha } = await octokit.repos.listDeployments({ owner, repo, sha: pr.head.sha, per_page: 5 });
  console.log('listDeployments (sha=head.sha)', bySha.length);
  for (const d of bySha) {
    console.log({ id: d.id, environment: d.environment, original_environment: d.original_environment, transient: d.transient_environment, production: d.production_environment, created: d.created_at });
    const { data: statuses } = await octokit.repos.listDeploymentStatuses({ owner, repo, deployment_id: d.id, per_page: 5 });
    for (const s of statuses) {
      console.log('   status', { state: s.state, environment_url: s.environment_url, target_url: s.target_url, log_url: s.log_url, created: s.created_at });
    }
  }

  const { data: checks } = await octokit.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 20 });
  console.log('\n=== checks.listForRef', checks.total_count);
  for (const c of checks.check_runs) {
    console.log({ name: c.name, app: c.app?.slug, status: c.status, conclusion: c.conclusion, details_url: c.details_url });
  }

  const { data: combined } = await octokit.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
  console.log('\n=== repos.getCombinedStatusForRef', combined.state, combined.total_count);
  for (const s of combined.statuses) {
    console.log({ context: s.context, state: s.state, target_url: s.target_url, description: s.description, updated: s.updated_at });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

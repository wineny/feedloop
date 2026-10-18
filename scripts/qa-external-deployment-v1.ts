/** One explicit Preview upload of the merged external QA marker. No production DB. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Octokit } from '@octokit/rest';

const ROOT = resolve('evals/pipeline/20260913/external-v1');
const CHECKOUT = resolve('.omx/qa/external-preview-v1');
const PROJECT = 'prj_T1N3YA81Mj4xlrPROyZ5ZkShrHUT';
const TEAM = 'team_cMnBgBLU5MshQSFNK2BxOOpl';
const SCOPE = 'nuri-yoons-projects';
const OWNER = 'wineny', REPO = 'nullnul-tour';
const CLI = '/Users/wine_ny/.local/bin/vercel';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const load = (name: string) => JSON.parse(readFileSync(resolve(ROOT, name + '.json'), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(resolve(ROOT, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush: true });
const sourceHash = () => hash(readFileSync(resolve('scripts/qa-external-deployment-v1.ts')));
const excluded = (path: string) => path.split('/').some(p => /^(?:\.env(?:\..*)?|\.git|\.vercel|\.next|node_modules|\.npmrc|\.yarnrc.*|credentials.*|id_rsa.*|id_ed25519.*)$/i.test(p)) || /\.(?:pem|key|p12|pfx)$/i.test(path);
function safePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.') || /[\x00-\x1f]/.test(path)) throw new Error('unsafe_source_path');
}
function cleanEnv() {
  // CLI alone reads its existing local login. Never inherit operational environment variables.
  return { NODE_ENV: 'production' as const, ...Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : [])) };
}
function cli(args: string[], cwd = CHECKOUT) {
  const result = spawnSync(CLI, [...args, '--scope', SCOPE], { cwd, env: cleanEnv(), encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  // Never dump stderr, request headers, credential files, or arbitrary remote error bodies.
  if (result.error || result.status !== 0) throw new Error('vercel_cli_failed_' + (result.status ?? 'timeout'));
  return JSON.parse(result.stdout);
}
function api(path: string) { return cli(['api', path + '?teamId=' + TEAM, '--method', 'GET'], process.cwd()); }
function preflight() {
  const p = api('/v9/projects/' + PROJECT);
  if (p.id !== PROJECT || p.accountId !== TEAM || p.link || p.rootDirectory || p.framework !== 'nextjs' || p.buildCommand || p.installCommand || p.ssoProtection?.deploymentType !== 'all_except_custom_domains') throw new Error('project_preflight_changed');
  const response = api('/v10/projects/' + PROJECT + '/env');
  if (!Array.isArray(response.envs) || response.envs.some((e: { target?: string[] | string; customEnvironmentIds?: string[] }) => !Array.isArray(e.target) || e.target.some(t => t !== 'production') || e.customEnvironmentIds?.length)) throw new Error('preview_environment_not_empty');
  return { projectId: PROJECT, teamId: TEAM, target: 'preview', rootDirectory: null, previewEnvironmentCount: 0, protection: p.ssoProtection.deploymentType, checkedAt: new Date().toISOString() };
}
function github() {
  const raw = readFileSync(resolve('../app/.env.local'), 'utf8');
  const matches = raw.split(/\r?\n/).filter(l => /^(?:export\s+)?GITHUB_TOKEN=/.test(l.trim()));
  if (matches.length !== 1) throw new Error('github_credential_missing_or_ambiguous');
  let token = matches[0].trim().replace(/^(?:export\s+)?GITHUB_TOKEN=/, '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
  if (!token || /[\s`$\\]/.test(token)) throw new Error('github_credential_format_unsupported');
  return new Octokit({ auth: token, request: { timeout: 30000 }, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
}
function context() {
  const m = load('manifest');
  const manifestHash = hash(readFileSync(resolve(ROOT, 'manifest.json')));
  if (m.repository !== OWNER + '/' + REPO || !/^20260913-[a-f0-9]{8}$/.test(m.id) || m.baseBranch !== `feedloop/pipeline-qa-${m.id}/base` || m.headBranch !== `feedloop/pipeline-qa-${m.id}/head` || m.markerPath !== `app/public/feedloop-pipeline-qa-${m.id}.json`) throw new Error('external_manifest_scope_mismatch');
  const receipt = (name: string) => { const r = load(name); if (r.manifestHash !== manifestHash || r.state !== 'completed') throw new Error('external_receipt_mismatch'); return r.result; };
  const pr = receipt('create-pr'), merged = receipt('merge');
  const mergeSha = merged.merge?.sha;
  if (!/^[a-f0-9]{40}$/.test(mergeSha) || pr.baseBranch !== m.baseBranch || pr.headBranch !== m.headBranch || pr.markerPath !== m.markerPath || !Number.isSafeInteger(pr.number)) throw new Error('merge_receipt_mismatch');
  return { m, manifestHash, pr, mergeSha: mergeSha as string };
}
async function verifyMerge(g: Octokit, c: ReturnType<typeof context>) {
  const p = (await g.pulls.get({ owner: OWNER, repo: REPO, pull_number: c.pr.number })).data;
  const ref = (await g.git.getRef({ owner: OWNER, repo: REPO, ref: 'heads/' + c.m.baseBranch })).data;
  if (!p.merged || p.merge_commit_sha !== c.mergeSha || p.base.ref !== c.m.baseBranch || p.head.ref !== c.m.headBranch || p.head.repo?.full_name !== OWNER + '/' + REPO || p.head.sha !== c.pr.headSha || ref.object.sha !== c.mergeSha) throw new Error('actual_qa_merge_mismatch');
  const main = (await g.git.getRef({ owner: OWNER, repo: REPO, ref: 'heads/main' })).data;
  if (main.object.sha !== c.m.defaultSha) throw new Error('default_branch_changed');
}
type FileProof = { path: string; gitBlobSha: string; sha256: string; bytes: number };
function checkoutProof() {
  const proof: Array<{ path: string; sha256: string; bytes: number }> = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const file = resolve(dir, name), path = relative(CHECKOUT, file);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('checkout_symlink_forbidden');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        if (excluded(path)) throw new Error('unexpected_checkout_secret_or_generated_file');
        const data = readFileSync(file); proof.push({ path, sha256: hash(data), bytes: data.length });
      } else throw new Error('unsupported_checkout_entry');
    }
  }
  walk(CHECKOUT); return proof.sort((a,b) => a.path.localeCompare(b.path));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run', '--prepare', '--deploy', '--inspect'].includes(args[0])) throw new Error('provide_one_explicit_phase');
  const phase = args[0].slice(2);
  if (phase === 'dry-run') {
    console.log(JSON.stringify({ phase, sourceHash: sourceHash(), projectId: PROJECT, teamId: TEAM, repository: OWNER + '/' + REPO, target: 'preview', caps: { deployments: 1, modelCalls: 0 }, credentialsLoaded: false, externalCalls: 0, prerequisites: ['manifest.json', 'create-pr.json', 'merge.json'], phases: ['prepare: remote GET + local exact SHA files + Vercel dry upload inventory', 'deploy: one durable reserved Preview upload', 'inspect: read actual status and static marker only'] }, null, 2)); return;
  }
  if (process.env.NODE_OPTIONS || Object.keys(process.env).some(k => /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FEEDLOOP_QA_)/i.test(k) && process.env[k])) throw new Error('custom_transport_forbidden');
  const c = context(), scriptHash = sourceHash();
  mkdirSync(ROOT, { recursive: true });
  const lock = resolve(ROOT, 'deployment.lock'); const fd = openSync(lock, 'wx');
  try {
    if (phase === 'prepare') {
      if (existsSync(resolve(ROOT, 'deployment-prepare.json')) || existsSync(CHECKOUT)) throw new Error('checkout_or_preparation_exists_inspect_before_recovery');
      const g = github(); await verifyMerge(g, c); const project = preflight();
      const tree = (await g.git.getTree({ owner: OWNER, repo: REPO, tree_sha: c.mergeSha, recursive: '1' })).data;
      if (tree.truncated) throw new Error('source_tree_truncated');
      const selected = tree.tree.filter(e => e.path?.startsWith('app/') && e.type !== 'tree');
      if (!selected.length || selected.length > 2000) throw new Error('source_file_limit');
      for (const entry of selected) { safePath(entry.path!); if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode!)) throw new Error('unsupported_source_entry'); }
      const omitted = selected.filter(e => excluded(e.path!.slice(4))).map(e => e.path!);
      const included = selected.filter(e => !excluded(e.path!.slice(4)));
      if (included.reduce((n,e) => n + (e.size ?? 0), 0) > 100 * 1024 * 1024) throw new Error('source_size_limit');
      mkdirSync(CHECKOUT, { recursive: true, mode: 0o700 });
      const files: FileProof[] = [];
      for (const entry of included) {
        const blob = (await g.git.getBlob({ owner: OWNER, repo: REPO, file_sha: entry.sha! })).data;
        if (blob.encoding !== 'base64') throw new Error('unexpected_blob_encoding');
        const bytes = Buffer.from(blob.content, 'base64');
        const gitHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (gitHash !== entry.sha || bytes.length > 20 * 1024 * 1024) throw new Error('git_blob_integrity_or_size');
        const path = entry.path!.slice(4); mkdirSync(dirname(resolve(CHECKOUT, path)), { recursive: true });
        writeFileSync(resolve(CHECKOUT, path), bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 });
        files.push({ path, gitBlobSha: entry.sha!, sha256: hash(bytes), bytes: bytes.length });
      }
      const markerPath = c.m.markerPath.slice(4), marker = JSON.parse(readFileSync(resolve(CHECKOUT, markerPath), 'utf8'));
      if (marker.id !== c.m.id || marker.sourceDefaultSha !== c.m.defaultSha) throw new Error('marker_identity_mismatch');
      const configFile = resolve(CHECKOUT, 'vercel.json');
      if (existsSync(configFile)) { const config = JSON.parse(readFileSync(configFile, 'utf8')); if (config.env || config.build?.env || config.buildCommand || config.installCommand || config.builds) throw new Error('source_config_environment_or_build_override'); }
      const before = checkoutProof();
      const dry = cli(['deploy', '--dry', '--json', '--project', PROJECT, '--target', 'preview', '--yes']);
      if (JSON.stringify(before) !== JSON.stringify(checkoutProof()) || !Array.isArray(dry.files) || !dry.files.some((f: { path: string }) => f.path === markerPath)) throw new Error('dry_upload_inventory_mismatch');
      for (const f of dry.files) if (!before.some(b => b.path === f.path && b.bytes === f.size)) throw new Error('unexpected_upload_file');
      save('deployment-prepare', { state: 'completed', manifestHash: c.manifestHash, scriptHash, mergeSha: c.mergeSha, project, sourcePrefix: 'app/', checkout: CHECKOUT, files: files.sort((a,b) => a.path.localeCompare(b.path)), omitted, checkoutHash: hash(JSON.stringify(before)), uploadInventory: dry, markerPath, markerHash: hash(readFileSync(resolve(CHECKOUT, markerPath))), at: new Date().toISOString() });
      console.log('Prepared exact-SHA source and dry upload inventory; no deployment created.'); return;
    }
    const prepared = load('deployment-prepare');
    if (prepared.state !== 'completed' || prepared.manifestHash !== c.manifestHash || prepared.scriptHash !== scriptHash || prepared.mergeSha !== c.mergeSha || prepared.project.projectId !== PROJECT || prepared.project.target !== 'preview') throw new Error('deployment_preparation_mismatch');
    if (phase === 'deploy') {
      if (existsSync(resolve(ROOT, 'deployment-intent.json')) || existsSync(resolve(ROOT, 'deployment-submit.json'))) throw new Error('deployment_already_reserved_no_blind_retry');
      await verifyMerge(github(), c); preflight();
      if (hash(JSON.stringify(checkoutProof())) !== prepared.checkoutHash) throw new Error('checkout_changed');
      save('deployment-intent', { state: 'reserved', manifestHash: c.manifestHash, scriptHash, mergeSha: c.mergeSha, checkoutHash: prepared.checkoutHash, projectId: PROJECT, target: 'preview', maxDeployments: 1, at: new Date().toISOString() });
      const response = cli(['deploy', '--target', 'preview', '--project', PROJECT, '--yes', '--json', '--no-wait', '--meta', 'feedloopQaId=' + c.m.id, '--meta', 'feedloopQaMergeSha=' + c.mergeSha]);
      const d = response.deployment ?? response;
      if (!/^dpl_[A-Za-z0-9]+$/.test(d.id) || typeof d.url !== 'string' || !/^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(d.url) || (d.target !== null && d.target !== 'preview')) throw new Error('deployment_submit_identity_unknown_inspect_without_retry');
      save('deployment-submit', { state: 'submitted', manifestHash: c.manifestHash, mergeSha: c.mergeSha, checkoutHash: prepared.checkoutHash, projectId: PROJECT, target: 'preview', deploymentId: d.id, url: new URL(d.url).hostname, at: new Date().toISOString() });
      console.log('Preview submitted once. Run --inspect for actual status.'); return;
    }
    const submitted = load('deployment-submit');
    if (submitted.manifestHash !== c.manifestHash || submitted.mergeSha !== c.mergeSha || submitted.projectId !== PROJECT || submitted.target !== 'preview' || !/^dpl_[A-Za-z0-9]+$/.test(submitted.deploymentId)) throw new Error('submitted_identity_mismatch');
    const d = api('/v13/deployments/' + submitted.deploymentId);
    if (d.id !== submitted.deploymentId || d.projectId !== PROJECT || d.team?.id !== TEAM || (d.target !== null && d.target !== 'preview') || d.meta?.feedloopQaId !== c.m.id || d.meta?.feedloopQaMergeSha !== c.mergeSha || d.url !== submitted.url) throw new Error('remote_deployment_identity_mismatch');
    let markerStatus = 'pending', httpStatus: number | null = null;
    if (d.readyState === 'READY') {
      if (!/^[a-zA-Z0-9-]+\.vercel\.app$/.test(d.url)) throw new Error('unexpected_deployment_hostname');
      const response = await fetch('https://' + d.url + '/' + prepared.markerPath.replace(/^public\//, ''), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      httpStatus = response.status;
      if (response.status === 200) markerStatus = hash(Buffer.from(await response.arrayBuffer())) === prepared.markerHash ? 'verified' : 'mismatch';
      else if ([301,302,303,307,308,401,403].includes(response.status)) markerStatus = 'protected_access_unverified';
      else markerStatus = 'unverified_http_status';
    }
    const observation = { manifestHash: c.manifestHash, mergeSha: c.mergeSha, checkoutHash: prepared.checkoutHash, deploymentId: d.id, projectId: PROJECT, target: 'preview', readyState: d.readyState, url: d.url, markerStatus, httpStatus, userResolution: 'unconfirmed', at: new Date().toISOString() };
    save('deployment-observation-' + Date.now(), observation);
    console.log(JSON.stringify(observation, null, 2));
  } finally { closeSync(fd); unlinkSync(lock); }
}
main().catch(error => { console.error(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'external_deployment_phase_failed_details_withheld'); process.exitCode = 1; });

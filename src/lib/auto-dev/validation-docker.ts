import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialEvidence, validateRequest, type ValidationRunner, type CheckReceipt, type SnapshotFile } from './validation';

const OUTPUT_LIMIT = 32_768;

/** Only the Docker control plane executes on the host; candidate code never does. */
function docker(args: string[], timeout: number): Promise<{
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}> {
  return new Promise(resolve => {
    const start = Date.now();
    let output = '';
    let timedOut = false;
    const child = spawn('docker', args, {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, timeout));
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
        output = output.slice(0, OUTPUT_LIMIT);
        timedOut = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', e => { output = e.message; });
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut, durationMs: Date.now() - start });
    });
  });
}

async function materialize(root: string, files: SnapshotFile[]) {
  await mkdir(root, { recursive: true });
  await chmod(root, 0o755);
  for (const f of files) {
    const target = join(root, f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, { mode: 0o444 });
  }
}

export const runDockerValidation: ValidationRunner = async r => {
  const evidence = initialEvidence(r);
  const invalid = validateRequest(r);
  if (invalid) return { ...evidence, reason: invalid };
  if (r.deadline <= Date.now()) return { ...evidence, reason: 'deadline_exceeded' };

  const inspect = await docker(
    ['image', 'inspect', r.profile.image, '--format', '{{.Id}}'],
    Math.min(10_000, r.deadline - Date.now()),
  );
  if (inspect.exitCode !== 0) return { ...evidence, reason: 'runner_image_unavailable' };

  const root = await mkdtemp(join(tmpdir(), 'feedloop-validate-'));
  await chmod(root, 0o755);
  const base = join(root, 'base'), patch = join(root, 'patch'), checks = join(root, 'checks');
  try {
    await materialize(base, r.snapshot.files);
    const merged = new Map(r.snapshot.files.map(f => [f.path, f]));
    for (const f of r.patches) merged.set(f.path, f);
    await materialize(patch, [...merged.values()]);
    await materialize(checks, r.profile.files);

    for (const stage of ['base', 'patch'] as const) {
      for (const check of (stage === 'base' ? r.profile.checks.filter(c => c.id === 'reproduction') : r.profile.checks)) {
        if (Date.now() >= r.deadline) return { ...evidence, reason: 'deadline_exceeded' };
        const name = `feedloop-${r.runId.slice(0, 35)}-${randomUUID()}`;
        // Fresh tmpfs per check prevents one check from falsifying another's files/results.
        const bootstrap = 'const fs=require("fs");fs.cpSync("/snapshot","/work",{recursive:true});const p=require("child_process").spawn(process.argv[1],process.argv.slice(2),{cwd:"/work",stdio:"inherit",env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp",NODE_ENV:"test"}});p.on("exit",c=>process.exit(c??1));p.on("error",()=>process.exit(127));';
        let result;
        let cleanup;
        try {
          result = await docker([
            'run',
            '--name', name,
            '--label', 'feedloop.validation=owned',
            '--network', 'none',
            '--user', '65534:65534',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--pids-limit', '64',
            '--memory', '256m',
            '--cpus', '1',
            '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
            '--tmpfs', '/work:rw,nosuid,size=64m,mode=1777',
            '--mount', `type=bind,src=${stage === 'base' ? base : patch},dst=/snapshot,readonly`,
            '--mount', `type=bind,src=${checks},dst=/checks,readonly`,
            '--workdir', '/work',
            '--env', 'NODE_ENV=test',
            r.profile.image, 'node', '-e', bootstrap, ...check.argv,
          ], Math.min(r.profile.timeoutMs ?? 180_000, r.deadline - Date.now()));
        } finally {
          cleanup = { containerName: name, ...await docker(['rm', '-f', name], 10_000) };
        }

        let outcome: NonNullable<CheckReceipt['outcome']> = {
          status: 'validated', reason: 'check_passed',
        };
        if (result.timedOut) {
          outcome = { status: 'unverifiable', reason: 'check_timeout' };
        } else if (stage === 'base') {
          if (result.exitCode === 0) {
            outcome = { status: 'stopped', reason: 'reproduction_already_passes' };
          } else if (result.exitCode !== 1 || !result.output.includes(r.profile.intendedFailureMarker)) {
            outcome = { status: 'unverifiable', reason: 'intended_failure_not_reproduced' };
          }
        } else if (result.exitCode !== 0 || !result.output.includes(check.successMarker)) {
          outcome = { status: 'failed', reason: `${check.id}_failed` };
        }
        const receipt: CheckReceipt = { stage, id: check.id, ...result, outcome, cleanup };
        evidence.checks.push(receipt);
        if (cleanup.exitCode !== 0 || cleanup.timedOut) {
          return { ...evidence, status: 'unverifiable', reason: 'runner_cleanup_failed' };
        }
        if (outcome.status !== 'validated') return { ...evidence, ...outcome };
      }
    }
    return { ...evidence, status: 'validated', reason: 'all_checks_passed' };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

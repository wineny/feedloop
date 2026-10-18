import { createHash } from 'node:crypto';

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface ValidationSnapshot {
  repository: string;
  baseSha: string;
  files: SnapshotFile[];
}

export interface ValidationPatch extends SnapshotFile {
  action: 'modified' | 'created';
}

export interface TrustedCheck {
  id: 'reproduction' | 'typecheck' | 'build' | 'regression';
  argv: string[];
  successMarker: string;
}

export type ValidationTarget = {kind: 'group' | 'insight'; id: string};

export interface ValidationTargetBinding {
  target: ValidationTarget;
  evidenceDigest: string;
  reproductionCheckId: 'reproduction';
}

/** Operator-owned; never accept profiles or commands from model or visitor input. */
export interface TrustedValidationProfile {
  id: string;
  repository: string;
  /** Required by production selection; standalone runner fixtures may omit it. */
  targetBinding?: ValidationTargetBinding;
  image: string;
  files: SnapshotFile[];
  checks: TrustedCheck[];
  intendedFailureMarker: string;
  editablePaths: string[];
  timeoutMs?: number;
}

export interface CheckReceipt {
  stage: 'base' | 'patch';
  id: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
  outcome?: { status: ValidationEvidence['status']; reason: string };
  cleanup?: {
    containerName: string;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    durationMs: number;
  };
}

export interface ValidationEvidence {
  status: 'validated' | 'stopped' | 'unverifiable' | 'failed';
  reason: string;
  runId: string;
  repository: string;
  baseSha: string;
  snapshotDigest: string;
  patchDigest: string;
  profileDigest: string;
  targetBinding?: ValidationTargetBinding;
  image: string;
  checks: CheckReceipt[];
  attempt: number;
}

export interface ValidationRequest {
  runId: string;
  snapshot: ValidationSnapshot;
  patches: ValidationPatch[];
  profile: TrustedValidationProfile;
  deadline: number;
  attempt: number;
}

export type ValidationRunner = (request: ValidationRequest) => Promise<ValidationEvidence>;

export interface PublicationIntent {
  runId: string;
  branch: string;
  baseSha: string;
  patchDigest: string;
  profileDigest: string;
  targetBinding?: ValidationTargetBinding;
  repository: string;
  candidate: {
    analysis: string;
    files: ValidationPatch[];
    commit_message: string;
    pr_title: string;
    pr_body: string;
    review_notes?: string[];
  };
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function fileDigest(files: SnapshotFile[]): string {
  return digest([...files].sort((a, b) => a.path.localeCompare(b.path)));
}

export function safePath(path: string): boolean {
  return !!path &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.startsWith('/') &&
    path.split('/').every(p => p !== '.' && p !== '..' && p !== '') &&
    !/(^|\/)(\.git|\.env(?:\..*)?|node_modules)(\/|$)/.test(path);
}

export function validateRequest(r: ValidationRequest): string | null {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(r.runId) || !/^[a-f0-9]{40}$/.test(r.snapshot.baseSha)) {
    return 'invalid_identity';
  }
  if (r.profile.repository !== r.snapshot.repository) return 'repository_mismatch';
  if (!/^(?:[\w./:-]+@sha256:|sha256:)[a-f0-9]{64}$/.test(r.profile.image)) {
    return 'immutable_image_required';
  }

  const all = [...r.snapshot.files, ...r.profile.files];
  if (
    all.some(f => !safePath(f.path) || Buffer.byteLength(f.content) > 1_000_000) ||
    all.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 20_000_000
  ) {
    return 'unsafe_snapshot';
  }
  if (
    new Set(r.snapshot.files.map(f => f.path)).size !== r.snapshot.files.length ||
    new Set(r.profile.files.map(f => f.path)).size !== r.profile.files.length
  ) {
    return 'duplicate_path';
  }
  if (
    r.profile.checks.length !== 4 ||
    !['reproduction', 'typecheck', 'build', 'regression'].every(id =>
      r.profile.checks.some(c =>
        c.id === id && c.argv.length > 0 && !!c.successMarker && c.argv.every(a => typeof a === 'string'),
      ),
    ) ||
    !r.profile.intendedFailureMarker
  ) {
    return 'incomplete_profile';
  }

  const forbidden = /(^|\/)([^/]*\.(test|spec)\.[^/]+|__tests__|tests?|scripts?|package(?:-lock)?\.json|[^/]*lock[^/]*|[^/]*config[^/]*|Dockerfile)(\/|$)/i;
  if (
    new Set(r.patches.map(f => f.path)).size !== r.patches.length ||
    r.patches.some(f =>
      !safePath(f.path) ||
      forbidden.test(f.path) ||
      !r.profile.editablePaths.includes(f.path) ||
      Buffer.byteLength(f.content) > 1_000_000,
    )
  ) {
    return 'validation_tampering';
  }
  return null;
}

export function initialEvidence(r: ValidationRequest): ValidationEvidence {
  return {
    status: 'unverifiable',
    reason: 'not_executed',
    runId: r.runId,
    repository: r.snapshot.repository,
    baseSha: r.snapshot.baseSha,
    snapshotDigest: fileDigest(r.snapshot.files),
    patchDigest: fileDigest(r.patches.map(({ path, content }) => ({ path, content }))),
    profileDigest: digest(r.profile),
    ...(r.profile.targetBinding ? {targetBinding:r.profile.targetBinding} : {}),
    image: r.profile.image,
    checks: [],
    attempt: r.attempt,
  };
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, type ValidationTarget, type TrustedValidationProfile, type ValidationRunner } from './validation';
import { runDockerValidation } from './validation-docker';

/**
 * 이 대상에 검증 프로필이 있는가에 대한 답. 세 갈래인 이유가 정책 그 자체다.
 *
 * - `profile`  이 제보를 겨냥해 사람이 쓴 프로필이 있다 → 격리 검증 필수. 통과해야만 PR
 * - `none`     이 제보를 겨냥한 프로필이 없다 → 검증 없이 진행하고 `unverifiable` 로 기록
 * - `blocked`  이 제보를 겨냥한 프로필이 «있는데» 적용할 수 없다(중복·증거 드리프트·불완전)
 *              → 종전대로 중단. 사람이 프로필을 쓴 대상에서 검증이 조용히 사라지면 안 된다
 *
 * 프로필은 「환경 한 번 세팅」이 아니라 제보 하나마다 손으로 쓰는 것이고, 그걸 생성하는
 * 코드는 없다. `none` 을 중단으로 두면 자동 PR 이 영영 꺼진 채로 남는다.
 */
export type ValidationResolution =
  | { kind: 'profile'; profile: TrustedValidationProfile; runner: ValidationRunner }
  | { kind: 'none'; profilesForRepository: number }
  | { kind: 'blocked'; reason: string };

/** Trusted operator deployment configuration only. Never call with visitor/model paths. */
export async function loadTrustedValidationConfig(
  repository: string,
  target: ValidationTarget,
  evidenceDigest: string,
): Promise<ValidationResolution> {
  // 대상이 깨져 있으면 어떤 프로필과도 짝지어선 안 된다. 실제로는 도달하지 않는다
  // (`resolveRunValidationInput` 이 항상 온전한 식별자를 만들거나 던진다) — fail-closed 로 둔다.
  if (!target.id || !['group', 'insight'].includes(target.kind) || !/^[a-f0-9]{64}$/.test(evidenceDigest)) {
    return { kind: 'blocked', reason: 'invalid_validation_target' };
  }

  const path = process.env.FEEDLOOP_VALIDATION_PROFILES;
  if (!path) return { kind: 'none', profilesForRepository: 0 };
  if (!path.startsWith('/')) throw new Error('validation_profiles_absolute_path_required');

  const raw = JSON.parse(await readFile(resolve(path), 'utf8')) as { profiles: TrustedValidationProfile[] };
  if (!Array.isArray(raw.profiles)) throw new Error('invalid_validation_profiles');

  // 대상으로 «먼저» 고른다. repository 로 먼저 거르면, 이 제보를 정확히 겨냥한 프로필이라도
  // 레포 문자열이 달라졌을 때(봇의 github_repo_url 변경·대소문자·.git 접미사) 조용히
  // 탈락해 검증 없이 발행된다 — 사람이 검증을 요구해 둔 대상에서 검증이 사라지는 경로다.
  const matches = raw.profiles.filter(p => {
    const binding = p.targetBinding;
    return binding?.target?.kind === target.kind && binding.target.id === target.id;
  });
  if (matches.length > 1) return { kind: 'blocked', reason: 'validation_profile_ambiguous' };
  if (matches.length === 0) {
    // 대상에 묶이지 않은 프로필(targetBinding 누락)은 어느 제보를 겨냥하는지 말하지 못한다.
    // 운영자 오타 하나가 「검증 필수」를 「검증 없음」으로 뒤집지 않도록 fail-closed 로 막는다.
    // 범위를 이 레포로 좁힌다. 전역이면 남의 레포용 항목 하나의 오타가
    // 무관한 모든 봇의 자동 PR 을 정지시킨다 — 이 회차가 없애려던 상태가 딴 데서 재현된다.
    if (raw.profiles.some(p => p.repository === repository && !p.targetBinding)) {
      return { kind: 'blocked', reason: 'validation_profile_unbound' };
    }
    return { kind: 'none', profilesForRepository: raw.profiles.filter(p => p.repository === repository).length };
  }

  const profile = matches[0];
  if (profile.repository !== repository) {
    return { kind: 'blocked', reason: 'validation_profile_repository_mismatch' };
  }
  const binding = profile.targetBinding!;
  // 이 대상을 겨냥한 프로필이 있는데 증거가 그새 바뀌었거나 재현 검사가 없다 → 중단.
  if (binding.evidenceDigest !== evidenceDigest || binding.reproductionCheckId !== 'reproduction' ||
    !Array.isArray(profile.checks) || profile.checks.filter(c => c.id === binding.reproductionCheckId).length !== 1) {
    return { kind: 'blocked', reason: 'validation_profile_binding_mismatch' };
  }

  // The optional pin makes unintended deployment profile edits observable and fail closed.
  if (
    process.env.FEEDLOOP_VALIDATION_PROFILE_DIGEST &&
    digest(profile) !== process.env.FEEDLOOP_VALIDATION_PROFILE_DIGEST
  ) {
    throw new Error('validation_profile_digest_mismatch');
  }
  return { kind: 'profile', profile, runner: runDockerValidation };
}

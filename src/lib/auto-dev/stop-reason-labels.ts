// 자동 PR 실행이 멈춘 이유(`auto_dev_runs.stop_reason`)의 화면 라벨.
//
// 엔진은 `root_cause_unknown`·`insufficient_evidence` 같은 영문 코드를 남긴다 — 코드는 `scripts/lib/fix-live-eval-v1.ts`
// 가 채점 기준으로 읽으니 **바꾸지 말고** 화면에서만 사람 말로 푼다. 예전엔 `RunDetail` 이 코드를 그대로 그려
// 「중단 이유: root_cause_unknown」 이 담당자 화면에 떴다(I-24, 2026-09-16).
// 문구는 사전 `messages/<locale>/monitor.json` 의 `stopReason.<코드>` 에 있다(코드마다 있는지 `__tests__/stop-reason-labels.test.ts` 가 본다).

import type { DynamicTranslate } from '@/i18n/dynamic';

export const STOP_REASON_CODES = [
  // 엔진이 «정직하게» 멈춘 경우 — 사람이 봐야 하는 이유
  'root_cause_unknown',
  'insufficient_evidence',
  'no_change',
  'reproduction_already_passes',
  // 예산·시간
  'budget_exhausted',
  'deadline_exceeded',
  'budget_unverifiable',
  // 묶음·실행 순서
  'group_follow_up_hold',
  'target_group_changed',
  'execution_lease_lost',
  'publication_race_retry_required',
  // 발행·검증 정합성
  'validated_evidence_present',
  'publication_reconciliation_binding_mismatch',
  'validation_binding_mismatch',
  'validation_profile_digest_mismatch',
  'invalid_validation_profiles',
  'validation_profiles_absolute_path_required',
  'repository_mismatch',
  'foreign_publication_branch',
  'foreign_publication_pr',
  // 격리 검증 스냅숏
  'snapshot_too_large',
  'snapshot_file_too_large',
  'snapshot_tree_truncated',
  'snapshot_unsupported',
  'unsafe_snapshot_path',
  'unsafe_snapshot_symlink_or_submodule',
  // 내부 배선
  'durable_publication_callbacks_required',
  'durable_attempt_callbacks_required',
] as const;

/** 화면용. `t` 는 `dynamicT(useTranslations('monitor'))`. 사전에 없는 코드는 그대로 보여 준다 — 숨기면 디버깅 단서가 사라진다. */
export function stopReasonLabel(t: DynamicTranslate, reason: string | null | undefined): string {
  if (!reason) return '';
  const key = `stopReason.${reason}`;
  return t.has(key) ? t(key) : reason;
}

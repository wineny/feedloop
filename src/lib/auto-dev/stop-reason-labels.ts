// 자동 PR 실행이 멈춘 이유(`auto_dev_runs.stop_reason`)의 한국어 라벨.
//
// 엔진은 `root_cause_unknown`·`insufficient_evidence` 같은 영문 코드를 남긴다 — 코드는 `scripts/lib/fix-live-eval-v1.ts`
// 가 채점 기준으로 읽으니 **바꾸지 말고** 화면에서만 사람 말로 푼다. 예전엔 `RunDetail` 이 코드를 그대로 그려
// 「중단 이유: root_cause_unknown」 이 담당자 화면에 떴다(I-24, 2026-09-16).

export const STOP_REASON_LABEL: Record<string, string> = {
  // 엔진이 «정직하게» 멈춘 경우 — 사람이 봐야 하는 이유
  root_cause_unknown: 'AI 가 원인 파일을 찾지 못함 — 지목한 파일을 한 번 더 열어 봤지만 고칠 지점을 못 정했어요',
  insufficient_evidence: '근거 부족 — 제보와 맞는 코드를 저장소에서 찾지 못했어요',
  no_change: 'AI 가 고칠 것이 없다고 판단',
  reproduction_already_passes: '수정 전에도 재현 검사가 통과해 고칠 것이 없어요',
  // 예산·시간
  budget_exhausted: '시간·비용 예산 소진 — 재시도하면 다른 후보를 고를 수 있어요',
  deadline_exceeded: '제한 시간 초과',
  budget_unverifiable: '비용을 계산할 수 없는 모델 설정 — 관리자 확인 필요',
  // 묶음·실행 순서
  group_follow_up_hold: '같은 묶음의 이전 PR 후속 확인이 끝날 때까지 보류',
  target_group_changed: '대상 묶음이 실행 중에 바뀜',
  execution_lease_lost: '다른 실행이 같은 작업을 이어받아 이쪽은 멈춤',
  publication_race_retry_required: 'PR 발행이 겹쳐 재시도 필요',
  // 발행·검증 정합성
  validated_evidence_present: '검증 통과 기록이 있는 실행을 검증 없이 재개하지 않음',
  publication_reconciliation_binding_mismatch: '발행 기록과 수정안이 맞지 않아 중단',
  validation_binding_mismatch: '검증 기록과 수정안이 맞지 않아 중단',
  validation_profile_digest_mismatch: '검증 설정이 실행 중에 바뀜',
  invalid_validation_profiles: '검증 설정 형식 오류',
  validation_profiles_absolute_path_required: '검증 설정 경로는 절대 경로여야 함',
  repository_mismatch: '저장소가 실행 중에 바뀜',
  foreign_publication_branch: '같은 이름의 브랜치가 이미 있어 덮어쓰지 않음',
  foreign_publication_pr: '같은 브랜치의 PR 이 이미 있어 새로 열지 않음',
  // 격리 검증 스냅숏
  snapshot_too_large: '저장소가 커서 격리 검증을 못 함',
  snapshot_file_too_large: '1MB 넘는 파일이 있어 격리 검증을 못 함',
  snapshot_tree_truncated: '저장소 트리가 잘려 격리 검증을 못 함',
  snapshot_unsupported: '격리 검증이 지원하지 않는 파일 형식',
  unsafe_snapshot_path: '안전하지 않은 경로가 있어 격리 검증을 못 함',
  unsafe_snapshot_symlink_or_submodule: '심볼릭 링크·서브모듈이 있어 격리 검증을 못 함',
  // 내부 배선
  durable_publication_callbacks_required: '내부 오류 — 발행 기록 콜백 없음',
  durable_attempt_callbacks_required: '내부 오류 — 시도 기록 콜백 없음',
};

/** 화면용. 사전에 없는 코드는 그대로 보여 준다 — 숨기면 디버깅 단서가 사라진다. */
export function stopReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return STOP_REASON_LABEL[reason] ?? reason;
}

/** Shared display text. Type-only references keep server execution code out of client bundles. */
import type { mergeBlockedBy } from './pr-review';
import type { UnverifiedVerdict } from './explanation';

export const MERGE_BLOCK_MESSAGE: Record<NonNullable<ReturnType<typeof mergeBlockedBy>>, string> = {
  merged: '이미 반영된 수정안이에요',
  closed: 'GitHub 에서 이미 닫힌 수정안이에요',
  build_failed: '빌드가 실패해 반영을 막아뒀어요. 이 상태로 반영하면 서비스가 열리지 않을 수 있어요',
  build_pending: '빌드가 아직 진행 중이에요. 끝나면 반영할 수 있어요',
  conflict: '원본 코드가 그사이 바뀌어 이 수정안과 충돌해요. GitHub 에서 충돌을 풀어야 반영할 수 있어요',
};

export const VERDICT_LABEL: Record<UnverifiedVerdict['status'], string> = {
  fix_holds: 'AI 의견 · 수정 근거가 타당해 보여요',
  fix_does_not_hold: 'AI 의견 · 수정 근거에 문제가 있어요',
  inconclusive: 'AI 의견 · 판단할 수 없어요',
};

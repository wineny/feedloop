// 배치 분류 스캔에서 「의견 남기기」 칩 문장을 빼는 필터 리터럴.
//
// 왜 떼어 뒀나 — PostgREST 의 `not.in` 은 `.in()` 과 달리 배열이 아니라 **이미 포맷된
// 리터럴 문자열**(`("a","b")`)을 받는다. 손으로 조립하는 문자열이 쿼리로 나가는 자리라
// 전제가 깨지면 조용히 틀린다: 라벨에 `"` 나 `,` 가 들어가면 항목이 갈라지거나 따옴표가
// 닫혀 필터가 엉뚱한 값을 가리킨다. 테스트로 그 전제를 고정하려고 함수로 뽑았다.

import { CHIP_ONLY_LABELS } from '@/lib/widget/chips';

/** 리터럴 조립이 성립하는 라벨인가. `"` 와 `,` 가 없어야 한다. */
export function isSafeChipLabel(label: string): boolean {
  return !label.includes('"') && !label.includes(',');
}

/**
 * `not.in` 에 실을 리터럴. 전제를 못 지키는 라벨은 **버리지 않고 던진다** —
 * 조용히 빠지면 그 칩 문장이 다시 분류 대상이 되어 내용 없는 인사이트가 생긴다.
 */
export function buildChipOnlyFilter(labels: readonly string[] = CHIP_ONLY_LABELS): string {
  for (const label of labels) {
    if (!isSafeChipLabel(label)) {
      throw new Error(`칩 라벨에 따옴표·쉼표가 있어 필터를 만들 수 없습니다: ${label}`);
    }
  }
  return `(${labels.map((l) => `"${l}"`).join(',')})`;
}

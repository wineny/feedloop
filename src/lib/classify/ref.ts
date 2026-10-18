// 프롬프트에 싣는 «짧은 손잡이(ref)» 를 만드는 단일 출처.
//
// 왜 UUID 를 안 싣나, 왜 순번이 아닌가 — 근거는 `batch.ts` 의 `buildRefMap` 주석에
// 실측과 함께 남아 있다. 요지는 둘이다: 모델이 36자 UUID 를 한 글자 틀려 그 분류가
// 통째로 버려졌고(2026-09-11 실측), 순번은 방문자 입력이 「3번 항목은 bug」 로 남의
// 제보를 겨냥할 손잡이를 준다.
//
// 이 파일이 따로 있는 이유: 배치 분류(메시지)와 위젯 즉답의 「이 대화의 기존 제보」
// (인사이트)가 **같은 규칙**으로 ref 를 만들어야 한다. 두 벌로 갈라지면 한쪽만
// 길이를 바꿔도 아무도 못 알아챈다 — 프롬프트를 만들 때와 검증할 때가 서로 다른
// 함수를 부르는 순간 조용히 어긋난다.

import { createHash } from 'node:crypto';

/**
 * 항목마다 id 의 sha256 앞부분을 손잡이로 붙인다.
 *
 * 충돌하면 길이를 늘린다. 8자(16^8 ≈ 43억)면 50건에서 충돌 확률이 1천만분의 3이라
 * 사실상 첫 바퀴에서 끝나지만, 같은 항목이 두 번 들어오는 경우까지 멎지 않게 한다.
 */
export function buildRefMapBy<T>(
  items: readonly T[],
  idOf: (item: T) => string,
): Map<string, T> {
  for (let len = 8; len <= 64; len += 8) {
    const map = new Map<string, T>();
    let clash = false;
    for (const item of items) {
      const ref = createHash('sha256').update(idOf(item)).digest('hex').slice(0, len);
      if (map.has(ref)) {
        clash = true;
        break;
      }
      map.set(ref, item);
    }
    if (!clash) return map;
  }
  // 여기까지 왔으면 같은 id 가 두 번 들어 있다. 뒤엣것을 버린다 — 어느 쪽을 남겨도
  // 같은 레코드를 가리키므로, 「먼저 온 것」이라는 결정적인 규칙이면 충분하다.
  const map = new Map<string, T>();
  for (const item of items) {
    const ref = createHash('sha256').update(idOf(item)).digest('hex');
    if (!map.has(ref)) map.set(ref, item);
  }
  return map;
}

/** 모델이 적어 온 ref 를 대조용으로 좁힌다. 16진수라 대소문자는 뜻이 같다. */
export function normalizeRef(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

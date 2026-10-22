// 키를 데이터·코드로 만드는 자리(`errors.${code}`, 서버가 준 사유 코드 등)용 번역 함수.
// 사전 타입(`src/types/next-intl.d.ts`)이 `t('없는.키')` 를 tsc 로 막지만, 이런 자리는 키를 문자열로 조립하므로
// 타입 검사를 끈 함수로 감싼다. 키가 사전에 있는지는 `t.has` 나 사전 테스트가 본다.
export type DynamicTranslate = {
  (key: string, values?: Record<string, string | number | Date>): string;
  has(key: string): boolean;
};

export function dynamicT(t: unknown): DynamicTranslate {
  return t as DynamicTranslate;
}

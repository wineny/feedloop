/**
 * 견본 데이터(mock-data.ts, 데모 봇)의 GitHub 주소는 `github.com/example/...` 라 실제로 열면 404 다.
 * 이런 주소는 링크로 만들지 않는다 — 심사위원·영상에서 눌러도 빈 페이지가 안 뜨게(2026-11-01 ny 결정).
 */
export function isSampleUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\/github\.com\/example\//i.test(url);
}

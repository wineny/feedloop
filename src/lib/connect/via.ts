// 연결 화면의 갈래 해석 — `?via=` 와 옛 `?tab=` 을 한 곳에서 읽는다.
//
// 페이지(서버 컴포넌트)에서 빼낸 이유는 테스트다. 페이지 파일은 next-auth·supabase 를
// 끌고 오므로 이 판정 하나를 확인하려고 그걸 전부 세울 이유가 없다.

export type Via = 'widget' | 'channel' | null;

/**
 * 어느 갈래를 펼칠지 정한다. 아는 값이 아니면 갈림길(null) — 오타 난 링크가 엉뚱한 안내를
 * 펼치는 것보다 「무엇을 쓰시나요」를 다시 묻는 편이 낫다.
 *
 * 옛 `?tab=` 링크도 받는다. `?tab=kakao` 는 갈 곳이 없어졌으므로(카카오는 화면에서 내렸다)
 * 갈림길로 떨어진다.
 */
export function resolveVia(via?: string | string[], tab?: string | string[]): Via {
  const v = Array.isArray(via) ? via[0] : via;
  if (v === 'widget' || v === 'channel') return v;

  const t = Array.isArray(tab) ? tab[0] : tab;
  if (t === 'web') return 'widget';
  if (t === 'channel') return 'channel';
  return null;
}

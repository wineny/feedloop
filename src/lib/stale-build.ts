/**
 * 「배포가 바뀌어 화면 조각을 못 찾는」 오류를 알아보고, 한 번만 새로고침해 스스로 푼다.
 *
 * 왜 필요한가 — Next 는 헤더의 링크가 가리키는 화면을 미리 당겨 둔다(prefetch). 그때 받은
 * 목록에는 「이 화면은 chunks/xxxx.js 로 그린다」는 «그 시점 배포의» 파일 이름이 박혀 있다.
 * 그 탭을 켜 둔 채로 새 배포가 올라가면 바뀐 파일은 이름(해시)이 달라지고, 옛 이름은 서버에서
 * 사라진다. 이제 링크를 누르면 브라우저가 옛 이름을 찾다가 404 를 받고 그리다 만 채 튕긴다 —
 * 2026-09-19 ny 가 `/bots` 에서 로고를 눌렀을 때 영문 기본 오류 화면이 뜬 이유가 이것이다.
 *
 * 고칠 방법은 하나뿐이다: 목록을 새로 받는 것, 즉 새로고침. 사용자가 누르게 하지 말고 우리가 한다.
 */

// 브라우저·번들러마다 말이 다르다. 문구로 가른다 — 오류 «종류»로는 구분이 안 되기 때문이다.
const STALE_PATTERNS = [
  /chunkloaderror/i,
  /loading chunk/i,
  /loading css chunk/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: unknown; message?: unknown };
  const text = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.message === 'string' ? e.message : ''}`;
  return STALE_PATTERNS.some((pattern) => pattern.test(text));
}

const RELOAD_KEY = 'feedloop:stale-reload';
/** 이 시간 안에 이미 자동 새로고침을 했으면 다시 하지 않는다 — 무한 새로고침이 최악이다. */
const RELOAD_WINDOW_MS = 30_000;

/** 낡은 조각 오류면 «한 번만» 새로고침한다. 새로고침을 시작했으면 true. */
export function reloadOnceForStaleBuild(error: unknown): boolean {
  if (typeof window === 'undefined' || !isStaleBuildError(error)) return false;

  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // 저장을 못 하는 브라우저(사생활 보호 모드 등)에서는 자동 새로고침도 하지 않는다.
    // 몇 번 했는지 셀 방법이 없으면 루프를 막을 방법도 없다.
    return false;
  }

  window.location.reload();
  return true;
}

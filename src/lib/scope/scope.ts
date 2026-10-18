// 봇 스코프(I-27) — 「어느 서비스의 것을 보고 있나」의 단일 출처. React 없이 순수 함수만.
//
// 서비스가 둘 이상이면 대시보드·대화·피드백·수정 PR 이 전 봇을 합쳐 보여줬다. API 는 이미
// `resolveOwnedBots(botId)` 로 `?botId=` 스코프를 받고 있었고(lib/auth/ownership.ts) 화면에
// 고르는 자리만 없었다. 선택은 브라우저(localStorage)에 남고 서버는 모른다 — 서버가 아는 건
// 요청마다 실린 botId 뿐이고, 소유 검사도 그 자리에서 한다.

export const SCOPE_STORAGE_KEY = 'feedloop:scope';

/** 셀렉터가 필요한 최소 봇 수. 하나뿐이면 고를 것이 없어 셀렉터가 소음이다. */
export const SCOPE_MIN_BOTS = 2;

export interface ScopeBot {
  id: string;
  service_name: string;
  widget_connected_at: string | null;
  channel_connected_at: string | null;
}

/**
 * 저장된 선택이 지금 봇 목록에 없으면(삭제됨·다른 계정으로 로그인) 「전체」(null)로 떨어진다.
 * 없는 봇 id 를 그대로 API 에 실으면 403 이 화면에 새어 나온다.
 */
export function resolveScope(stored: string | null | undefined, bots: ScopeBot[]): string | null {
  if (!stored) return null;
  return bots.some((b) => b.id === stored) ? stored : null;
}

/** GET 주소에 `?botId=` 를 붙인다. 전체(null)면 그대로. 기존 쿼리가 있으면 `&` 로 잇는다. */
export function scopedUrl(path: string, botId: string | null): string {
  if (!botId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}botId=${encodeURIComponent(botId)}`;
}

/** POST 본문에 `botId` 를 얹는다. 전체(null)면 원본 그대로 — 서버는 없으면 전 봇으로 스코핑한다. */
export function scopedBody<T extends object>(body: T, botId: string | null): T & { botId?: string } {
  return botId ? { ...body, botId } : body;
}

/** 브라우저 저장소 읽기 — 프라이빗 창·차단된 저장소에서는 조용히 null. */
export function readStoredScope(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(SCOPE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredScope(botId: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (botId) window.localStorage.setItem(SCOPE_STORAGE_KEY, botId);
    else window.localStorage.removeItem(SCOPE_STORAGE_KEY);
  } catch {
    // 저장 못 해도 이번 세션의 선택은 메모리에 살아 있다
  }
}

/**
 * 주소 자체가 한 서비스를 가리키는 화면인가 — `/bots/<id>/<하위화면>`(연결·답변 지식·위젯 모양).
 *
 * 이런 화면에서 헤더 셀렉터는 「보는 범위」가 아니라 「지금 설정 중인 서비스」다. 저장된 범위만
 * 보여주면 주소가 가리키는 봇과 어긋나고, 골라도 화면이 그대로라 「바꿔지지 않는다」가 된다.
 * 목록에 있는 봇 id 일 때만 인정한다 — `/bots/new` 는 걸리지 않는다.
 */
export function routeBotSegment(
  pathname: string,
  bots: ScopeBot[],
): { botId: string; sub: string } | null {
  const [, root, id, ...rest] = pathname.split('/');
  if (root !== 'bots' || !id || rest.length === 0) return null;
  if (!bots.some((b) => b.id === id)) return null;
  return { botId: id, sub: rest.join('/') };
}

/** 같은 하위 화면을 다른 서비스로. 쿼리(`?tab=github`)는 그대로 들고 간다. */
export function swapRouteBot(sub: string, nextId: string, search = ''): string {
  return `/bots/${nextId}/${sub}${search}`;
}

/**
 * 서비스를 바꿔 옮길 때 «들고 갈» 쿼리. 화면마다 다르다 — 서비스에 종속된 값은 두고 간다.
 *
 * 답변 지식의 `?tab=` 은 세 탭이 «모든» 봇에 있으므로 다른 서비스에서도 참말이다.
 * 반면 연결 화면의 `?via=`(와 그 옛 이름 `?tab=web|channel`)는 「이 서비스에서 지금 무슨 입구를
 * 설정 중인가」라 연결 «상태»에 딸린 값이다. 이미 붙은 서비스로 들고 가면 페이지가 현황판 대신
 * 설정 마법사를 열어 「이제 연결하세요」 제목이 「연결됐어요」 본문 위에 선다.
 */
export function carryQuery(sub: string, search: string): string {
  if (sub !== 'knowledge') return '';
  const tab = new URLSearchParams(search).get('tab');
  return tab ? `?tab=${encodeURIComponent(tab)}` : '';
}

'use client';

// 봇 스코프 컨텍스트(I-27) — 헤더 셀렉터가 고르고, 네 탭(대시보드·대화·피드백·수정 PR)이 읽는다.
//
// 봇 목록은 여기서 한 번만 읽는다(`/api/bots`). 예전엔 대시보드가 「봇이 0 이면 등록 화면으로」를
// 위해 따로 읽었는데, 그 값은 이제 `bots` 로 같이 나간다.
//
// 저장된 선택(localStorage)이 있으면 목록을 읽어 «아직 있는 봇인지» 확인한 뒤에야 `ready` 다 —
// 삭제된 봇 id 를 그대로 실으면 403 이 화면에 새어 나온다. 저장된 선택이 없으면 확인할 것이
// 없으므로 즉시 `ready` 라 대부분의 사용자는 이 왕복을 기다리지 않는다.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { useSession } from 'next-auth/react';
import { readStoredScope, resolveScope, writeStoredScope, type ScopeBot } from './scope';

interface BotScopeValue {
  /** 선택한 봇 id. null = 전체 서비스. */
  botId: string | null;
  /** 선택한 봇(전체면 null). */
  current: ScopeBot | null;
  bots: ScopeBot[];
  /** `/api/bots` 읽기가 끝났나(성공·실패 불문). */
  loaded: boolean;
  /**
   * 마지막 읽기가 성공했나. 「봇 0개 → 등록 화면」 판정은 이 값 뒤에만 한다 —
   * 순간 장애(500·쿠키 타이밍 401)로 빈 목록이 오면 봇이 멀쩡히 있는 계정을 등록 화면으로 보낸다.
   */
  listOk: boolean;
  /** 스코프를 믿고 요청해도 되나. 저장된 선택이 없으면 즉시 true, 있으면 목록 확인 뒤 true. */
  ready: boolean;
  setBotId: (id: string | null) => void;
  /** 봇을 만들거나 지운 뒤 목록을 다시 읽는다. 지운 봇이 선택돼 있었으면 전체로 돌아간다. */
  refresh: () => Promise<void>;
}

const BotScopeContext = createContext<BotScopeValue>({
  botId: null,
  current: null,
  bots: [],
  loaded: false,
  listOk: false,
  ready: true,
  setBotId: () => {},
  refresh: async () => {},
});

type ListState = { loaded: false; ok: false } | { loaded: true; ok: boolean };

const NOT_LOADED: ListState = { loaded: false, ok: false };
const LOADED_OK: ListState = { loaded: true, ok: true };
const LOADED_FAILED: ListState = { loaded: true, ok: false };

type FetchResult = { ok: true; bots: ScopeBot[] } | { ok: false };

/** `/api/bots` 한 번. 상태를 모른다 — 결과만 돌려주고 싣는 건 `applyResult` 다. 절대 throw 하지 않는다. */
async function fetchBots(): Promise<FetchResult> {
  try {
    const res = await fetch('/api/bots', { cache: 'no-store' });
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as { bots?: ScopeBot[] };
    return { ok: true, bots: json.bots ?? [] };
  } catch {
    return { ok: false };
  }
}

export function BotScopeProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const pathname = usePathname();
  const [fetchedBots, setFetchedBots] = useState<ScopeBot[]>([]);
  const [fetched, setFetched] = useState<ListState>(NOT_LOADED);
  // 서버 렌더에서는 null, 브라우저에서는 저장값. 이 값으로 그리는 마크업은 목록을 읽은 뒤에만
  // 나오므로(셀렉터) 하이드레이션이 어긋나지 않는다.
  const [stored, setStored] = useState<string | null>(() => readStoredScope());
  // `load` 가 완료 시점의 최신 저장값을 보게 하는 거울 — 클로저에 잡힌 옛 값으로 판정하지 않는다.
  const storedRef = useRef(stored);

  const setBotId = useCallback((id: string | null) => {
    storedRef.current = id;
    setStored(id);
    writeStoredScope(id);
  }, []);

  // 읽은 결과를 상태에 싣는다. 이펙트 안에서 «동기로» 부르지 않는다(프로미스 콜백에서만) — 그래야
  // 캐스케이딩 렌더가 없다.
  const applyResult = useCallback((result: FetchResult) => {
    if (!result.ok) {
      // 목록을 못 읽어도 화면은 「전체」로 동작한다 — 단 «실패»로 기록해 0개와 구분한다
      setFetched(LOADED_FAILED);
      return;
    }
    setFetchedBots(result.bots);
    setFetched(LOADED_OK);
    // 저장된 선택이 목록에 없으면(삭제됨·다른 계정) 브라우저 저장값을 지운다 — «성공적으로» 읽었을 때만.
    // 순간 장애 한 번이 운영자의 선택을 날리면 안 된다. 메모리의 `stored` 는 그대로 둔다 —
    // 화면은 `resolveScope` 가 이미 전체(null)로 읽고, 지운 id 가 목록에 되살아날 일은 없다(UUID).
    if (storedRef.current && !resolveScope(storedRef.current, result.bots)) writeStoredScope(null);
  }, []);

  const load = useCallback(async () => {
    applyResult(await fetchBots());
  }, [applyResult]);

  // 로그인할 때와 «화면을 옮길 때마다» 읽는다.
  //
  // 예전엔 로그인 시 한 번만 읽었다. 이 provider 는 루트 레이아웃에 있어 화면 이동으로 다시 서지
  // 않으므로, 위젯을 붙이거나(`widget_connected_at`) 입구를 해제하거나 서비스를 새로 등록해도
  // 이 목록은 «로그인 시점»의 사실을 계속 말했다. 대시보드의 「피드백 채널」과 첫 사용 체크리스트가
  // 그 값을 읽어서, 붙이고 「연결됐어요」를 본 직후에 「아직 안 붙음」이라고 말했다. 갱신을 부르는
  // 자리를 mutation 마다 심으면(연결·해제·등록·앞으로 생길 것) 반드시 하나를 빠뜨린다 — 그래서
  // 「화면이 바뀌면 다시 읽는다」 한 줄로 그 부류를 통째로 닫는다. `/api/bots` 는 봇 목록 하나라 싸다.
  //
  // 읽는 «동안»에도 화면은 옛 목록으로 멀쩡히 돈다 — `applyResult` 는 성공했을 때만 값을 갈아끼우고
  // `loaded` 를 되돌리지 않는다. 그래서 이동할 때마다 셀렉터가 깜빡이지 않는다.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    void fetchBots().then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [status, applyResult, pathname]);

  // 로그아웃 상태는 «읽은 결과»가 아니라 정의다 — 봇 0개·성공. 이펙트에서 set 하지 않고 여기서 가른다.
  const signedOut = status === 'unauthenticated';
  const bots = signedOut ? EMPTY_BOTS : fetchedBots;
  const list = signedOut ? LOADED_OK : fetched;

  // 목록을 «성공적으로» 읽은 뒤에만 저장된 선택을 판정한다. 읽기에 실패했으면 이번엔 전체로 본다.
  const botId = !list.loaded ? stored : list.ok ? resolveScope(stored, bots) : null;

  const value = useMemo<BotScopeValue>(
    () => ({
      botId,
      current: botId ? (bots.find((b) => b.id === botId) ?? null) : null,
      bots,
      loaded: list.loaded,
      listOk: list.loaded && list.ok,
      ready: list.loaded || !stored,
      setBotId,
      refresh: load,
    }),
    [botId, bots, list, stored, setBotId, load],
  );

  return <BotScopeContext.Provider value={value}>{children}</BotScopeContext.Provider>;
}

const EMPTY_BOTS: ScopeBot[] = [];

export function useBotScope() {
  return useContext(BotScopeContext);
}

'use client';

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale } from 'next-intl';
import { getDemoData, type DemoPageKey } from './mock-data';

/** 이 주소로 열린 화면은 로그인 여부와 상관없이 연습용 데이터로 뜬다. 랜딩 「라이브 데모」 팝업이 붙인다. */
export const DEMO_PARAM = 'demo';

type DemoStore = Partial<Record<DemoPageKey, unknown>>;

interface DemoContextValue {
  isDemo: boolean;
  store: DemoStore;
  /** 한 화면의 연습용 데이터를 그 자리에서 고친다. 서버로는 아무것도 나가지 않는다. */
  patch: (key: DemoPageKey, updater: (prev: unknown) => unknown) => void;
}

const DemoContext = createContext<DemoContextValue>({
  isDemo: false,
  store: {},
  patch: () => {},
});

/**
 * 주소에 표시가 한 번이라도 있었나. **모듈 수준에 둔다.**
 *
 * 팝업 안에서 화면을 옮겨 다니면(묶음 → 수정 PR) 주소의 표시가 떨어져 나갈 수 있는데,
 * 그때 연습용이 풀려 진짜 데이터로 넘어가면 안 된다. 그래서 한 번 켜지면 끄지 않는다.
 * 탭을 새로 고치면 모듈이 다시 올라와 저절로 꺼진다 — 그게 우리가 원하는 「처음부터 다시」다.
 */
let demoLatch = false;

function readDemoFlag(): boolean {
  if (demoLatch) return true;
  try {
    if (new URLSearchParams(window.location.search).get(DEMO_PARAM) === '1') demoLatch = true;
  } catch {
    /* 주소를 못 읽는 환경 — 로그인 여부로만 정한다 */
  }
  return demoLatch;
}

/** 주소는 이 팝업이 사는 동안 스스로 바뀌지 않는다 — 구독할 바깥 변화가 없다. */
const noopSubscribe = () => () => {};
/** 서버에는 주소가 없다. 서버는 늘 「표시 없음」으로 그리고, 물이 들어온 뒤 클라이언트가 고쳐 그린다. */
const serverDemoFlag = () => false;

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const locale = useLocale();

  // 랜딩 「라이브 데모」 팝업 안에서는 **로그인해 있어도** 연습용 화면을 보여준다.
  // 운영자가 팝업을 열었을 때 진짜 편지함이 뜨면, 시연이나 촬영 중에 실제 방문자 이름이 화면에 박힌다.
  //
  // `useSyncExternalStore` 를 쓰는 이유 — 이펙트 안에서 setState 를 하면 한 번 더 그리고(경고),
  // 렌더 중에 `window` 를 바로 읽으면 서버가 그린 것과 어긋난다. 이 훅은 서버용 값을 따로 받아
  // 둘 다 피한다.
  const forcedDemo = useSyncExternalStore(noopSubscribe, readDemoFlag, serverDemoFlag);

  const isDemo = forcedDemo || status === 'unauthenticated';

  // 연습용 화면에서 누른 것은 **이 브라우저 탭 안에서만** 산다.
  //
  // 왜 서버에 안 보내나 — 로그인하지 않은 사람이 누르는 버튼이다. 심사위원·투표자가 누구든
  // 들어와 답장을 보내고 묶음을 만들 수 있는데, 그게 진짜 데이터에 닿으면 안 된다.
  //
  // 왜 sessionStorage 도 안 쓰나 — 새로고침하면 통째로 사라지는 게 **목적**이다.
  // 앞사람이 어질러 놓은 화면을 뒷사람이 물려받으면 튜토리얼이 한 번 쓰고 닳는다.
  // 여기 두면 새로고침이 곧 「처음부터 다시」가 되어 몇 명이 와도 같은 화면에서 시작한다.
  //
  // 한 문서 안에서 화면을 옮기는 동안(예: [PR 만들기] → 수정 PR)에는 살아 있어야 해서
  // 페이지가 아니라 앱 전체를 감싸는 여기에 둔다.
  //
  // ⚠️ 어디까지 사는지 정확히 — **문서 하나가 사는 동안**이다.
  // 팝업의 화면 전환 버튼은 iframe 을 새 문서로 갈아 끼우므로 그때는 이 store 도 새로 시작한다.
  // 그래서 편지함에서 보낸 답장은 「피드백 묶음」으로 옮겼다 돌아오면 남아 있지 않다.
  // 고치려면 브라우저 저장소에 넣어야 하는데, 그러면 새로고침해도 안 지워져서
  // 「새로고침하면 처음부터」라는 이 화면의 약속이 깨진다. 그래서 이대로 둔다.
  const [store, setStore] = useState<DemoStore>({});

  const patch = useCallback(
    (key: DemoPageKey, updater: (prev: unknown) => unknown) => {
      setStore((prev) => ({ ...prev, [key]: updater(prev[key] ?? getDemoData(locale)[key]) }));
    },
    [locale],
  );

  const value = useMemo(() => ({ isDemo, store, patch }), [isDemo, store, patch]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemoContext() {
  return useContext(DemoContext);
}

'use client';

// 탭을 누르면 주소의 `?tab=` 도 같이 바꾸는 `Tabs` 한 겹.
//
// 왜 필요한가 — 비제어 `Tabs` 는 클릭을 Radix 내부 상태로만 받고 주소는 그대로 둔다. 그러면
// 「지금 어느 탭을 보고 있나」의 진실 원천이 둘(주소 / 내부 상태)이 되어 서로 어긋난다. 헤더
// 서비스 셀렉터가 주소를 들고 다른 서비스로 옮기므로(`carryQuery`), 어긋난 주소를 들고 가면
// «보고 있던 탭이 아닌 탭»이 열린다. 새로고침·뒤로가기·링크 공유에서 탭이 안 남는 것도 같은 원인이다.
//
// 🔴 주소는 `history.replaceState` 로만 고친다 — `router.replace` 가 아니다.
// 이 화면들은 `force-dynamic` 서버 컴포넌트라 라우터로 고치면 서버 왕복이 돌고, 그 사이 폼이
// 다시 서면 **저장 안 한 지식 본문이 날아갈 수 있다.** 탭을 눌렀을 뿐인데 쓰던 글을 잃는 건
// 탭이 주소에 안 남는 것보다 훨씬 나쁘다. `replaceState` 는 주소창만 바꾸고 아무것도 다시 그리지 않는다.
// (`pushState` 도 아니다 — 탭 세 번 누르고 뒤로가기를 세 번 눌러야 나가지는 건 덫이다.)

import { useCallback } from 'react';
import { Tabs } from '@/components/ui/tabs';

interface UrlSyncedTabsProps {
  /** 처음 열 탭. 주소에서 읽어 서버가 넘긴다. */
  defaultValue: string;
  /** 주소에 쓸 쿼리 이름. */
  param?: string;
  className?: string;
  children: React.ReactNode;
}

export function UrlSyncedTabs({ defaultValue, param = 'tab', className, children }: UrlSyncedTabsProps) {
  const handleValueChange = useCallback(
    (value: string) => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set(param, value);
        window.history.replaceState(null, '', url.toString());
      } catch {
        // 주소를 못 고쳐도 탭 전환 자체는 되어야 한다 — 여기서 던지면 클릭이 통째로 죽는다
      }
    },
    [param],
  );

  return (
    <Tabs defaultValue={defaultValue} onValueChange={handleValueChange} className={className}>
      {children}
    </Tabs>
  );
}

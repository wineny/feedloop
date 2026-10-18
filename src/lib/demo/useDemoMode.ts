import { useCallback } from 'react';
import { useDemoContext } from './DemoProvider';
import { DEMO_DATA, type DemoPageKey } from './mock-data';

interface DemoPatch<T> {
  /** 이 화면의 연습용 데이터를 그 자리에서 고친다. 서버로는 아무것도 나가지 않는다. */
  patch: (updater: (prev: T) => T) => void;
}

export function useDemoMode<T = unknown>(pageKey: DemoPageKey):
  ({ isDemo: true; data: T } | { isDemo: false; data: null }) & DemoPatch<T> {
  const { isDemo, store, patch } = useDemoContext();

  // 훅은 분기 «앞»에서 부른다 — 뒤로 옮기면 로그인 여부가 바뀔 때 훅 수가 달라진다.
  const patchPage = useCallback(
    (updater: (prev: T) => T) => patch(pageKey, (prev) => updater(prev as T)),
    [patch, pageKey],
  );

  if (isDemo) {
    // 누른 적이 있으면 그 결과를, 없으면 원본을. 새로고침하면 store 가 비어 원본으로 돌아간다.
    return { isDemo: true, data: (store[pageKey] ?? DEMO_DATA[pageKey]) as T, patch: patchPage };
  }
  return { isDemo: false, data: null, patch: patchPage };
}

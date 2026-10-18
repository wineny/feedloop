'use client';

// 봇 연결 여부 폴링 훅.
//
// "붙였는데 되는 건지 모르겠다" 는 웹 위젯과 채널톡 둘 다에서 똑같이 생긴다.
// 폴링·상한·재개 로직은 같고, **무엇을 연결로 볼지만** 입구마다 다르다
// (위젯은 첫 로드, 채널톡은 첫 웹훅). 그래서 판정은 셀렉터로 받는다.

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 3000;
const POLL_LIMIT_MS = 15 * 60 * 1000; // 탭을 열어둔 채 방치돼도 무한 폴링하지 않는다

/** GET /api/bots/[id]/status 응답 */
export interface StatusResponse {
  id: string;
  status: string | null;
  status_message: string | null;
  platform: string | null;
  last_active_at: string | null;
  widget_connected_at: string | null;
  /** 웹 위젯 판정 — 위젯이 한 번이라도 떠서 첫 폴링을 보냈는가 */
  widget_connected: boolean;
  channel_connected_at: string | null;
  /** 채널톡 판정 — 웹훅이 한 번이라도 도착했는가 */
  channel_connected: boolean;
}

/**
 * 연결될 때까지 상태를 폴링한다. 연결되면 멈추고, 오래 방치되면 스스로 멈춘다.
 *
 * @param isConnected 응답을 보고 연결됐는지 판정한다. 예: `d => d.widget_connected`
 */
export function useConnectionStatus(
  botId: string,
  isConnected: (data: StatusResponse) => boolean,
  initiallyConnected: boolean,
) {
  const [state, setState] = useState({
    connected: initiallyConnected,
    polling: !initiallyConnected,
  });
  // 렌더 중 Date.now() 는 react-hooks/purity 위반. 폴링이 시작되는 effect 에서 찍는다.
  const startedAt = useRef(0);
  // 셀렉터는 호출부에서 인라인 화살표로 넘어온다 — 의존성 배열에 그대로 넣으면
  // 렌더마다 인터벌이 새로 걸린다. ref 로 최신 것만 들고 있는다.
  const selectorRef = useRef(isConnected);

  useEffect(() => {
    selectorRef.current = isConnected;
  }, [isConnected]);

  const checkOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/bots/${botId}/status`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      if (selectorRef.current(data)) setState({ connected: true, polling: false });
    } catch {
      // 일시적 네트워크 오류는 다음 폴링에서 회복된다
    }
  }, [botId]);

  useEffect(() => {
    if (!state.polling) return;
    if (startedAt.current === 0) startedAt.current = Date.now();

    const timer = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_LIMIT_MS) {
        setState((prev) => ({ ...prev, polling: false }));
        return;
      }
      void checkOnce();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [state.polling, checkOnce]);

  const resume = useCallback(() => {
    startedAt.current = Date.now();
    setState((prev) => ({ ...prev, polling: true }));
    void checkOnce();
  }, [checkOnce]);

  return { ...state, resume };
}

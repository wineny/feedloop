// 입구는 한 번에 하나 — 연결 화면이 무엇을 그릴지 정하는 판정.
//
// 예전엔 위젯과 채널톡을 둘 다 붙일 수 있었고, 화면이 실제로 그걸 권했다
// (「둘 다 붙여도 됩니다」). 그런데 두 입구가 하는 일이 반반이 아니다 — 위젯은 AI 즉답·
// 답변 지식·상담원 연결·BYOK·대화 맥락이 전부 돌고, 채널톡은 분류와 되돌림 둘뿐이다
// (`api/channel/webhook/…` 원칙 2). 같은 서비스인데 어느 문으로 들어오느냐에 따라
// 받는 제품이 달라지고, 운영자는 그 차이를 설명할 방법이 없다.
//
// 그래서 **한 서비스에 한 입구**로 좁혔다(2026-09-20 ny 결정). 갈아타는 길은 막지 않는다 —
// 쓰던 쪽을 「연결 해제」로 내리면 반대쪽이 열린다. 고르는 순간을 없애는 게 아니라
// 두 번 고르지 못하게 하는 것이다.
//
// 판정을 페이지에서 빼낸 이유는 테스트다. 페이지는 next-auth·supabase 를 끌고 오므로
// 이 분기 하나를 확인하려고 그걸 전부 세울 이유가 없다(`via.ts` 와 같은 이유).

import type { Via } from '@/lib/connect/via';

/** 두 입구의 이름. 카카오는 화면에서 내렸으므로(2026-09-14) 여기 없다. */
export type Entrance = 'widget' | 'channel';

export type ConnectScreen =
  /** 아직 아무 입구도 안 열렸다 — 「지금 고객 문의를 어떻게 받고 계세요?」 */
  | { kind: 'chooser' }
  /** 한 번이라도 연결됐다 — 현황판 */
  | { kind: 'overview' }
  /** 고른 갈래의 안내를 펼친다 */
  | { kind: 'guide'; via: Entrance }
  /** 반대쪽이 이미 쓰이고 있다 — 붙이기 전에 그쪽을 내려야 한다 */
  | { kind: 'locked'; want: Entrance; using: Entrance };

/** 두 입구의 현재 상태. `bots.widget_connected_at` · `channel_connected_at` 의 불린 판정. */
export interface EntranceState {
  widgetOn: boolean;
  channelOn: boolean;
}

const OTHER: Record<Entrance, Entrance> = { widget: 'channel', channel: 'widget' };

function isOn(state: EntranceState, entrance: Entrance): boolean {
  return entrance === 'widget' ? state.widgetOn : state.channelOn;
}

/**
 * 반대쪽이 쓰이고 있어서 이 입구를 지금 붙일 수 없는가.
 *
 * ⚠️ **「반대쪽이 켜졌다」만으로 잠그지 않는다.** 내가 이미 켜져 있으면 잠그지 않는다 —
 * 둘 다 켜진 봇(옛 규칙에서 넘어온 상태)의 운영자가 자기가 쓰던 안내 화면에서 쫓겨나
 * 스크립트도 다시 못 보는 일이 생긴다. 잠금은 **새로 하나를 더 붙이려 할 때**만 선다.
 */
export function isLocked(state: EntranceState, want: Entrance): boolean {
  return !isOn(state, want) && isOn(state, OTHER[want]);
}

/**
 * 연결 화면이 그릴 장면을 정한다.
 *
 * 잠금을 여기(페이지 진입)에서 판정하는 이유는 주소창이다. 카드의 버튼만 비활성으로
 * 두면 `?via=channel` 을 직접 쳐서 안내로 들어갈 수 있고, 그 끝에서 저장 API 가 400 을
 * 뱉는다 — 세 단계를 다 채운 뒤에 「안 됩니다」를 보는 건 잠금이 아니라 함정이다.
 */
export function resolveConnectScreen(via: Via, state: EntranceState): ConnectScreen {
  if (via) {
    if (isLocked(state, via)) return { kind: 'locked', want: via, using: OTHER[via] };
    return { kind: 'guide', via };
  }

  if (state.widgetOn || state.channelOn) return { kind: 'overview' };
  return { kind: 'chooser' };
}

/**
 * 화면에 적는 이름. 코드의 `channel` 을 운영자가 읽는 말로 옮긴다.
 *
 * ⚠️ **둘 다 받침으로 끝나야 한다.** 화면이 이 값 뒤에 「…을」·「…으로」를 붙여 쓰는데,
 * 받침 없는 이름으로 바꾸면 「채널토를」 같은 말이 남의 화면에 그대로 나간다.
 * `exclusive` 테스트가 이 조건을 단언한다 — 이름을 바꾸려면 그 테스트가 먼저 빨개진다.
 */
export const ENTRANCE_NAME: Record<Entrance, string> = {
  widget: 'Feedloop 웹 위젯',
  channel: '채널톡',
};

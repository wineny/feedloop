// 위젯 「연결됨」 표시를 찍는 한 곳.
//
// `api/widget/[botId]/messages` 안에 있던 것을 꺼냈다. 조건이 둘로 늘면서 «왜 그 조건인지»가
// 라우트 본문보다 길어졌고, 라우트 파일은 GET/POST 말고는 내보낼 수 없어 테스트가 닿지 않았다.

import { getServiceRoleClient } from '@/lib/supabase';

/**
 * 위젯이 처음 로드되면 봇에 시각을 찍는다. 이미 찍혀 있으면 그대로 둔다.
 *
 * **채널톡 키가 저장돼 있으면 안 찍는다**(2026-09-20, `lib/connect/exclusive.ts`).
 * 입구는 한 번에 하나인데, 위젯을 해제해도 서비스에 스크립트가 남아 있으면 다음 방문자가
 * 열 때 이 UPDATE 가 다시 「연결됨」으로 되돌린다 — 채널톡으로 갈아탄 운영자는 자기가
 * 내린 입구가 저절로 되살아나는 것을 보게 된다.
 *
 * 기준을 `channel_connected_at`(첫 웹훅이 도착한 시각)이 아니라 **키가 저장됐는지**로 둔
 * 이유는 그 사이의 틈이다. 운영자가 키를 저장하고 채널톡에 웹훅을 등록하는 몇 분 동안
 * `channel_connected_at` 은 아직 NULL 이고, 그때 방문자 한 명이 옛 위젯을 열면 둘 다 켜진다.
 * 키 저장은 「채널톡으로 받겠다」는 의사 표시라 그 순간부터 막는 게 맞다.
 *
 * 위젯이 **동작하는 것**은 막지 않는다 — 여기서 하는 일은 「연결됨」 표시뿐이다.
 * 서버는 고객사 페이지에서 스크립트를 지울 수 없고, 지운 척하지도 않는다.
 */
export async function markWidgetConnected(botId: string): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({ widget_connected_at: new Date().toISOString() })
    .eq('id', botId)
    .is('widget_connected_at', null)
    .is('channel_webhook_token_encrypted', null);
  if (error) console.error('[widget] markWidgetConnected error:', error.message);
}

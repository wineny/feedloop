// "이 봇이 채널에 연결됐는가" 판정 — 온보딩 페이지와 폴링 API 가 같은 답을 내도록 한 곳에 둔다.
//
// status='active' 는 텔레그램 setWebhook 성공만으로도 붙어서 연결 여부를 말해주지 못한다.
// 실제로 보는 신호는 두 가지 — 웹훅이 찍는 last_active_at, 그리고 이미 쌓인 메시지.
// (last_active_at 기록은 2026-09-06 에 추가돼서, 그 전에 들어온 메시지는 이 값이 비어 있다.)

import { getServiceRoleClient } from '@/lib/supabase';

/**
 * @param sources 없으면 오늘과 완전히 동일(전 채널 메시지를 센다).
 *
 * ⚠️ 재발 조건 — 이 인자를 안 주고 부르는 새 호출처가 생기면 채널톡 메시지가
 * 카카오 「연결됨」을 참으로 만든다. 현재 호출처는 status/route.ts 와
 * connect/page.tsx 둘뿐이고 둘 다 ['kakao'] 를 넘긴다.
 *
 * `.in('source', […])` 는 `source IS NULL` 행을 제외한다. 착수 시점 실측으로
 * messages.source 는 web·kakao 뿐이고 NULL 이 없어 기존 판정이 뒤집히지 않는다.
 */
export async function isBotConnected(
  botId: string,
  lastActiveAt: string | null,
  sources?: string[],
): Promise<boolean> {
  if (lastActiveAt) return true;

  let q = getServiceRoleClient()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', botId);
  if (sources?.length) q = q.in('source', sources);

  const { count } = await q;

  return (count ?? 0) > 0;
}

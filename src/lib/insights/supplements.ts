// 보충 턴(`insights.source_message_ids`) 본문을 원 제보에 덧붙이는 공용 재료.
//
// 왜 한 곳인가 (I-05) — 위젯 즉답이 꼬리질문 답을 «기존 인사이트 갱신»으로 흡수하면서
// 제보의 실제 내용이 `messages.body` 한 줄이 아니라 여러 턴에 흩어졌다. 그 원문을 읽는
// 소비처가 둘이다: 자동 PR 엔진(`auto-dev/execute-run.ts`)과 스펙 초안(`groups/spec.ts`).
// 한쪽만 보충을 읽으면 같은 묶음이 경로에 따라 «다른 제보»로 보인다 — 코드 PR 은
// 「흰 화면·PC 크롬」까지 알고, 스펙 초안은 「쿠폰함 확인 안 돼요」만 읽는 식이다.

import { getServiceRoleClient } from '@/lib/supabase';

let _db: ReturnType<typeof getServiceRoleClient> | null = null;
function db() {
  if (!_db) _db = getServiceRoleClient();
  return _db;
}

/** 인사이트당 보충 턴 재료 상한 — 프롬프트가 무한정 커지지 않게. */
export const SUPPLEMENT_LIMIT = 3;
export const SUPPLEMENT_CHARS = 250;

/**
 * 원 제보 본문 뒤에 보충 턴 본문을 「(보충) …」 줄로 덧붙인다.
 * 순수 함수 — supplements 가 없으면 body 그대로.
 */
export function appendSupplements(body: string, supplements: string[]): string {
  if (supplements.length === 0) return body;
  return [body, ...supplements.map((s) => `(보충) ${s}`)].join('\n');
}

/**
 * `source_message_ids` 의 메시지 본문을 시각순으로 모은다.
 *
 * @param botId **반드시 넘긴다.** 이 본문은 자동 PR 프롬프트와 PR 본문에 그대로 실린다.
 *        배열 값은 모델이 고른 ref 를 따라 쓰인 것이라, id 하나가 잘못 들어가면 남의
 *        테넌트 메시지가 우리 레포 PR 에 인용된다. 조회를 봇으로 좁혀 그 경로를 닫는다.
 *
 * 정렬을 명시하는 이유: 보충은 «대화의 순서»가 곧 뜻이다(증상 → 기기 → 재현 조건).
 * PostgREST 는 정렬을 안 주면 순서를 보장하지 않아, 같은 제보가 실행마다 다르게 읽힌다.
 */
export async function loadSupplementBodies(
  ids: string[] | null | undefined,
  botId: string,
): Promise<string[]> {
  const targets = (ids ?? []).slice(0, SUPPLEMENT_LIMIT);
  if (targets.length === 0) return [];

  const { data, error } = await db()
    .from('messages')
    .select('body')
    .eq('bot_id', botId)
    .in('id', targets)
    .order('detected_at', { ascending: true });

  if (error) {
    // 보충을 못 읽어도 원 제보로는 돌아간다. 다만 조용히 비면 「엔진이 왜 보충을
    // 못 봤지」를 추적할 방법이 없다.
    console.error('[supplements] load error:', error.message);
    return [];
  }

  return (data ?? [])
    .map((m) => (m as { body?: string }).body)
    .filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    .map((b) => (b.length > SUPPLEMENT_CHARS ? `${b.slice(0, SUPPLEMENT_CHARS)}…` : b));
}

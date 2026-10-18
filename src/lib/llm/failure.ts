// 즉답 LLM 호출이 실패했다는 사실을 운영자에게 남긴다 (계획 §B-6).
//
// key.ts 와 나눠 둔 이유: key.ts 는 운영자 화면(클라이언트 컴포넌트)이 문구 함수를
// 가져다 쓸 수 있어야 해서 서버 전용 모듈을 import 하지 않는다. DB 를 만지는 건 여기다.

import { getServiceRoleClient } from '@/lib/supabase';

/**
 * 배지 판정은 `llm_key_failed_at`, 문구는 `llm_key_failed_reason` 이 담당한다.
 * `status_message` 는 건드리지 않는다 — 그 컬럼은 연결 상태 전용이고
 * `markBotConnected()` 가 카카오 메시지마다 지운다(20260910_02 주석 참고).
 *
 * `reason` 에는 `failureMessage()` 가 만든 4분류 고정 문자열만 들어간다.
 * provider 에러 원문은 절대 넣지 않는다.
 */
export async function markLlmKeyFailed(botId: string, reason: string): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      llm_key_failed_at: new Date().toISOString(),
      llm_key_failed_reason: reason,
    })
    .eq('id', botId);

  if (error) console.error(`[llm] markLlmKeyFailed error for ${botId}:`, error.message);
}

/**
 * 실패 표시를 지운다. **성공한 호출에서만, 그것도 표시가 남아 있을 때만** 부른다
 * (`BotConfig.llmKeyFailedAt`). 평소 호출은 DB 왕복이 0 이어야 한다 —
 * 위젯 POST 는 메시지마다 이 경로를 탄다.
 *
 * 이게 없으면 배지가 «영구 고정»된다. 운영자가 키를 고쳐 다시 답이 나가기 시작해도
 * `llm_key_failed_at` 은 남아 있어 「키 확인 필요」가 계속 떠 있게 된다.
 */
export async function clearLlmKeyFailure(botId: string): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({ llm_key_failed_at: null, llm_key_failed_reason: null })
    .eq('id', botId);

  if (error) console.error(`[llm] clearLlmKeyFailure error for ${botId}:`, error.message);
}

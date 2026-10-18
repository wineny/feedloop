// 봇별 일일 즉답 상한. 무인증 위젯 POST 가 운영자(또는 우리) 지갑을 태우지 않게 하는 장치다.
//
// 두 가지가 핵심이다.
//  1) **선증가 후판정.** LLM 을 부르기 전에 카운터를 원자적으로 올리고, 올린 값이 상한을
//     넘으면 안 부른다. read-then-write 로 세면 동시 요청이 상한을 넘겨 새어 나간다.
//  2) **실패해도 되돌리지 않는다.** 되돌리면 실패를 유발해 무한히 태우는 경로가 생긴다.
//     그래서 컬럼 이름이 `ai_call_attempts`(시도)다 — 성공한 응답 수가 아니다.
//     화면에 "AI 응답 N건" 으로 쓰지 말 것. 응답 건수는 `responses` 를 세야 한다.

import { getServiceRoleClient } from '@/lib/supabase';
import { resolveLimit, isOverLimit, type LimitInputs } from './limits';

// 판정 부분은 limits.ts 에 있다(의존성 0 — 클라이언트 화면이 상한을 그려야 한다).
// 기존 호출부가 안 깨지게 여기서 다시 내보낸다.
export { DEFAULT_LIMITS, resolveLimit, isOverLimit, type LimitInputs } from './limits';

/**
 * 오늘의 호출 시도를 1 올리고 **올린 뒤 값**을 돌려준다. 원자적이다(DB 함수).
 * 날짜 경계는 KST — `bump_bot_usage` 안의 `AT TIME ZONE 'Asia/Seoul'`.
 *
 * 계측 자체가 실패하면 `null` 을 준다. 호출부는 이걸 **상한 초과와 같게 다뤄야 한다**(fail closed):
 * 셀 수 없는 상태에서 무인증 경로에 LLM 을 열어두면 상한이 상한이 아니게 된다(D2).
 * 잃는 건 즉답뿐이고 메시지는 그대로 저장돼 받은편지함에 남는다.
 */
export async function bumpUsage(botId: string): Promise<number | null> {
  try {
    const { data, error } = await getServiceRoleClient().rpc('bump_bot_usage', {
      p_bot_id: botId,
    });
    if (error) {
      console.error(`[llm] usage bump failed for ${botId}:`, error.message);
      return null;
    }
    return typeof data === 'number' ? data : null;
  } catch (err) {
    console.error(`[llm] usage bump threw for ${botId}:`, err instanceof Error ? err.message : 'unknown');
    return null;
  }
}

/**
 * 카카오 호출을 «따로» 센다. 위젯 상한(`ai_call_attempts`)을 잠식하지 않기 위해서다 —
 * 카카오는 계측만 하고 차단하지 않으므로, 같은 칸에 얹으면 차단당하지 않는 트래픽이
 * 차단당하는 트래픽의 상한을 먹어치운다(20260910_03 주석 참고).
 *
 * 결과를 «보지 않는다». 실패해도 카카오 응답은 그대로 나가야 한다.
 */
export async function bumpKakaoUsage(botId: string): Promise<number | null> {
  try {
    const { data, error } = await getServiceRoleClient().rpc('bump_kakao_usage', {
      p_bot_id: botId,
    });
    if (error) {
      console.error(`[llm] kakao usage bump failed for ${botId}:`, error.message);
      return null;
    }
    return typeof data === 'number' ? data : null;
  } catch (err) {
    console.error(
      `[llm] kakao usage bump threw for ${botId}:`,
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

export type BudgetResult<T> =
  | { allowed: true; attempts: number | null; limit: number; value: T }
  | { allowed: false; attempts: number | null; limit: number };

/**
 * 선증가 후판정을 «순서까지» 강제하는 묶음. 카운터를 먼저 원자적으로 올리고,
 * 넘었으면 `run` 을 **부르지 않는다**.
 *
 * 호출부가 직접 bump → 판정 → 호출을 쓰면 언젠가 순서가 뒤집히거나 판정이 빠진다.
 * 무인증 경로에서 그건 곧 남의 지갑이라, 순서를 코드로 묶어 둔다.
 *
 * 상한을 넘겨도 **메시지 저장은 호출부가 이미 끝낸 뒤**여야 한다 —
 * 상한은 답을 막는 장치이지 피드백을 버리는 장치가 아니다.
 *
 * ⚠️ `run` 의 결과를 **기다리지 않는다.** 호출부가 돌려받은 것을 자기 타임아웃과
 * 경주시켜야 하기 때문이다(위젯 10초·카카오 4초). 그래서 `run` 은 "시작하는" 함수다.
 */
export async function withReplyBudget<T>(
  botId: string,
  limits: LimitInputs,
  run: () => T,
): Promise<BudgetResult<T>> {
  const limit = resolveLimit(limits);
  const attempts = await bumpUsage(botId);

  if (isOverLimit(attempts, limit)) {
    console.warn(`[llm] daily reply budget exhausted: bot=${botId} attempts=${attempts} limit=${limit}`);
    return { allowed: false, attempts, limit };
  }

  return { allowed: true, attempts, limit, value: run() };
}

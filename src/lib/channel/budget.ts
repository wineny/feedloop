// 채널톡 분류 호출의 일일 상한.
//
// 무인증 웹훅이고 CS 비중이 높아 하루 수백 건이 들어올 수 있다. 그 비용은 운영자 키
// (BYOK)로 나가거나 우리 플랫폼 키로 나간다 — 어느 쪽이든 세지 않으면 상한이 없다.
//
// **세는 칸을 나눈 이유**는 20260910_03 이 카카오에 대해 적어 둔 것과 같다.
// `ai_call_attempts`(위젯 즉답 상한)에 얹으면 채널톡이 활발한 날 위젯이 아무 잘못 없이
// 조용히 막힌다. 채널톡은 자기 칸 `channel_call_attempts` 를 쓴다.
//
// **상한은 분류를 막지 제보를 버리지 않는다.** 호출부는 메시지를 이미 저장한 뒤에 이걸
// 부른다 — 초과해도 받은편지함에는 그대로 남는다(`usage.ts:79-80` 의 원칙을 옮긴 것).

import { getServiceRoleClient } from '@/lib/supabase';
import { resolveLimit, isOverLimit, type LimitInputs } from '@/lib/llm/limits';

export interface ChannelBudgetDecision {
  allowed: boolean;
  /** 올린 뒤 값. 계측 자체가 실패하면 null 이다. */
  attempts: number | null;
  limit: number;
}

/**
 * 오늘의 채널톡 분류 시도를 1 올리고 **올린 뒤 값**을 돌려준다. 원자적이다(DB 함수).
 * 날짜 경계는 KST — `bump_channel_usage` 안의 `AT TIME ZONE 'Asia/Seoul'`.
 *
 * 실패하면 `null`. 호출부는 이걸 **초과와 같게 다뤄야 한다**(fail closed) —
 * 셀 수 없는 상태에서 무인증 경로에 LLM 을 열어두면 상한이 상한이 아니게 된다.
 */
export async function bumpChannelUsage(botId: string): Promise<number | null> {
  try {
    const { data, error } = await getServiceRoleClient().rpc('bump_channel_usage', {
      p_bot_id: botId,
    });
    if (error) {
      console.error(`[channel/${botId}] usage bump failed:`, error.message);
      return null;
    }
    return typeof data === 'number' ? data : null;
  } catch (err) {
    console.error(
      `[channel/${botId}] usage bump threw:`,
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/**
 * 선증가 후판정을 순서까지 묶는다. 카운터를 먼저 원자적으로 올리고 그 값으로 판정한다 —
 * read-then-write 로 세면 동시 요청이 상한을 넘겨 새어 나간다.
 *
 * 상한 자체는 `resolveLimit` 을 그대로 쓴다. 봇마다 `daily_reply_limit` · provider · 키 유무로
 * 정해지는 값이고, 채널톡만 다른 규칙을 두면 운영자가 두 숫자를 외워야 한다.
 */
export async function checkChannelBudget(
  botId: string,
  limits: LimitInputs,
): Promise<ChannelBudgetDecision> {
  const limit = resolveLimit(limits);
  const attempts = await bumpChannelUsage(botId);

  if (isOverLimit(attempts, limit)) {
    console.warn(
      `[channel/${botId}] daily classify budget exhausted: attempts=${attempts} limit=${limit}`,
    );
    return { allowed: false, attempts, limit };
  }
  return { allowed: true, attempts, limit };
}

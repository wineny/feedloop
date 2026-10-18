// 「되돌림 재전송」 버튼 주변의 문구 판정.
//
// 화면에서 떼어 둔 이유는 하나다 — 이 분기를 틀리면 운영자가 «반대로» 안다.
// 다섯 칸은 성격이 제각각이고, 한 줄로 접으면 「고쳐야 할 것」과 「그냥 기다리면 되는 것」이
// 같은 얼굴이 된다. 그래서 문구를 셋으로 나눠 돌려준다:
//   headline — 이번 클릭의 결과
//   warning  — 사람이 봐야 하는 것(더 눌러도 안 나감)
//   note     — 기다리면 되는 것(실패가 아님)
//
// 타입만 빌려 온다(`import type` 은 컴파일에서 지워진다) — 전송 모듈의 supabase 의존이
// 이 파일과 테스트로 딸려 오지 않게.
import type { RunRetryOutcome } from '@/lib/channel/redeliver';
import type { RunReturn } from '@/app/api/auto-dev/runs/route';

/**
 * 미전달을 입구별로 나눈다. 버튼을 «누르기 전»의 라벨에 쓴다.
 *
 * 입구를 가리지 않은 합계는 이 자리에 쓸 수 없다.
 * 채널톡 미전달은 **전송 실패**(재시도로 푼다)이고 카카오 미전달은 **대기열**
 * (그 유저가 다음에 말을 걸면 나간다)이라, 같은 숫자로 묶으면 재전송 버튼이
 * 「눌러도 아무 일 없는 버튼」이 된다.
 */
export function countUndeliveredBySource(returns: RunReturn[]): {
  channel: number;
  kakao: number;
} {
  let channel = 0;
  let kakao = 0;
  for (const r of returns) {
    if (r.deliveredAt) continue;
    if (r.source === 'channel') channel += 1;
    else if (r.source === 'kakao') kakao += 1;
  }
  return { channel, kakao };
}

/**
 * 라우트 응답을 «믿지 않고» 확인한다.
 *
 * `res.json()` 은 `any` 라 필드 이름이 하나만 어긋나도 다섯 칸이 전부 `undefined` 가 되고,
 * 그러면 「전부 0」 분기를 타 **「보낼 되돌림이 없어요」가 조용히 잘못 뜬다.**
 * 실제로 겪은 종류의 사고다(3칸 → 5칸 전환). 조용히 틀리느니 시끄럽게 멈춘다.
 */
export function parseRunRetryOutcome(json: unknown): RunRetryOutcome {
  if (typeof json !== 'object' || json === null) {
    throw new Error('응답 형태가 예상과 달라요');
  }
  const o = json as Record<string, unknown>;
  const keys = ['sent', 'failed', 'remaining', 'exhausted', 'skippedNonChannel'] as const;

  for (const k of keys) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) {
      throw new Error('응답 형태가 예상과 달라요');
    }
  }

  return {
    sent: o.sent as number,
    failed: o.failed as number,
    remaining: o.remaining as number,
    exhausted: o.exhausted as number,
    skippedNonChannel: o.skippedNonChannel as number,
  };
}

export interface RetryMessage {
  headline: string;
  /** 경고 색으로 — 버튼을 더 눌러도 안 나가는 건들 */
  warning: string | null;
  /** 중립 색으로 — 실패가 아니라 정상 동작인 건들 */
  note: string | null;
}

/**
 * 재전송이 끝난 뒤 버튼 옆에 남길 문구.
 *
 * 다섯 칸이 전부 0 인 것은 **오류가 아니다** — 보낼 게 없었다는 뜻이다.
 * 「0건 실패」로 읽히면 운영자가 없는 문제를 찾는다.
 */
export function buildRetryMessage(outcome: RunRetryOutcome): RetryMessage {
  const { sent, failed, remaining, exhausted, skippedNonChannel } = outcome;

  if (sent === 0 && failed === 0 && remaining === 0 && exhausted === 0 && skippedNonChannel === 0) {
    return { headline: '보낼 반영 알림이 없어요', warning: null, note: null };
  }

  const parts: string[] = [];
  if (sent > 0) parts.push(`${sent}건 보냈어요`);
  // 「실패」로만 적으면 우리 쪽 버그처럼 읽힌다. 거부한 주체를 밝힌다.
  if (failed > 0) parts.push(`${failed}건은 채널톡이 거부했어요`);
  // 한 번에 최대 5건만 나간다. 남은 게 있으면 회수 경로 둘을 다 말해 준다 —
  // 안 그러면 운영자가 「왜 다 안 갔지」에서 멈추고, 버튼만이 유일한 길이라 오해한다.
  if (remaining > 0) {
    parts.push(`${remaining}건 남았어요. 다시 누르거나 고객이 말을 걸면 나갑니다`);
  }

  const headline =
    parts.length > 0
      ? parts.join(' · ')
      : // 시도할 수 있는 게 하나도 없었다. 아래 warning·note 가 이유를 말한다.
        '지금 보낼 수 있는 반영 알림이 없어요';

  return {
    headline,
    warning:
      exhausted > 0
        ? `${exhausted}건은 여러 번 실패해 더 보내지 않아요. 채널톡 연결과 그 대화가 아직 열려 있는지 확인해 주세요`
        : null,
    note:
      skippedNonChannel > 0
        ? `${skippedNonChannel}건은 다른 채널이라 고객이 말 걸 때 나갑니다`
        : null,
  };
}

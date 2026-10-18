import { describe, it, expect } from 'vitest';
import {
  buildRetryMessage,
  countUndeliveredBySource,
  parseRunRetryOutcome,
} from '@/lib/monitor/redeliver-message';
import type { RunReturn } from '@/app/api/auto-dev/runs/route';
import type { RunRetryOutcome } from '@/lib/channel/redeliver';

// 이 판정을 화면에서 떼어 둔 이유는 틀리면 운영자가 «반대로» 알기 때문이다.
// 다섯 칸은 성격이 제각각이다 — 「고칠 것」(exhausted) · 「다시 누를 것」(remaining) ·
// 「그냥 기다릴 것」(skippedNonChannel)이 한 얼굴로 보이면 안 된다.

function ret(source: string, deliveredAt: string | null, id = Math.random().toString()): RunReturn {
  return {
    conversationId: id,
    source,
    name: '이름',
    deliveredAt,
    confirmation: null,
    confirmedAt: null,
    // main 이 되돌림에 메일 발송을 더했다(`RunReturn.emailSentAt`). 이 판정은 채널톡 전달
    // 상태만 보므로 값은 무관하지만, 타입이 요구하는 칸이라 명시한다.
    emailSentAt: null,
  };
}

const ZERO: RunRetryOutcome = {
  sent: 0,
  failed: 0,
  remaining: 0,
  exhausted: 0,
  skippedNonChannel: 0,
};

function msg(patch: Partial<RunRetryOutcome>) {
  return buildRetryMessage({ ...ZERO, ...patch });
}

describe('countUndeliveredBySource — 입구를 갈라 센다', () => {
  it('채널톡 미전달과 카카오 미전달을 따로 센다', () => {
    const returns = [
      ret('channel', null, 'a'),
      ret('channel', null, 'b'),
      ret('kakao', null, 'c'),
      ret('channel', '2026-09-10T00:00:00Z', 'd'),
      ret('kakao', '2026-09-10T00:00:00Z', 'e'),
    ];

    expect(countUndeliveredBySource(returns)).toEqual({ channel: 2, kakao: 1 });
  });

  it('전달된 것은 어느 입구든 세지 않는다', () => {
    const returns = [ret('channel', '2026-09-10T00:00:00Z'), ret('kakao', '2026-09-10T00:00:00Z')];
    expect(countUndeliveredBySource(returns)).toEqual({ channel: 0, kakao: 0 });
  });

  it('웹 위젯은 어느 칸에도 안 들어간다 — 폴링으로 즉시 받아가 밀 일이 없다', () => {
    expect(countUndeliveredBySource([ret('web', null)])).toEqual({ channel: 0, kakao: 0 });
  });

  it('되돌림이 없으면 0이다', () => {
    expect(countUndeliveredBySource([])).toEqual({ channel: 0, kakao: 0 });
  });
});

describe('buildRetryMessage — 다섯 칸이 전부 0 인 것은 오류가 아니다', () => {
  it('보낼 게 없었으면 그렇게 말한다', () => {
    expect(buildRetryMessage(ZERO)).toEqual({
      headline: '보낼 반영 알림이 없어요',
      warning: null,
      note: null,
    });
  });

  it('「0건 실패」로 읽히지 않는다 — 없는 문제를 찾게 만들면 안 된다', () => {
    const { headline, warning } = buildRetryMessage(ZERO);
    expect(headline).not.toContain('실패');
    expect(warning).toBeNull();
  });
});

describe('buildRetryMessage — 이번 클릭의 결과', () => {
  it('전부 나갔으면 보낸 수만 말한다', () => {
    expect(msg({ sent: 3 }).headline).toBe('3건 보냈어요');
  });

  it('일부 실패하면 둘을 「 · 」로 이어 말한다', () => {
    expect(msg({ sent: 2, failed: 1 }).headline).toBe('2건 보냈어요 · 1건은 채널톡이 거부했어요');
  });

  it('거부한 주체를 밝힌다 — 「실패」로만 적으면 우리 쪽 버그처럼 읽힌다', () => {
    expect(msg({ failed: 3 }).headline).toBe('3건은 채널톡이 거부했어요');
  });

  it('한 번에 5건 상한이라 남은 게 있으면 회수 경로 둘을 다 말한다', () => {
    const { headline } = msg({ sent: 5, remaining: 2 });
    expect(headline).toContain('5건 보냈어요');
    expect(headline).toContain('2건 남았어요');
    // 버튼만이 유일한 길이라고 오해하면 안 된다 — 고객이 말을 걸어도 나간다.
    expect(headline).toContain('고객이 말을 걸면');
  });
});

describe('buildRetryMessage — 고칠 것과 기다릴 것을 갈라 놓는다', () => {
  it('소진된 건은 경고로 뺀다 — 버튼을 더 눌러도 안 나간다', () => {
    const { warning } = msg({ sent: 1, exhausted: 2 });
    expect(warning).toContain('2건');
    expect(warning).toContain('더 보내지 않아요');
  });

  it('다른 채널 미전달은 실패가 아니라 정상 동작이다', () => {
    const { note, warning } = msg({ sent: 1, skippedNonChannel: 3 });
    expect(note).toContain('3건');
    expect(note).toContain('고객이 말 걸 때');
    // 경고 자리에 섞이면 운영자가 고치려 든다. 고칠 게 없는 건이다.
    expect(warning).toBeNull();
  });

  it('소진과 다른 채널은 서로 다른 줄이다', () => {
    const { warning, note } = msg({ exhausted: 1, skippedNonChannel: 1 });
    expect(warning).not.toBeNull();
    expect(note).not.toBeNull();
    expect(warning).not.toBe(note);
  });

  it('시도할 게 없었어도 이유가 있으면 「없어요」로 끝내지 않는다', () => {
    // 전부 소진됐거나 전부 다른 채널이면 sent·failed 가 0 이지만 할 말이 있다.
    const { headline, warning } = msg({ exhausted: 2 });
    expect(headline).toBe('지금 보낼 수 있는 반영 알림이 없어요');
    expect(warning).toContain('2건');
  });
});

describe('parseRunRetryOutcome — 응답을 믿지 않고 확인한다', () => {
  it('다섯 칸이 전부 숫자면 그대로 통과시킨다', () => {
    const ok = { sent: 1, failed: 2, remaining: 3, exhausted: 4, skippedNonChannel: 5 };
    expect(parseRunRetryOutcome(ok)).toEqual(ok);
  });

  it('칸 이름이 어긋나면 던진다 — 조용히 「보낼 게 없어요」로 뜨면 안 된다', () => {
    // 3칸 시절 응답. 그대로 통과시키면 다섯 칸이 undefined 라 「전부 0」 분기를 탄다.
    expect(() => parseRunRetryOutcome({ sent: 1, failed: 0, considered: 1 })).toThrow(
      '응답 형태가 예상과 달라요',
    );
    expect(() => parseRunRetryOutcome(null)).toThrow('응답 형태가 예상과 달라요');
    expect(() => parseRunRetryOutcome({ ...ZERO, sent: '1' })).toThrow(
      '응답 형태가 예상과 달라요',
    );
  });
});

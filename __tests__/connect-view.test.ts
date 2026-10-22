import { describe, it, expect } from 'vitest';
import { resolveVia } from '@/lib/connect/via';
import { lastFeedbackParts, dayNumber } from '@/lib/connect/last-feedback';
import { ENTRANCE_NAME, isLocked, resolveConnectScreen } from '@/lib/connect/exclusive';

// 연결 화면이 쓰는 순수 판정 둘. 화면 코드는 브라우저로 보면 되지만 이 둘은 **조용히 틀린다** —
// 갈래가 한 칸 어긋나면 엉뚱한 안내가 펼쳐지고, 시각은 한 시간씩 밀려도 화면이 멀쩡해 보인다.

describe('resolveVia — 어느 갈래를 펼칠지', () => {
  it('아는 값만 통과시킨다', () => {
    expect(resolveVia('widget')).toBe('widget');
    expect(resolveVia('channel')).toBe('channel');
  });

  it('모르는 값·빈 값은 갈림길로 떨어뜨린다 — 오타 난 링크가 엉뚱한 안내를 펼치면 안 된다', () => {
    expect(resolveVia('hack')).toBeNull();
    expect(resolveVia('')).toBeNull();
    expect(resolveVia(undefined)).toBeNull();
    expect(resolveVia('WIDGET')).toBeNull(); // 대소문자를 관대하게 받지 않는다
  });

  it('쿼리가 배열로 와도 첫 값만 본다', () => {
    expect(resolveVia(['channel', 'widget'])).toBe('channel');
    expect(resolveVia([])).toBeNull();
  });

  it('옛 ?tab= 링크를 받는다', () => {
    expect(resolveVia(undefined, 'web')).toBe('widget');
    expect(resolveVia(undefined, 'channel')).toBe('channel');
    expect(resolveVia(undefined, ['web'])).toBe('widget');
  });

  it('?tab=kakao 는 갈림길로 — 카카오는 화면에서 내렸고 갈 곳이 없다', () => {
    expect(resolveVia(undefined, 'kakao')).toBeNull();
  });

  it('?via= 가 ?tab= 보다 이긴다', () => {
    expect(resolveVia('widget', 'channel')).toBe('widget');
  });
});

describe('lastFeedbackParts — 마지막 피드백 시각', () => {
  // KST 2026-09-14 15:00 = UTC 06:00
  const now = new Date('2026-09-14T06:00:00Z');
  const KST = 'Asia/Seoul';

  it('시각이 없으면 none', () => {
    expect(lastFeedbackParts(null, now, KST)).toEqual({ kind: 'none' });
  });

  it('읽을 수 없는 값을 none 으로 접지 않는다 — 대화는 있는데 시각만 못 읽은 것이다', () => {
    expect(lastFeedbackParts('오늘쯤', now, KST)).toEqual({ kind: 'invalid' });
  });

  it('오늘·어제만 상대 표현을 쓰고 그 앞은 날짜로 적는다', () => {
    expect(lastFeedbackParts('2026-09-14T04:18:00Z', now, KST).kind).toBe('today'); // KST 09-14 13:18
    expect(lastFeedbackParts('2026-09-13T07:18:00Z', now, KST).kind).toBe('yesterday'); // KST 09-13 16:18
    expect(lastFeedbackParts('2026-09-11T07:18:00Z', now, KST).kind).toBe('date'); // KST 09-11
  });

  it('보는 사람의 시간대 자정을 기준으로 가른다 — 같은 순간도 시간대에 따라 오늘이거나 어제다', () => {
    // KST 09-14 00:30 = UTC 09-13 15:30. UTC 로는 어제, 한국에서는 오늘이다.
    expect(lastFeedbackParts('2026-09-13T15:30:00Z', now, KST).kind).toBe('today');
    expect(lastFeedbackParts('2026-09-13T15:30:00Z', now, 'UTC').kind).toBe('yesterday');
    // KST 09-13 23:59 = UTC 09-13 14:59 — 한국에서는 어제.
    expect(lastFeedbackParts('2026-09-13T14:59:00Z', now, KST).kind).toBe('yesterday');
    // 미국 서부(UTC-7): now 는 09-13 23:00 이라 같은 순간(UTC 09-13 15:30 = 08:30)이 오늘이다.
    expect(lastFeedbackParts('2026-09-13T15:30:00Z', now, 'America/Los_Angeles').kind).toBe('today');
  });
});

describe('dayNumber', () => {
  it('시간대 자정에서 하루가 넘어간다', () => {
    const beforeMidnight = new Date('2026-09-13T14:59:59Z'); // KST 09-13 23:59:59
    const afterMidnight = new Date('2026-09-13T15:00:00Z'); // KST 09-14 00:00:00
    expect(dayNumber(afterMidnight, 'Asia/Seoul') - dayNumber(beforeMidnight, 'Asia/Seoul')).toBe(1);
    expect(dayNumber(afterMidnight, 'UTC') - dayNumber(beforeMidnight, 'UTC')).toBe(0);
  });
});

describe('resolveConnectScreen — 입구는 한 번에 하나', () => {
  const NONE = { widgetOn: false, channelOn: false };
  const WIDGET = { widgetOn: true, channelOn: false };
  const CHANNEL = { widgetOn: false, channelOn: true };
  /** 옛 규칙(둘 다 허용)에서 넘어온 봇. 지금은 만들 수 없지만 있을 수 있다 */
  const BOTH = { widgetOn: true, channelOn: true };

  it('아무 입구도 없으면 갈림길을 묻는다', () => {
    expect(resolveConnectScreen(null, NONE)).toEqual({ kind: 'chooser' });
  });

  it('한 번이라도 연결됐으면 같은 질문을 다시 하지 않는다', () => {
    expect(resolveConnectScreen(null, WIDGET)).toEqual({ kind: 'overview' });
    expect(resolveConnectScreen(null, CHANNEL)).toEqual({ kind: 'overview' });
  });

  it('입구가 비어 있으면 고른 갈래의 안내를 펼친다', () => {
    expect(resolveConnectScreen('widget', NONE)).toEqual({ kind: 'guide', via: 'widget' });
    expect(resolveConnectScreen('channel', NONE)).toEqual({ kind: 'guide', via: 'channel' });
  });

  it('반대쪽이 쓰이고 있으면 잠근다 — 주소를 직접 쳐도 안내가 열리면 안 된다', () => {
    expect(resolveConnectScreen('channel', WIDGET)).toEqual({
      kind: 'locked',
      want: 'channel',
      using: 'widget',
    });
    expect(resolveConnectScreen('widget', CHANNEL)).toEqual({
      kind: 'locked',
      want: 'widget',
      using: 'channel',
    });
  });

  it('쓰고 있는 쪽의 안내는 계속 열린다 — 스크립트·키를 다시 볼 길을 막지 않는다', () => {
    expect(resolveConnectScreen('widget', WIDGET)).toEqual({ kind: 'guide', via: 'widget' });
    expect(resolveConnectScreen('channel', CHANNEL)).toEqual({ kind: 'guide', via: 'channel' });
  });

  it('둘 다 켜진 옛 봇을 자기 화면에서 쫓아내지 않는다', () => {
    // 잠금은 «새로 하나를 더 붙이려 할 때»만 선다. 이미 쓰던 사람은 양쪽 다 열람할 수 있어야
    // 스크립트든 웹훅 주소든 다시 꺼내 본다.
    expect(resolveConnectScreen('widget', BOTH)).toEqual({ kind: 'guide', via: 'widget' });
    expect(resolveConnectScreen('channel', BOTH)).toEqual({ kind: 'guide', via: 'channel' });
    expect(resolveConnectScreen(null, BOTH)).toEqual({ kind: 'overview' });
  });

  it('isLocked — 내가 꺼져 있고 반대쪽이 켜져 있을 때만 참', () => {
    expect(isLocked(NONE, 'widget')).toBe(false);
    expect(isLocked(WIDGET, 'widget')).toBe(false);
    expect(isLocked(WIDGET, 'channel')).toBe(true);
    expect(isLocked(CHANNEL, 'widget')).toBe(true);
    expect(isLocked(BOTH, 'widget')).toBe(false);
  });
});

describe('ENTRANCE_NAME — 뒤에 붙는 조사가 깨지지 않아야 한다', () => {
  // 화면이 이 값 뒤에 「…을」·「…으로」를 붙인다. 받침 없는 이름으로 바꾸면
  // 「채널토를」 같은 말이 남의 서비스 화면에 그대로 나간다 — 이 레포가 두 번 겪은 함정이다
  // (「봇로」 · 「널널투어은」). 조사를 고르는 로직을 두는 대신 이름 쪽을 고정한다.
  const 받침있음 = (name: string) => {
    const last = name.trim().at(-1)!;
    const code = last.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return false; // 한글 음절이 아니면 판정 불가
    return (code - 0xac00) % 28 !== 0;
  };

  it('모든 입구 이름이 받침으로 끝난다', () => {
    for (const name of Object.values(ENTRANCE_NAME)) {
      expect(받침있음(name), `「${name}」 뒤에 「을」·「으로」를 붙이면 깨진다`).toBe(true);
    }
  });
});

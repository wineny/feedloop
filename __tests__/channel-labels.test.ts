import { describe, it, expect } from 'vitest';
import { SOURCE_LABEL, PERSON_LABEL, sourceLabel, personLabel } from '@/lib/channel/labels';

describe('sourceLabel — 입구 이름', () => {
  it('세 입구를 전부 한국어로 부른다', () => {
    expect(sourceLabel('web')).toBe('웹 위젯');
    expect(sourceLabel('kakao')).toBe('카카오톡');
    // 이 한 줄이 없어서 「피드백」 탭이 raw `channel` 을 찍고 있었다.
    expect(sourceLabel('channel')).toBe('채널톡');
  });

  it('모르는 입구는 원문 그대로 — 라벨을 안 더했다는 신호가 남는다', () => {
    expect(sourceLabel('discord')).toBe('discord');
    expect(sourceLabel('')).toBe('');
  });
});

describe('personLabel — 그 입구의 사람 호칭', () => {
  it('카카오·채널톡은 전용 호칭, 웹은 방문자', () => {
    expect(personLabel('kakao')).toBe('카카오 사용자');
    // 이분법이던 시절 채널톡 이용자가 「방문자」로 불렸다.
    expect(personLabel('channel')).toBe('고객');
    expect(personLabel('web')).toBe('방문자');
  });

  it('모르는 입구도 방문자로 부른다 — 이름 자리가 비면 안 된다', () => {
    expect(personLabel('discord')).toBe('방문자');
  });
});

describe('두 맵이 함께 자란다', () => {
  it('사람 호칭이 있는 입구는 입구 이름도 있다', () => {
    // 한쪽에만 더하면 화면 절반이 raw 값으로 돌아간다 — 이 파일을 만든 이유가 그 사고다.
    for (const source of Object.keys(PERSON_LABEL)) {
      expect(SOURCE_LABEL[source]).toBeTruthy();
    }
  });
});

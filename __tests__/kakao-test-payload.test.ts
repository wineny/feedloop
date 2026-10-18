import { describe, it, expect } from 'vitest';
import { isOpenBuilderTest } from '@/lib/bot/kakao-test-payload';

// 오픈빌더 스킬 화면의 「스킬서버로 전송」 이 보내는 payload (02-skill-create.png 의 JSON 미리보기).
const TEST_PAYLOAD = {
  intent: { id: '6b2lkk3oa8bjdlioikd9ock1', name: '블록 이름' },
  userRequest: {
    timezone: 'Asia/Seoul',
    params: { ignoreMe: 'true' },
    block: { id: '6b2lkk3oa8bjdlioikd9ock1', name: '블록 이름' },
    utterance: '발화 내용',
    lang: null,
    user: { id: '사용자 ID', type: 'botUserKey', properties: {} },
  },
  bot: { id: '6a9ba1c445fea95c7b4244ea', name: '봇 이름' },
};

// 프로덕션에 실제로 도달한 요청의 모양 (botUserKey 는 66자리 문자열).
const REAL_PAYLOAD = {
  userRequest: {
    timezone: 'Asia/Seoul',
    params: {},
    block: { id: 'fallback-block-id', name: '폴백 블록' },
    utterance: '예약 화면에서 날짜가 안 눌려요',
    user: { id: '031a83d2'.padEnd(66, '0'), type: 'botUserKey', properties: {} },
  },
};

describe('isOpenBuilderTest', () => {
  it('오픈빌더 테스트 요청을 잡아낸다', () => {
    expect(isOpenBuilderTest(TEST_PAYLOAD)).toBe(true);
  });

  it('실사용자 요청은 통과시킨다', () => {
    expect(isOpenBuilderTest(REAL_PAYLOAD)).toBe(false);
  });

  it('ignoreMe 를 지워도 플레이스홀더 발화로 잡는다', () => {
    const payload = {
      userRequest: { ...TEST_PAYLOAD.userRequest, params: {} },
    };
    expect(isOpenBuilderTest(payload)).toBe(true);
  });

  it('발화만 바꿔 테스트해도 플레이스홀더 사용자 ID 로 잡는다', () => {
    const payload = {
      userRequest: { ...TEST_PAYLOAD.userRequest, params: {}, utterance: '안녕하세요' },
    };
    expect(isOpenBuilderTest(payload)).toBe(true);
  });

  it('userRequest 가 없으면 테스트로 보지 않는다', () => {
    expect(isOpenBuilderTest({})).toBe(false);
  });

  it('실사용자가 우연히 자리표시자와 같은 블록명을 쓰지 않는 한 오탐하지 않는다', () => {
    const payload = {
      userRequest: {
        params: { sys_text: '값' },
        block: { name: '피드백 수집' },
        utterance: '블록 이름이 뭐예요?',
        user: { id: 'a'.repeat(66) },
      },
    };
    expect(isOpenBuilderTest(payload)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  onboardingSteps,
  shouldShowOnboarding,
  type OnboardingFacts,
  type OnboardingStepKey,
} from '@/lib/dashboard/onboarding';

const NEW_BOT: OnboardingFacts = {
  channelConnected: false,
  feedbackCount: 0,
  githubConnected: false,
  prCount: 0,
};

const doneKeys = (facts: OnboardingFacts): OnboardingStepKey[] =>
  onboardingSteps(facts, null).filter((step) => step.done).map((step) => step.key);

describe('첫 사용 체크리스트 — 단계 판정', () => {
  it('네 단계를 정해진 순서로 세운다', () => {
    expect(onboardingSteps(NEW_BOT, null).map((step) => [step.order, step.key])).toEqual([
      [1, 'connect'],
      [2, 'feedback'],
      [3, 'github'],
      [4, 'pr'],
    ]);
  });

  it('갓 만든 봇은 아무것도 끝나지 않았다', () => {
    expect(doneKeys(NEW_BOT)).toEqual([]);
  });

  it('입구가 하나라도 연결되면 ① 이 끝난다', () => {
    expect(doneKeys({ ...NEW_BOT, channelConnected: true })).toEqual(['connect']);
  });

  it('제보가 들어오면 ② 가 끝난다', () => {
    expect(doneKeys({ ...NEW_BOT, feedbackCount: 1 })).toEqual(['feedback']);
  });

  it('레포가 지정되면 ③ 이 끝난다', () => {
    expect(doneKeys({ ...NEW_BOT, githubConnected: true })).toEqual(['github']);
  });

  it('PR 이 하나라도 만들어지면 ④ 가 끝난다', () => {
    expect(doneKeys({ ...NEW_BOT, prCount: 1 })).toEqual(['pr']);
  });

  it('단계는 서로 독립이다 — 앞 단계를 건너뛰어도 뒤 단계가 끝날 수 있다', () => {
    expect(doneKeys({ channelConnected: true, feedbackCount: 0, githubConnected: true, prCount: 0 })).toEqual([
      'connect',
      'github',
    ]);
  });

  it('봇이 하나로 좁혀지면 그 봇의 설정 화면으로 보낸다', () => {
    const steps = onboardingSteps(NEW_BOT, 'bot-1');
    expect(steps[0].href).toBe('/bots/bot-1/connect?via=widget');
    expect(steps[2].href).toBe('/bots/bot-1/knowledge?tab=github');
    expect(steps[1].href).toBe('/inbox');
    expect(steps[3].href).toBe('/monitor');
  });

  it('어느 봇인지 모르면 목록으로 보낸다 — 없는 주소를 만들지 않는다', () => {
    const steps = onboardingSteps(NEW_BOT, null);
    expect(steps[0].href).toBe('/bots');
    expect(steps[2].href).toBe('/bots');
  });
});

describe('첫 사용 체크리스트 — 숨김 조건', () => {
  it('제보가 0 이고 남은 단계가 있으면 보인다', () => {
    expect(shouldShowOnboarding(NEW_BOT)).toBe(true);
    expect(shouldShowOnboarding({ ...NEW_BOT, channelConnected: true })).toBe(true);
  });

  it('제보가 한 건이라도 들어오면 숨는다 — 이미 루프를 돌리는 계정이다', () => {
    expect(shouldShowOnboarding({ ...NEW_BOT, feedbackCount: 1 })).toBe(false);
  });

  it('네 단계가 전부 끝나면 숨는다', () => {
    expect(
      shouldShowOnboarding({ channelConnected: true, feedbackCount: 3, githubConnected: true, prCount: 2 }),
    ).toBe(false);
  });
});

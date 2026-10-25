import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { renderWithIntl } from './helpers/intl';
import {
  onboardingSteps,
  paypalStepFacts,
  shouldShowOnboarding,
  type OnboardingFacts,
  type OnboardingStepKey,
} from '@/lib/dashboard/onboarding';

const NEW_BOT: OnboardingFacts = {
  channelConnected: false,
  feedbackCount: 0,
  githubConnected: false,
  prCount: 0,
  paypalConnected: false,
};

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const doneKeys = (facts: OnboardingFacts): OnboardingStepKey[] =>
  onboardingSteps(facts, null).filter((step) => step.done).map((step) => step.key);

describe('첫 사용 체크리스트 — 단계 판정', () => {
  it('네 단계 + 맨 끝 선택 단계(PayPal)를 정해진 순서로 세운다', () => {
    expect(onboardingSteps(NEW_BOT, null).map((step) => [step.order, step.key, Boolean(step.optional)])).toEqual([
      [1, 'connect', false],
      [2, 'feedback', false],
      [3, 'github', false],
      [4, 'pr', false],
      [5, 'paypal', true],
    ]);
  });

  it('PayPal 이 연결되면 ⑤ 가 끝난다', () => {
    expect(doneKeys({ ...NEW_BOT, paypalConnected: true })).toEqual(['paypal']);
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
    expect(doneKeys({ channelConnected: true, feedbackCount: 0, githubConnected: true, prCount: 0, paypalConnected: false })).toEqual([
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
    expect(steps[4].href).toBe('/bots/bot-1/paypal');
  });

  it('어느 봇인지 모르면 목록으로 보낸다 — 없는 주소를 만들지 않는다', () => {
    const steps = onboardingSteps(NEW_BOT, null);
    expect(steps[0].href).toBe('/bots');
    expect(steps[2].href).toBe('/bots');
    expect(steps[4].href).toBe('/bots');
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
      shouldShowOnboarding({ channelConnected: true, feedbackCount: 3, githubConnected: true, prCount: 2, paypalConnected: false }),
    ).toBe(false);
  });

  it('선택 단계(PayPal)는 숨김 판정에 안 든다 — 어떤 조합이든 PayPal 연결 여부로 결과가 바뀌지 않는다', () => {
    for (const channelConnected of [false, true])
      for (const feedbackCount of [0, 1])
        for (const githubConnected of [false, true])
          for (const prCount of [0, 1]) {
            const base = { channelConnected, feedbackCount, githubConnected, prCount };
            expect(shouldShowOnboarding({ ...base, paypalConnected: true })).toBe(shouldShowOnboarding({ ...base, paypalConnected: false }));
          }
  });

  it('피드백만 쓰는 계정의 판정은 PayPal 연결 여부와 무관하다', () => {
    for (const paypalConnected of [false, true]) {
      expect(shouldShowOnboarding({ ...NEW_BOT, paypalConnected })).toBe(true);
      expect(shouldShowOnboarding({ ...NEW_BOT, feedbackCount: 1, paypalConnected })).toBe(false);
      expect(shouldShowOnboarding({ ...NEW_BOT, channelConnected: true, paypalConnected })).toBe(true);
    }
  });
});

describe('첫 사용 체크리스트 — 화면', () => {
  const render = (facts: OnboardingFacts, locale: 'en' | 'ko' = 'en') =>
    renderWithIntl(React.createElement(OnboardingChecklist, { steps: onboardingSteps(facts, 'bot-1') }), locale);

  it('마지막 줄이 「Connect PayPal (optional)」이고 PayPal 탭으로 간다', () => {
    const html = render(NEW_BOT);
    expect(html).toContain('Connect PayPal (optional)');
    expect(html).toContain('href="/bots/bot-1/paypal"');
    expect(html.indexOf('First fix PR')).toBeLessThan(html.indexOf('Connect PayPal (optional)'));
    expect(render(NEW_BOT, 'ko')).toContain('PayPal 연결 (선택)');
  });

  it('PayPal 이 연결되면 그 줄은 「Done」이고, 진행 수(n/4)는 선택 단계를 세지 않는다', () => {
    const html = render({ ...NEW_BOT, paypalConnected: true });
    expect(html).not.toContain('href="/bots/bot-1/paypal"');
    expect(html).toContain('0/4 steps');
    expect(render({ ...NEW_BOT, channelConnected: true, paypalConnected: true })).toContain('1/4 steps');
  });
});

describe('첫 사용 체크리스트 — ⑤ PayPal 재료(paypalStepFacts)', () => {
  const PAY = { connected: false, connectBotId: null as string | null };

  it('내 봇은 연결 안 됐고 승인자로 들어간 봇만 연결됐다 → 안 끝남, 링크는 내 봇', () => {
    const facts = paypalStepFacts({ connected: true, connectBotId: 'own-bot' });
    expect(facts).toEqual({ paypalConnected: false, paypalBotId: 'own-bot' });
    const step = onboardingSteps({ ...NEW_BOT, paypalConnected: facts.paypalConnected }, null, facts.paypalBotId)[4];
    expect(step.done).toBe(false);
    expect(step.href).toBe('/bots/own-bot/paypal');
  });

  it('연결할 내 봇이 남지 않았고 연결된 봇이 있다 → 끝남', () => {
    expect(paypalStepFacts({ connected: true, connectBotId: null })).toEqual({ paypalConnected: true, paypalBotId: null });
  });

  it('아무것도 연결 안 됨 / payments 없음 → 안 끝남, 링크는 기존 규칙', () => {
    expect(paypalStepFacts({ ...PAY, connectBotId: 'bot-1' })).toEqual({ paypalConnected: false, paypalBotId: 'bot-1' });
    expect(paypalStepFacts(undefined)).toEqual({ paypalConnected: false, paypalBotId: null });
    expect(onboardingSteps(NEW_BOT, 'bot-9', null)[4].href).toBe('/bots/bot-9/paypal');
  });

  it('체크리스트 봇과 연결할 봇이 다르면 연결할 봇이 이긴다', () => {
    expect(onboardingSteps(NEW_BOT, 'bot-9', 'own-bot')[4].href).toBe('/bots/own-bot/paypal');
  });
});

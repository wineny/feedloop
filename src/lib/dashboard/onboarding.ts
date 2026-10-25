// 첫 사용 체크리스트(F6) — 아직 제보가 한 건도 없는 계정에게 「다음에 뭘 하면 되는지」를 말한다.
//
// 빈 대시보드는 0 을 네 개 보여줄 뿐 다음 할 일을 말하지 않는다. 그래서 루프를 한 바퀴 돌리는 데
// 필요한 네 가지만 순서대로 세운다: 스크립트 → 첫 제보 → GitHub → 첫 PR.
//
// ── 판정 재료 (전부 이미 있는 값이다. 이걸 위해 새로 저장하는 상태는 없다) ──
//   ① 스크립트 붙이기  = 입구 연결 시각(`bots.widget_connected_at` · `channel_connected_at`)
//   ② 첫 제보 보내보기 = 들어온 피드백 수(통계의 `collected`)
//   ③ GitHub 연결      = 고칠 레포가 지정돼 있나(`bots.github_repo_url` 유무 → API 가 불리언으로만 내려준다)
//   ④ 첫 PR            = 만들어진 수정 PR 수(통계의 `prCreated`)
//   ⑤ PayPal 연결(선택) = 대시보드 `payments` 의 `connected` + `connectBotId`(`paypalStepFacts`). **선택 단계라 숨김 판정에 안 든다** —
//      피드백만 쓰는 계정이 PayPal 을 안 붙였다고 체크리스트가 계속 서 있으면 안 된다.

import type { DashboardPayments } from '@/app/api/dashboard/route';
import { paypalSettingsHref } from './payments';

export interface OnboardingFacts {
  /** 웹 위젯·채널톡 중 하나라도 연결됐나 */
  channelConnected: boolean;
  /** 들어온 피드백 수 */
  feedbackCount: number;
  /** 고칠 레포가 지정됐나 */
  githubConnected: boolean;
  /** 만들어진 수정 PR 수 */
  prCount: number;
  /** 내가 연결할 PayPal 이 남지 않았나(`paypalStepFacts`). 선택 단계 ⑤ 에만 쓴다 */
  paypalConnected: boolean;
}

export type OnboardingStepKey = 'connect' | 'feedback' | 'github' | 'pr' | 'paypal';

export interface OnboardingStep {
  key: OnboardingStepKey;
  /** 화면에 찍는 순번 1~5 */
  order: number;
  /** 선택 단계 — 진행 수(n/4)와 숨김 판정에서 빠진다 */
  optional?: boolean;
  label: string;
  done: boolean;
  /** 그 일을 하러 가는 화면 */
  href: string;
  /** 링크 문구 — 동사로 끝낸다 */
  action: string;
}

/**
 * ⑤ 의 재료. `payments.connected` 는 «보고 있는 봇 중 하나라도» 연결됐다는 뜻이라, 승인자로 들어간
 * 데모 봇만 연결돼 있어도 참이 된다. 그래서 «내가 연결할 봇이 남지 않았을 때»(`connectBotId === null`)만 끝난 것으로 본다.
 * 링크는 그 연결 안 된 «내» 봇(`connectBotId`)으로 — 대시보드 「PayPal 연결하기」 카드와 같은 봇이다.
 */
export function paypalStepFacts(
  payments: Pick<DashboardPayments, 'connected' | 'connectBotId'> | null | undefined,
): { paypalConnected: boolean; paypalBotId: string | null } {
  return {
    paypalConnected: Boolean(payments?.connected && payments.connectBotId === null),
    paypalBotId: payments?.connectBotId ?? null,
  };
}

/**
 * 봇이 하나로 좁혀졌으면 그 봇의 설정 화면으로 곧장 보낸다.
 * 여러 서비스를 한꺼번에 보고 있으면 어느 봇인지 알 수 없어 목록으로 보낸다.
 * ⑤ 만 예외: 연결할 내 봇(`paypalBotId`, = `payments.connectBotId`)을 알면 그 봇의 PayPal 탭으로 보낸다.
 */
export function onboardingSteps(facts: OnboardingFacts, botId: string | null, paypalBotId: string | null = null): OnboardingStep[] {
  const botHref = (path: string) => (botId ? `/bots/${botId}${path}` : '/bots');

  return [
    {
      key: 'connect',
      order: 1,
      label: '스크립트 붙이기',
      done: facts.channelConnected,
      href: botHref('/connect?via=widget'),
      action: '연결하러 가기',
    },
    {
      key: 'feedback',
      order: 2,
      label: '첫 제보 보내보기',
      done: facts.feedbackCount > 0,
      // 제보는 운영자의 «자기 서비스» 에서 보낸다. 앱에서 할 수 있는 건 들어온 걸 보는 것뿐이라
      // 「대화」로 보낸다 — 여기에 쌓인다는 걸 보여주는 화면이다.
      href: '/inbox',
      action: '대화 열어보기',
    },
    {
      key: 'github',
      order: 3,
      label: 'GitHub 연결',
      done: facts.githubConnected,
      href: botHref('/knowledge?tab=github'),
      action: '저장소 연결하기',
    },
    {
      key: 'pr',
      order: 4,
      label: '첫 수정안',
      done: facts.prCount > 0,
      href: '/monitor',
      action: '수정안 보기',
    },
    {
      // 맨 끝·선택(ny 2026-10-22). PayPal 탭은 소유자 전용 — 체크리스트는 제보 0 인 자기 계정에만 선다.
      key: 'paypal',
      order: 5,
      label: 'PayPal 연결 (선택)',
      done: facts.paypalConnected,
      href: paypalBotId ? paypalSettingsHref(paypalBotId) : botHref('/paypal'),
      action: 'PayPal 연결하기',
      optional: true,
    },
  ];
}

/**
 * 숨김 조건: 제보가 한 건이라도 들어왔거나(이미 루프를 돌리고 있는 계정이다) 네 단계가 전부 끝났다.
 * 선택 단계(⑤ PayPal)는 보지 않는다 — 그것 하나 때문에 체크리스트가 남지 않게.
 *
 * 지금은 ②가 「제보 ≥ 1」이라 두 조건이 사실상 같은 말이다 — 그래도 둘 다 적어 둔다.
 * ②의 정의가 나중에 바뀌어도(예: 테스트 제보만 세기) 숨김 규칙이 따라 움직이게.
 */
export function shouldShowOnboarding(facts: OnboardingFacts): boolean {
  if (facts.feedbackCount > 0) return false;
  return !onboardingSteps(facts, null).every((step) => step.optional || step.done);
}

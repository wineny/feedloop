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

export interface OnboardingFacts {
  /** 웹 위젯·채널톡 중 하나라도 연결됐나 */
  channelConnected: boolean;
  /** 들어온 피드백 수 */
  feedbackCount: number;
  /** 고칠 레포가 지정됐나 */
  githubConnected: boolean;
  /** 만들어진 수정 PR 수 */
  prCount: number;
}

export type OnboardingStepKey = 'connect' | 'feedback' | 'github' | 'pr';

export interface OnboardingStep {
  key: OnboardingStepKey;
  /** 화면에 찍는 순번 1~4 */
  order: number;
  label: string;
  done: boolean;
  /** 그 일을 하러 가는 화면 */
  href: string;
  /** 링크 문구 — 동사로 끝낸다 */
  action: string;
}

/**
 * 봇이 하나로 좁혀졌으면 그 봇의 설정 화면으로 곧장 보낸다.
 * 여러 서비스를 한꺼번에 보고 있으면 어느 봇인지 알 수 없어 목록으로 보낸다.
 */
export function onboardingSteps(facts: OnboardingFacts, botId: string | null): OnboardingStep[] {
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
  ];
}

/**
 * 숨김 조건: 제보가 한 건이라도 들어왔거나(이미 루프를 돌리고 있는 계정이다) 네 단계가 전부 끝났다.
 *
 * 지금은 ②가 「제보 ≥ 1」이라 두 조건이 사실상 같은 말이다 — 그래도 둘 다 적어 둔다.
 * ②의 정의가 나중에 바뀌어도(예: 테스트 제보만 세기) 숨김 규칙이 따라 움직이게.
 */
export function shouldShowOnboarding(facts: OnboardingFacts): boolean {
  if (facts.feedbackCount > 0) return false;
  return !onboardingSteps(facts, null).every((step) => step.done);
}

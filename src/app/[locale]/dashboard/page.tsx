'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { scopedBody, scopedUrl } from '@/lib/scope/scope';
import { ScopeNote } from '@/components/layout/BotScopeSelect';
import { LoopStages } from '@/components/dashboard/LoopStages';
import { LoopQuality } from '@/components/dashboard/LoopQuality';
import type { LoopTimeStats } from '@/lib/dashboard/loop-time';
import type { ConfirmationStats } from '@/lib/dashboard/confirmation';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { onboardingSteps, paypalStepFacts, shouldShowOnboarding, type OnboardingFacts } from '@/lib/dashboard/onboarding';
import { ChannelIntegration } from '@/components/dashboard/ChannelIntegration';
import { RecentFeedback, type FeedbackItem } from '@/components/dashboard/RecentFeedback';
import { LoopActivityFeed, type LoopEvent } from '@/components/dashboard/LoopActivityFeed';
import { InsightGroups, type GroupSummary } from '@/components/dashboard/InsightGroups';
import { PaymentStats } from '@/components/dashboard/PaymentStats';
import { PaymentLedger } from '@/components/dashboard/PaymentLedger';
import type { LedgerRow } from '@/lib/paypal/ledger';
import type { DashboardPayments } from '@/app/api/dashboard/route';
import type { GroupingStatus } from '@/lib/groups/grouping-status';
import { Button } from '@/components/ui/button';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { Loader2, Sparkles, RefreshCw } from 'lucide-react';
import { LoadingState, ErrorState } from '@/components/layout/PageState';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useDemoMode } from '@/lib/demo/useDemoMode';

interface LoopStats {
  collected: number;
  classified: number;
  prCreated: number;
  returned: number;
  returnQueued?: number;
  classification?: { done: number; pending: number; processing: number; failed: number; exhausted: number; eligible: number };
  /** 제보 → 반영 알림 평균 시간(C5). 표본이 없으면 화면이 「아직 없음」이라고 말한다 */
  loopTime?: LoopTimeStats;
  /** 되돌림 확인(F5) — 「잘 돼요」 비율과 응답률의 재료 */
  confirmation?: ConfirmationStats;
  /** 고칠 레포가 지정된 봇들의 id(F6 체크리스트 ③). 주소·토큰은 내려오지 않는다 */
  githubReadyBotIds?: string[];
}

interface DashboardData {
  stats: LoopStats;
  feedbacks: FeedbackItem[];
  events: LoopEvent[];
  /** PayPal 숫자·연결 상태. 예시 데이터(데모)는 연결된 봇의 예시 숫자를 싣는다. 401 빈 화면에는 없다 — 그때는 PayPal 줄을 안 그린다 */
  payments?: DashboardPayments;
}

interface DemoDashboard extends DashboardData {
  groups: GroupSummary[];
  /** 장부 예시 행. 데모에서는 /api/payments/ledger 를 부르지 않는다 */
  ledger: LedgerRow[];
  channels: { web: boolean; channel: boolean };
}

const EMPTY: DashboardData = {
  stats: { collected: 0, classified: 0, prCreated: 0, returned: 0 },
  feedbacks: [],
  events: [],
};

/** 부제는 형용사가 아니라 이번 루프의 사실을 말한다 */
type Translate = ReturnType<typeof useTranslations<'dashboard'>>;

function Subtitle({ stats }: { stats: LoopStats }) {
  const t = useTranslations('dashboard');
  if (stats.collected === 0) return <>{t('subtitleEmpty')}</>;
  return (
    <>
      {t.rich('subtitle', {
        received: stats.collected,
        returned: stats.returned,
        strong: (chunks) => <strong className="tabular-nums">{chunks}</strong>,
      })}
    </>
  );
}

/**
 * 칸 아래 보조 문구 — 실제로 아는 숫자만 쓴다.
 *
 * v4(2026-09-17): **0 인 항목은 말하지 않는다.** 예전엔 「대기 3 · 처리 중 0 · 실패 0 · 한도 도달 0」
 * 처럼 네 가지를 늘 나열해서, 아무 일도 없는 평상시에 0 이 세 개씩 붙고 390px 에서 두 줄로 접혔다.
 * 전부 0 이면 「다 처리했어요」 한마디가 같은 사실을 더 잘 말한다.
 */
function tileNotes(stats: LoopStats, groups: GroupSummary[], t: Translate) {
  const classification = stats.classification;
  const merged = groups.filter((g) => g.pr?.mergedAt).length;
  const open = groups.filter((g) => g.pr && !g.pr.mergedAt).length;

  let classified: string;
  if (!classification) {
    classified = t('notes.unknown');
  } else {
    const parts = [
      classification.pending > 0 ? t('notes.pending', { count: classification.pending }) : null,
      classification.processing > 0 ? t('notes.processing', { count: classification.processing }) : null,
      classification.failed > 0 ? t('notes.failed', { count: classification.failed }) : null,
      classification.exhausted > 0 ? t('notes.exhausted', { count: classification.exhausted }) : null,
    ].filter((v): v is string => v !== null);
    classified = parts.length > 0 ? parts.join(' · ') : t('notes.none');
  }

  return {
    classified,
    returned: (stats.returnQueued ?? 0) > 0 ? t('notes.returnQueued', { count: stats.returnQueued ?? 0 }) : undefined,
    prCreated: stats.prCreated > 0 ? (open > 0 ? t('notes.prShippedOpen', { merged, open }) : t('notes.prShipped', { merged })) : undefined,
  };
}

// 「머지 확인」이 오래 걸릴 때의 안내. 두 화면(대시보드·수정 PR)이 같은 문구를 쓰지만
// 공용 훅으로 빼지 않는다 — 이 두 파일은 디자인 세션도 만지고 있어 충돌면을 넓히지 않는다.

interface MergeCheckResult {
  delivered?: number;
  merged?: number;
  /** 전송 예산이 끝나 이번엔 못 보낸 되돌림. 다음 확인·다음 발화에 회수된다. */
  deferred?: number;
  /** 루프 마감에 걸려 GitHub 을 조회조차 못 한 실행. */
  skipped?: number;
  /**
   * 확인하다 던진 실행. `deferred`(다음에 보냄)·`skipped`(다음에 봄)와 **다르다** —
   * 저 둘은 기다리면 되고, 이건 사람이 원인을 봐야 한다. 한 숫자로 접으면 안 된다.
   */
  failed?: number;
}

function mergeResultNotice(json: MergeCheckResult, t: Translate): string {
  const delivered = json.delivered ?? 0;
  const merged = json.merged ?? 0;
  const deferred = json.deferred ?? 0;
  const skipped = json.skipped ?? 0;
  const failed = json.failed ?? 0;

  // 실패부터 말한다 — 다른 숫자에 묻히면 아무도 원인을 보러 가지 않는다.
  if (failed > 0) return t('merge.failed', { count: failed });

  const parts = [
    delivered > 0
      ? t('merge.delivered', { count: delivered })
      : merged > 0
        // 머지 ≠ 배포 ≠ 해결. 되돌림이 안 나갔다고 「끝났다」고 말하면 안 된다.
        ? t('merge.already')
        : t('merge.none'),
  ];
  if (deferred > 0) parts.push(t('merge.deferred', { count: deferred }));
  if (skipped > 0) parts.push(t('merge.skipped', { count: skipped }));
  return parts.join(' · ');
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { status: authStatus } = useSession();
  const demo = useDemoMode<DemoDashboard>('dashboard');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [grouping, setGrouping] = useState<GroupingStatus | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [checkingMerge, setCheckingMerge] = useState(false);
  const [mergeElapsed, setMergeElapsed] = useState(0);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  // 봇 목록·선택은 헤더 셀렉터와 같은 출처(I-27). 예전엔 이 화면이 /api/bots 를 따로 읽었다.
  const scope = useBotScope();
  const botId = scope.botId;

  // 봇이 하나도 없으면 등록 화면으로. 목록을 «성공적으로 읽은 뒤»에만 판정한다 — 읽기 전이나
  // 순간 장애(500·401)의 빈 배열로 보내면 봇이 멀쩡한 계정이 등록 화면으로 튕긴다(종전 코드도 실패면 아무것도 안 했다).
  useEffect(() => {
    if (authStatus === 'authenticated' && scope.listOk && scope.bots.length === 0) {
      router.replace('/bots/new');
    }
  }, [authStatus, scope.listOk, scope.bots.length, router]);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch(scopedUrl('/api/groups', botId));
      if (!res.ok) return;
      const json = await res.json();
      setGroups(json.groups ?? []);
      setGrouping(json.grouping ?? null);
    } catch {
      // 묶음 조회 실패가 대시보드 전체를 막지 않는다
    }
  }, [botId]);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(scopedUrl('/api/dashboard', botId));

      if (res.status === 401) {
        setData(EMPTY);
        return;
      }

      if (!res.ok) throw new Error(t('errors.api', { status: res.status }));
      setData(await res.json());
      await fetchGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.load'));
    } finally {
      setLoading(false);
    }
  }, [botId, fetchGroups, t]);

  // 스코프가 바뀌면 옛 숫자를 새 스코프 이름 밑에 두지 않는다 — 대시보드 조회는 몇 초 걸린다.
  useEffect(() => {
    setLoading(true);
  }, [botId]);

  // 스코프가 바뀌면 다시 읽는다. `scope.ready` 전엔 저장된 선택이 아직 유효한지 몰라 기다린다.
  useEffect(() => {
    if (authStatus === 'authenticated') {
      if (scope.ready) void fetchData();
    } else if (authStatus === 'unauthenticated') {
      setData(EMPTY);
      setLoading(false);
    }
  }, [authStatus, scope.ready, fetchData]);

  // 분류를 돌리고 같은 화면에서 숫자가 오르는 걸 보여준다.
  const handleClassify = async () => {
    setClassifying(true);
    try {
      const response = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scopedBody({}, botId)),
      });
      if (!response.ok) throw new Error(t('errors.classify'));
      await fetchData();
    } catch (err) {
      setMergeNotice(err instanceof Error ? err.message : t('errors.classifyShort'));
    } finally {
      setClassifying(false);
    }
  };

  // 크론(하루 1회)을 기다리지 않고 지금 머지를 확인한다. 시연용이자 크론 실패 시 폴백.
  const handleCheckMerged = async () => {
    // 연습용 화면 — GitHub 에 나갈 것이 없다. 예시 PR 은 이미 머지 여부가 정해져 있어
    // 「새로 머지된 건 없다」가 사실 그대로다. 거짓으로 숫자를 올리지 않는다.
    if (demo.isDemo) {
      setMergeNotice(t('merge.demo'));
      return;
    }

    setCheckingMerge(true);
    setMergeNotice(null);
    setMergeElapsed(0);

    // 최악 116초까지 걸린다(PR 마다 GitHub 왕복 + 채널톡 되돌림 전송). 스피너만 돌면
    // 시연 중에 「멈춘 것」으로 보인다 — 몇 초째인지, 왜 오래 걸리는지를 말해 준다.
    const started = Date.now();
    const tick = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      setMergeElapsed(secs);
      if (secs >= 10) setMergeNotice(t('slowMerge'));
    }, 1000);

    try {
      const res = await fetch('/api/loop/check-merged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scopedBody({}, botId)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.check'));
      setMergeNotice(mergeResultNotice(json, t));
      await fetchData();
    } catch (err) {
      setMergeNotice(err instanceof Error ? err.message : t('errors.check'));
    } finally {
      clearInterval(tick);
      setCheckingMerge(false);
      setMergeElapsed(0);
    }
  };

  if (!demo.isDemo && (authStatus === 'loading' || loading)) {
    return <LoadingState />;
  }

  if (!demo.isDemo && error) {
    return <ErrorState message={error} onRetry={() => { setLoading(true); fetchData(); }} />;
  }

  const { stats, feedbacks, events, payments } = demo.isDemo ? demo.data : (data ?? EMPTY);
  const shownGroups = demo.isDemo ? demo.data.groups : groups;
  // 「피드백 채널」 판정 — /bots 와 같은 기준(widget/channel_connected_at).
  // 스코프가 있으면 그 봇만, 전체면 하나라도 켜지면 켜짐.
  const scopedBots = botId ? scope.bots.filter((b) => b.id === botId) : scope.bots;
  const webOn = demo.isDemo ? demo.data.channels.web : scopedBots.some((b) => Boolean(b.widget_connected_at));
  const channelOn = demo.isDemo ? demo.data.channels.channel : scopedBots.some((b) => Boolean(b.channel_connected_at));

  // 첫 사용 체크리스트(F6) — 판정 재료는 이미 화면에 있는 값뿐이다. 새로 부르는 API 는 없다.
  //
  // 봇 하나로 좁혀졌을 때만 그 봇의 설정 화면으로 곧장 보낸다(스코프 선택 또는 봇이 하나뿐).
  const checklistBotId = botId ?? (scope.bots.length === 1 ? scope.bots[0].id : null);
  const checklistBot = checklistBotId ? scope.bots.find((b) => b.id === checklistBotId) ?? null : null;
  // ⑤ 선택 단계 — `payments` 에 이미 있는 값(새 API 호출 없음). 승인자 봇의 연결로 끝난 것처럼 보이지 않게
  // 「연결할 내 봇이 남지 않음」으로 보고, 링크는 그 내 봇으로(`paypalStepFacts` 주석).
  const paypalStep = paypalStepFacts(payments);
  // ①·③ 은 **그 봇의 사실**로 본다. 「어느 봇이든 하나 되어 있음」으로 보면 봇이 여럿인 계정에서
  // A 봇 때문에 B 봇의 단계가 완료로 보인다. 어느 봇인지 모를 때만(봇 여럿 + 전체 보기)
  // 합쳐서 본다 — 그 화면의 숫자(제보·PR)도 어차피 합계라 기준이 일관된다.
  const onboardingFacts: OnboardingFacts = {
    channelConnected: checklistBot
      ? Boolean(checklistBot.widget_connected_at || checklistBot.channel_connected_at)
      : webOn || channelOn,
    feedbackCount: stats.collected,
    githubConnected: checklistBotId
      ? (stats.githubReadyBotIds ?? []).includes(checklistBotId)
      : (stats.githubReadyBotIds ?? []).length > 0,
    prCount: stats.prCreated,
    paypalConnected: paypalStep.paypalConnected,
  };
  // 데모(비로그인)는 제보 47건이라 어차피 숨는다. 심사자가 보는 기본 화면에 「아직 아무것도
  // 안 했다」는 안내를 세우지 않는 편이 맞아 데모에서도 그대로 둔다.
  const showChecklist = !demo.isDemo && authStatus === 'authenticated' && shouldShowOnboarding(onboardingFacts);

  return (
    <div className="flex flex-col gap-10 sm:gap-12">
      <PageHero
        emoji={PAGE_EMOJI.dashboard}
        title={t('title')}
        description={<><ScopeNote /><Subtitle stats={stats} /></>}
        actions={
          <>
            <Button variant="outline" onClick={handleCheckMerged} disabled={checkingMerge}>
              {checkingMerge ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {checkingMerge ? t('checking', { seconds: mergeElapsed }) : t('checkMerged')}
            </Button>
            <Button
              onClick={handleClassify}
              disabled={demo.isDemo || classifying || (stats.classification?.eligible ?? 0) === 0}
            >
              {classifying ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {t('runClassify')}
            </Button>
          </>
        }
      />

      {mergeNotice && <p className="-mt-4 text-[12.5px] text-muted-foreground">{mergeNotice}</p>}

      {/* PayPal 은 두 자리에 나뉜다(ny 2026-10-22). 연결된 봇의 숫자 3칸은 맨 첫 줄 — 체크리스트보다 위.
          「PayPal 연결하기」 카드는 체크리스트 «아래» — PayPal 은 선택 단계라 「첫 루프」 안내를 밀어내지 않는다
          (체크리스트에도 마지막 단계로 들어간다 — 체크리스트가 서 있는 동안은 카드를 내린다). 어느 쪽을 그릴지는 `paymentsLayout`. */}
      <PaymentStats
        payments={payments}
        placement="numbers"
        ledger={
          // key = 스코프: 봇을 바꾸면 옛 봇의 장부 줄을 새 이름 밑에 두지 않는다. 결정하면 숫자(승인 대기)도 다시 읽는다.
          <PaymentLedger key={botId ?? 'all'} botId={botId} demoRows={demo.isDemo ? demo.data.ledger : null} onChanged={fetchData} />
        }
      />

      {showChecklist && <OnboardingChecklist steps={onboardingSteps(onboardingFacts, checklistBotId, paypalStep.paypalBotId)} />}

      <PaymentStats payments={payments} placement="connect" checklistVisible={showChecklist} />

      {/* 루프 단계는 «화면 전체 폭»을 쓴다 — 이 화면이 크게 말하는 한 가지라서,
          사이드 칼럼 옆에 끼워 넣으면 그 음량이 나오지 않는다. */}
      <LoopStages stats={stats} notes={tileNotes(stats, shownGroups, t)} />

      {/* 본문 | 사이드 320. 루프 단계가 위로 빠져 본문이 660 → 유동으로 넓어졌다 */}
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="flex min-w-0 flex-col gap-12">
          {/* 루프의 «질» 두 칸. 체크리스트가 서 있는 동안(제보 0)에는 내린다 — 「아직 없음」 두 칸을
              더 얹으면 0 이 네 개인 화면을 고치려던 취지와 정반대가 된다. */}
          {!showChecklist && <LoopQuality loopTime={stats.loopTime} confirmation={stats.confirmation} />}
          {/* 분류가 밀렸을 때만 나타나는 줄. 맨 글자 링크로 띄워 두면 어디에 속한 말인지 모르겠어서
              옅은 브랜드 바탕 한 줄로 묶었다 — 「지금 처리할 것이 있다」는 알림이지 목차가 아니다. */}
          {stats.classification && (stats.classification.failed > 0 || stats.classification.exhausted > 0 || stats.classification.processing > 0 || stats.classification.pending > 0) && (
            <Link
              href="/classify"
              className="flex items-center justify-between gap-3 rounded-2xl bg-brand-subtle px-5 py-3.5 text-sm font-semibold text-brand-strong transition-colors hover:bg-primary-tint-hover"
            >
              <span>{t('stuck')}</span>
              <span className="shrink-0 text-[12.5px] font-semibold">{t('stuckCta')}</span>
            </Link>
          )}
          <InsightGroups groups={shownGroups} demo={demo.isDemo} onChanged={fetchGroups} grouping={grouping} />
          <RecentFeedback feedbacks={feedbacks} />
        </main>

        <aside className="flex min-w-0 flex-col gap-6">
          <ChannelIntegration webOn={webOn} channelOn={channelOn} />
          <LoopActivityFeed events={events} limit={5} />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t.rich('modeNote', { b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b> })}
          </p>
        </aside>
      </div>
    </div>
  );
}

'use client';

// 피드백 묶음 — 같은 문제를 말한 사람들을 하나로 모아 PR 한 개로 고친다.
// 여기가 "몇 건"이 아니라 "몇 명"을 보여주는 자리다.
// v4: 목록 전체를 카드 하나(`.card-surface`)에 담고 행은 헤어라인으로만 가른다 — 행마다 카드를 주면
// 「SaaS 카드 키트」가 된다. 주 CTA(브랜드 채움)는 페이지에 하나뿐이라 행마다 붙는 「PR 만들기」는
// 테두리 알약으로 둔다. 제목 옆 설명문은 걷어냈다 — 지금 상태는 아래 `GroupingStatusLine` 한 줄이 말한다.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useDemoContext } from '@/lib/demo/DemoProvider';
import { DemoHint } from '@/components/demo/DemoHint';
import { SectionTitle } from '@/components/layout/SectionTitle';
import { Loader2, GitPullRequest, Check, ChevronRight, FileText, TriangleAlert } from 'lucide-react';
import { groupAction } from '@/lib/groups/policy';
import { GroupingStatusLine } from '@/components/groups/GroupingStatusLine';
import { SpecDraft } from '@/components/dashboard/SpecDraft';
import type { GroupingStatus } from '@/lib/groups/grouping-status';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { scopedBody } from '@/lib/scope/scope';
import { dynamicT } from '@/i18n/dynamic';
import { ExternalLink } from '@/components/demo/ExternalLink';

export interface GroupSummary {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  createdAt: string;
  insightCount: number;
  conversationCount: number;
  pr: { url: string; number: number; mergedAt: string | null } | null;
  /** 기능 요청 묶음의 스펙 초안. 아직 안 만들었으면 null. */
  specDraft?: string | null;
  followUpPending?: boolean;
  /**
   * 우선순위. score = 사람 수×3 + 건수 + (핵심 흐름이 막혔으면 +20). 목록은 서버가 이미 이 순서로 준다 —
   * 화면에서 다시 정렬하지 않는다. core 는 결제·구매·예약·가입·로그인이 막혔나에 대한 AI 판단(null = 판단 전).
   * 2026-10-09 에 추가돼 구버전 응답·예전 예시 데이터에는 없다 — 옵셔널.
   */
  priority?: { score: number; core: boolean | null; reason: string | null };
}

interface InsightGroupsProps {
  groups: GroupSummary[];
  demo?: boolean;
  onChanged?: () => void;
  /** 자동 묶기 상태(I-10). GET /api/groups 의 `grouping`. 못 읽었으면 null. */
  grouping?: GroupingStatus | null;
}

/**
 * 데모(로그아웃 심사 화면)의 묶기 상태. 자동으로 묶이지는 않으므로 「곧 묶어요」라고 하지 않는다.
 *
 * 남은 건수는 «지금 화면에 있는 묶음»에서 되짚는다 — 고정값으로 두면 [지금 묶기]로 하나를 묶은
 * 뒤에도 「2건이 아직 안 묶였어요」가 그대로 남아, 한 화면 안에서 말이 어긋난다.
 */
function demoGroupingStatus(groups: GroupSummary[]): GroupingStatus {
  const pending = groups.some((g) => g.id === DEMO_NEW_GROUP_ID) ? 1 : 2;
  return { pending, dueAt: null, running: false, lastGroupedAt: null };
}

/** 연습용 화면에서 [지금 묶기]를 누르면 생기는 묶음. 두 번 눌러도 하나만 생기도록 id 를 고정한다. */
const DEMO_NEW_GROUP_ID = 'demo-group-3';

/**
 * 연습용 [지금 묶기]의 결과. 예시 분류 목록에 묶이지 않은 채 남아 있는 버그 제보
 * (「401 에러 후 무한 리다이렉트」)를 실제로 묶었을 때 나올 모양이다.
 * 시각은 만들 때 찍는다 — 고정 날짜를 박으면 「방금 묶었다」가 「3일 전」으로 읽힌다.
 */
function demoNewGroup(t: (key: string) => string): GroupSummary {
  return {
    id: DEMO_NEW_GROUP_ID,
    title: t('demoGroup.title'),
    summary: t('demoGroup.summary'),
    category: 'bug',
    status: 'open',
    createdAt: new Date().toISOString(),
    insightCount: 2,
    conversationCount: 2,
    pr: null,
    // 로그인이 막힌 문제라 핵심 흐름이다 — 2명×3 + 2건 + 20.
    priority: { score: 28, core: true, reason: t('demoGroup.reason') },
  };
}

/** 연습용 [PR 만들기]가 만드는 PR 번호의 밑값. 예시 PR 이 #128·#129 라 그 뒤에서 시작한다. */
const DEMO_PR_NUMBER = 130;

/**
 * 묶음마다 다른 PR 번호를 주기 위한 덧값.
 * 연습용 묶음 id 는 `demo-group-2` 처럼 끝에 숫자를 달고 있어 그걸 그대로 쓴다 —
 * PR 을 만들 수 있는 묶음이 둘 이상이라, 고정 번호를 쓰면 둘 다 같은 PR 을 가리킨다.
 */
function demoPrOffset(groupId: string): number {
  const n = Number(groupId.match(/(\d+)$/)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

// 배지는 잉크·코랄·회색 세 가지로만 — 색이 늘면 배지가 아니라 신호등이 된다.
const BADGE = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12.5px] font-semibold leading-[1.45]';

type Translate = ReturnType<typeof useTranslations<'dashboard.groups'>>;

function timeAgo(dateStr: string, t: Translate): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return t('ago.now');
  if (mins < 60) return t('ago.minutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('ago.hours', { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('ago.yesterday') : t('ago.days', { count: days });
}

export function InsightGroups({ groups, demo = false, onChanged, grouping = null }: InsightGroupsProps) {
  const t = useTranslations('dashboard.groups');
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openSpecId, setOpenSpecId] = useState<string | null>(null);
  // [지금 묶기]는 헤더 셀렉터의 스코프를 따른다(I-27) — 전체면 계정의 봇 전부를 돈다(종전 동작).
  const { botId } = useBotScope();
  /** 연습용 [지금 묶기]로 만든 묶음이 이미 있나 — 안내를 어디에 붙일지 정하는 기준. */
  const hasDemoGroup = groups.some((g) => g.id === DEMO_NEW_GROUP_ID);
  // 연습용 화면에서 누른 결과는 이 브라우저 탭 안에만 쌓인다(DemoProvider).
  // 묶음은 대시보드 데이터에, 만들어진 수정 PR 은 「수정 PR」 화면 데이터에 각각 붙어야 해서
  // 한 화면짜리 `useDemoMode` 대신 화면을 가로지르는 raw patch 를 쓴다.
  const { patch: patchDemo } = useDemoContext();
  const router = useRouter();

  // 연습용 [PR 만들기]는 1.5초 뒤에 화면을 옮긴다. 그 사이 사람이 스스로 다른 화면으로 가 있으면
  // 옮기지 않는다 — 보고 있던 화면에서 멋대로 끌려 나가는 게 더 나쁘다.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const handleRunGrouping = async () => {
    // 연습용 화면 — 묶지 않은 제보 하나를 그 자리에서 묶어 보여준다. 서버로는 안 나간다.
    if (demo) {
      if (groups.some((g) => g.id === DEMO_NEW_GROUP_ID)) {
        setNotice(t('notices.nothing'));
        return;
      }
      setRunning(true);
      setError(null);
      setNotice(null);
      // 진짜 묶기는 몇 초 걸린다. 즉시 끝나면 「뭔가 돌았다」가 안 읽혀서 같은 리듬으로 돈다.
      window.setTimeout(() => {
        patchDemo('dashboard', (prev) => {
          const d = prev as { groups: GroupSummary[] };
          if (d.groups.some((g) => g.id === DEMO_NEW_GROUP_ID)) return prev;
          return { ...d, groups: [demoNewGroup(dynamicT(t)), ...d.groups] };
        });
        setRunning(false);
        setNotice(t('notices.one'));
      }, 1200);
      return;
    }
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/groups/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scopedBody({}, botId)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.group'));
      // 0건이면 아무 말 없이 스피너만 멎어 「고장났나?」로 읽힌다. 묶기 대상은
      // bug·ux·feature_request 뿐이라, 문의·칭찬만 쌓인 봇은 **항상** 이 상태다.
      if (json.failures?.length) setError(t('errors.groupBots', { count: json.failures.length, reasons: json.failures.map((f: { reason: string }) => f.reason).join(', ') }));
      setNotice(
        json.busy && !json.grouped ? t('notices.busy')
          : json.deferred ? t('notices.deferred', { count: json.pending ?? 0 }) : json.grouped
          ? t('notices.grouped', { count: json.grouped })
          : t('notices.nothing'),
      );
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.group'));
    } finally {
      setRunning(false);
    }
  };

  const handleCreatePr = async (groupId: string) => {
    // 연습용 화면 — 진짜 엔진(99~135초)을 돌리는 대신, 그 결과로 나올 화면을 그 자리에서 만든다.
    // 묶음은 「PR 만들어짐」이 되고, 같은 PR 이 「수정 PR」 화면 맨 위에 생긴다. 그리고 그리로 데려간다.
    if (demo) {
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      setBusyId(groupId);
      setError(null);
      // 묶음마다 다른 번호·행 id 를 준다. 연습용 데이터에는 PR 을 만들 수 있는 묶음이 둘 이상이라
      // 고정 id 를 쓰면 수정 PR 목록에 같은 key 의 행이 두 개 생긴다.
      const prNumber = DEMO_PR_NUMBER + demoPrOffset(groupId);
      const runId = `demo-run-${groupId}`;
      const url = `https://github.com/example/feedloop-demo/pull/${prNumber}`;
      window.setTimeout(() => {
        patchDemo('dashboard', (prev) => {
          const d = prev as { groups: GroupSummary[] };
          return {
            ...d,
            groups: d.groups.map((x) =>
              x.id === groupId ? { ...x, status: 'pr_created', pr: { url, number: prNumber, mergedAt: null } } : x,
            ),
          };
        });
        patchDemo('monitor', (prev) => {
          const m = prev as { runs: { id: string }[] };
          // 같은 묶음으로 두 번 들어와도 행은 하나다.
          if (m.runs.some((r) => r.id === runId)) return prev;
          return {
            ...m,
            runs: [
              {
                id: runId,
                status: 'completed',
                createdAt: new Date().toISOString(),
                durationMs: 52000,
                title: g.title,
                category: g.category,
                repo: 'example/feedloop-demo',
                pr: { url, number: prNumber, mergedAt: null, closedAt: null, closeReason: null, closeNote: null },
                filesChanged: [{ path: 'src/middleware/auth.ts', action: 'modified' }],
                errorMessage: null,
                evidence: { insightCount: g.insightCount, conversationCount: g.conversationCount },
                returns: [],
              },
              ...m.runs,
            ],
          };
        });
        setBusyId(null);
        // 진짜 경로는 `window.location.href` 로 통째로 다시 연다. 연습용에서 그러면 이 탭에만 있던
        // 연습 기록이 통째로 날아가므로 **반드시** 클라이언트 이동이어야 한다.
        if (!onScreen.current) return;
        // 팝업(라이브 데모) 안이면 「나 지금 수정 PR 로 간다」고 알린다.
        // 안 알리면 팝업 왼쪽 안내가 「피드백 묶음」에 불을 켜 둔 채로 남아, 하필 가장 보여주고
        // 싶은 순간에 「지금 여기예요」가 어긋난다. 우리 오리진에만 보낸다.
        if (window.parent !== window) {
          try {
            window.parent.postMessage(
              { source: 'feedloop-demo', type: 'nav', path: '/monitor?demo=1' },
              window.location.origin,
            );
          } catch {
            /* 부모가 다른 오리진이면 브라우저가 버린다 — 이동 자체는 그대로 한다 */
          }
        }
        // 표시를 달고 옮긴다 — 팝업 안에서 여기를 거쳐 갔을 때 연습용이 풀리지 않게.
        router.push('/monitor?demo=1');
      }, 1500);
      return;
    }
    setBusyId(groupId);
    setError(null);
    try {
      const res = await fetch('/api/auto-dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.pr'));
      // 진행 상황은 수정 PR 화면이 스트림으로 그린다.
      window.location.href = `/monitor?runId=${json.runId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.pr'));
      setBusyId(null);
    }
  };

  // 기능 요청은 PR 이 아니라 스펙 초안으로 간다 — 무엇을 만들지는 사람이 정한다.
  const handleCreateSpec = async (groupId: string) => {
    if (demo) return;
    setBusyId(groupId);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/spec`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.spec'));
      setOpenSpecId(groupId);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.spec'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (groupId: string) => {
    // 연습용 화면 — 목록에서만 치운다. 새로고침하면 되돌아온다.
    if (demo) {
      patchDemo('dashboard', (prev) => {
        const d = prev as { groups: GroupSummary[] };
        return { ...d, groups: d.groups.filter((x) => x.id !== groupId) };
      });
      setNotice(t('notices.dismissed'));
      return;
    }
    setBusyId(groupId);
    try {
      await fetch(`/api/groups/${groupId}/dismiss`, { method: 'POST' });
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  // 순위 번호는 아직 반영 안 된 묶음에만, 서버가 준 순서 그대로 1부터 센다(다시 정렬하지 않는다).
  const ranks = new Map<string, number>();
  for (const g of groups) {
    if (g.priority && g.status !== 'merged') ranks.set(g.id, ranks.size + 1);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {/* 제품이 «무엇을 하는가»는 여기서 한 번 말한다. 진행 상태(GroupingStatusLine)는
            「지금 어디쯤인가」만 말하므로 이 설명을 대신하지 못한다 — 빼 놓으면 묶음이 있는 화면
            (= 심사자가 보는 화면)에서 설명이 통째로 사라진다. */}
        <SectionTitle sub={t('sub')}>
          {t('title')}
        </SectionTitle>
        {/* 묶기는 자동이다(I-10). 이 줄은 «지금 어디쯤인가» + 기다리기 싫을 때의 [지금 묶기]. */}
        <GroupingStatusLine
          status={demo ? demoGroupingStatus(groups) : grouping}
          onRunNow={handleRunGrouping}
          running={running}
          // 연습용 화면에서 «다음에 누를 것» 하나만 짚는다. 묶고 나면 PR 쪽으로 넘어간다.
          hint={demo && !hasDemoGroup && !running ? t('tryThis') : null}
          onRefresh={onChanged}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && !error && <p className="text-sm text-muted-foreground">{notice}</p>}

      {groups.length === 0 ? (
        <div className="card-surface p-5 sm:p-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('empty')}
          </p>
        </div>
      ) : (
        <>
          {/* 순서의 기준을 한 줄로 — 번호만 붙어 있으면 「왜 이게 1번이지?」가 남는다. */}
          {groups.some((g) => g.priority) && (
            <p className="-mb-2 text-[12.5px] leading-[1.45] text-faint">
              {t('order')}
            </p>
          )}
          <ul className="card-surface divide-y divide-border px-5 py-1 sm:px-6 sm:py-2">
            {groups.map((g) => (
              <li
                key={g.id}
                className="flex flex-col gap-3 py-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-6"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {/* 순위는 서버가 준 순서 그대로다. 반영됨(merged)은 맨 아래로 오고 번호가 없다.
                        priority 가 없는 구버전 응답은 최신순이라 번호를 달지 않는다. */}
                    {ranks.has(g.id) && (
                      <span className="min-w-[1ch] text-[12.5px] font-semibold leading-[1.45] text-faint tabular-nums">
                        {ranks.get(g.id)}
                      </span>
                    )}
                    <span className={`${BADGE} bg-muted text-foreground`}>
                      {dynamicT(t).has(`categories.${g.category}`) ? dynamicT(t)(`categories.${g.category}`) : g.category}
                    </span>
                    {/* 핵심 흐름이 막힌 묶음만 잉크로 채운다 — 잉크·코랄·회색 세 가지 안에서 가장 진한 칸. */}
                    {g.priority?.core && <span className={`${BADGE} bg-foreground text-background`}>{t('core')}</span>}
                    <p className="min-w-0 text-base font-semibold leading-snug tracking-[-0.01em]">{g.title}</p>
                  </div>
                  {g.priority?.reason && (
                    <p className="truncate text-[12.5px] leading-[1.45] text-muted-foreground" title={g.priority.reason}>
                      {g.priority.reason}
                    </p>
                  )}
                  {/* 이 줄은 «상태 신호»다 — 아래 [PR 만들기]가 실제로 비활성인 이유를 말하는 유일한
                      문장이라, 회색 메타로 내리면 바로 위 요약문과 구분이 안 되고 버튼이 왜 안 눌리는지
                      알 길이 사라진다. 그래서 v4 의 「회색 두 단계」 규칙에서 이 한 줄만 뺀다. */}
                  {(g.followUpPending || g.status === 'merged') && (
                    <p className="flex items-start gap-1.5 text-[12.5px] leading-[1.45] font-medium text-amber-700">
                      <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{t('followUp')}</span>
                    </p>
                  )}
                  <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{g.summary}</p>
                  <p className="text-[12.5px] leading-[1.45] text-faint tabular-nums">
                    {t.rich('feedbackCount', { count: g.insightCount, b: (c) => <b className="font-semibold text-foreground">{c}</b> })}
                    {g.conversationCount > 0 && (
                      <>
                        <span className="mx-1.5">·</span>
                        {t.rich('people', { count: g.conversationCount, b: (c) => <b className="font-semibold text-foreground">{c}</b> })}
                      </>
                    )}
                    <span className="mx-1.5">·</span>
                    {timeAgo(g.createdAt, t)}
                    {g.priority && (
                      <>
                        <span className="mx-1.5">·</span>
                        {t('score', { score: g.priority.score })}
                      </>
                    )}
                  </p>
                </div>

                {/* 좁은 폭에서는 한 줄로 흐르고(flex-wrap), sm 이상에서는 오른쪽 열에 세로로 선다 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-col sm:items-end sm:gap-y-2">
                  {g.pr ? (
                    <>
                      {g.pr.mergedAt ? (
                        <span className={`${BADGE} bg-brand-subtle text-brand-strong`}>
                          <Check className="h-3 w-3" aria-hidden />
                          {t('shipped')}
                        </span>
                      ) : (
                        <span className={`${BADGE} border border-border-strong text-foreground`}>
                          {t('prOpen')}
                        </span>
                      )}
                      <ExternalLink
                        href={g.pr.url}
                        className="inline-flex items-center gap-0.5 text-sm font-semibold text-brand-strong hover:underline"
                      >
                        {t('viewPr', { number: g.pr.number })}
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      </ExternalLink>
                    </>
                  ) : (
                    <>
                      {groupAction(g.category) === 'pr' && (
                        <span className="relative inline-flex">
                          {/* 묶고 난 «그» 묶음 하나만 짚는다 — 행마다 깜빡이면 어디를 보라는지 알 수 없다. */}
                          {demo && g.id === DEMO_NEW_GROUP_ID && !g.pr && busyId !== g.id && (
                            <DemoHint label={t('tryPr')} />
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCreatePr(g.id)}
                            disabled={busyId === g.id || g.followUpPending || g.status !== 'open'}
                          >
                            {busyId === g.id ? <Loader2 className="animate-spin" /> : <GitPullRequest />}
                            {t('createPr')}
                          </Button>
                        </span>
                      )}
                      {groupAction(g.category) === 'spec' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            g.specDraft ? setOpenSpecId(openSpecId === g.id ? null : g.id) : handleCreateSpec(g.id)
                          }
                          disabled={busyId === g.id || demo}
                        >
                          {busyId === g.id ? <Loader2 className="animate-spin" /> : <FileText />}
                          {g.specDraft ? t('viewSpec') : t('draftSpec')}
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDismiss(g.id)}
                        disabled={busyId === g.id}
                        className="text-[12.5px] font-medium text-faint transition-colors hover:text-foreground disabled:opacity-50"
                        aria-label={t('dismissLabel')}
                      >
                        {t('dismiss')}
                      </button>
                    </>
                  )}
                </div>

                {openSpecId === g.id && g.specDraft && (
                  <div className="rounded-xl bg-muted/60 p-4 sm:col-span-2">
                    <p className="mb-2 text-[12.5px] font-semibold leading-[1.45] text-muted-foreground">
                      {t('specNote')}
                    </p>
                    <SpecDraft text={g.specDraft} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

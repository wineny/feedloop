'use client';

// 수정 PR — 묶음마다 AI 가 코드를 고쳐 PR 을 올린 기록. 왼쪽 목록 + 오른쪽 상세(되돌림 포함).
// 예전 「모니터」는 `?runId=` 하나의 스트림만 보였다. 목록이 생기면서 진행 중인 실행은 그대로
// 스트림으로 흐르고, 끝난 실행은 저장된 결과를 재생한다.

export const dynamic = 'force-dynamic';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { LoadingState, ErrorState } from '@/components/layout/PageState';
import { RunDetail } from '@/components/monitor/RunDetail';
import { RunBadge, runState, type RunState } from '@/components/monitor/RunBadge';
import { useDemoMode } from '@/lib/demo/useDemoMode';
import { DemoHint } from '@/components/demo/DemoHint';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { scopedBody, scopedUrl } from '@/lib/scope/scope';
import { ScopeNote } from '@/components/layout/BotScopeSelect';
import { cn } from '@/lib/utils';
import { Loader2, RefreshCw } from 'lucide-react';
import type { RunItem } from '@/app/api/auto-dev/runs/route';
import { stopReasonLabel } from '@/lib/auto-dev/stop-reason-labels';
import { dynamicT, type DynamicTranslate } from '@/i18n/dynamic';

interface DemoMonitorData {
  runs: RunItem[];
  lines: { type: string; message: string }[];
}

type Filter = 'all' | RunState;

// 탭 이름은 배지와 같은 사전(`monitor.state.*`)에서 읽는다 — 「반영됨」 어휘를 여기만 옛말로 남기지 않으려고
const FILTER_VALUES: Filter[] = ['all', 'open', 'merged', 'closed', 'failed', 'stopped', 'unverifiable'];

function timeAgo(dateStr: string, t: DynamicTranslate): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('now');
  if (mins < 60) return t('minutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('hours', { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('yesterday') : t('days', { count: days });
}

/** 목록 행의 둘째 줄 — 상태마다 가장 쓸모 있는 한 줄 */
function subline(run: RunItem, t: DynamicTranslate): string {
  const state = runState(run);
  const duration = run.durationMs == null ? '' : t('duration.seconds', { seconds: Math.round(run.durationMs / 1000) });
  if (state === 'running') return t('subline.running');
  if (state === 'failed' || state === 'stopped' || state === 'unverifiable') {
    // 코드(`root_cause_unknown`)는 채점 스크립트가 읽으니 그대로 두고 화면에서만 사람 말로 푼다.
    // 목록 둘째 줄은 360px 카드 안에서 truncate 라 RunDetail 처럼 코드까지 병기하면 잘린다 — 여기는 라벨만,
    // 코드는 오른쪽 RunDetail 이 보여 준다. 전문은 행의 title(hover)로 읽을 수 있다.
    const reason = run.stopReason
      ? stopReasonLabel(t, run.stopReason)
      : run.errorMessage ?? (state === 'failed' ? t('subline.runFailed') : t('subline.onHold'));
    return [reason, duration].filter(Boolean).join(' · ');
  }
  if (state === 'closed') {
    const reason = run.pr?.closeReason ? t(`closeReason.${run.pr.closeReason}.label`) : t('subline.noReason');
    return t('subline.closed', { number: run.pr?.number ?? 0, reason });
  }
  return [t('subline.pr', { number: run.pr?.number ?? 0 }), duration, run.filesChanged.length === 0 ? t('subline.filesUnknown') : t('subline.files', { count: run.filesChanged.length })]
    .filter(Boolean)
    .join(' · ');
}

function MonitorContent() {
  const t = useTranslations('monitor');
  const td = dynamicT(t);
  const tAgo = dynamicT(useTranslations('dashboard.groups.ago'));
  const searchParams = useSearchParams();
  const requestedRunId = searchParams.get('runId');
  const { status: authStatus } = useSession();
  const demo = useDemoMode<DemoMonitorData>('monitor');

  const [runs, setRuns] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // 0건 탭은 「더보기」 뒤에 접힌다(v4 §6). 펼침 여부만 기억한다
  const [showAllFilters, setShowAllFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(requestedRunId);
  const [checkingMerge, setCheckingMerge] = useState(false);
  const [mergeElapsed, setMergeElapsed] = useState(0);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);

  // 헤더 셀렉터의 서비스 스코프(I-27). 목록·머지 확인이 같은 봇으로 좁혀진다.
  const scope = useBotScope();
  const botId = scope.botId;

  const fetchRuns = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(scopedUrl('/api/auto-dev/runs', botId));
      if (res.status === 401) {
        setRuns([]);
        return;
      }
      if (!res.ok) throw new Error(t('errors.api', { status: res.status }));
      const json = await res.json();
      setRuns(json.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.load'));
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  // 스코프가 바뀌면 옛 목록을 새 스코프 이름 밑에 두지 않는다
  useEffect(() => {
    if (!demo.isDemo) setLoading(true);
  }, [botId, demo.isDemo]);

  useEffect(() => {
    if (demo.isDemo) {
      setLoading(false);
      return;
    }
    if (authStatus === 'authenticated') {
      if (scope.ready) void fetchRuns();
    } else if (authStatus === 'unauthenticated') setLoading(false);
  }, [authStatus, demo.isDemo, scope.ready, fetchRuns]);

  const list = demo.isDemo ? demo.data.runs : runs;
  const hasActiveRun = list.some(run => run.status === 'running' || run.status === 'in_progress');
  useEffect(() => {
    if (demo.isDemo || !hasActiveRun) return;
    const timer = setInterval(() => { void fetchRuns(); }, 3000);
    return () => clearInterval(timer);
  }, [demo.isDemo, hasActiveRun, fetchRuns]);
  const filtered = useMemo(
    () => (filter === 'all' ? list : list.filter((r) => runState(r) === filter)),
    [list, filter],
  );
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: list.length, running: 0, open: 0, merged: 0, closed: 0, failed: 0, stopped: 0, unverifiable: 0 };
    for (const r of list) c[runState(r)] += 1;
    return c;
  }, [list]);

  // 「전체」 + 건수 > 0 + 지금 고른 탭만 보인다. 고른 탭은 0이 돼도 남는다 — 누른 탭이 사라지면 안 된다
  const FILTERS = useMemo(
    () => FILTER_VALUES.map((value) => ({ value, label: value === 'all' ? t('filterAll') : dynamicT(t)(`state.${value}`) })),
    [t],
  );
  const visibleFilters = useMemo(
    () => FILTERS.filter((f) => f.value === 'all' || f.value === filter || counts[f.value] > 0),
    [FILTERS, counts, filter],
  );
  const hiddenFilters = FILTERS.length - visibleFilters.length;

  // 주소로 지정된 실행이 없으면 목록의 첫 실행을 연다
  const selected = list.find((r) => r.id === selectedId) ?? filtered[0] ?? list[0] ?? null;
  const openCount = counts.open;

  const handleCheckMerged = async () => {
    // 연습용 화면 — GitHub 에 나갈 것이 없다. 예시 PR 은 머지 여부가 이미 정해져 있어
    // 「새로 머지된 건 없다」가 사실 그대로다. 대시보드의 같은 버튼과 말을 맞춘다.
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
      if (secs >= 10) setMergeNotice(t('merge.slow'));
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
      await fetchRuns();
    } catch (err) {
      setMergeNotice(err instanceof Error ? err.message : t('errors.check'));
    } finally {
      clearInterval(tick);
      setCheckingMerge(false);
      setMergeElapsed(0);
    }
  };

  // 진행 중 실행이 끝나면 목록을 다시 읽어 PR 번호·파일을 채운다
  const handleComplete = useCallback(() => {
    if (!demo.isDemo) fetchRuns();
  }, [demo.isDemo, fetchRuns]);

  if (!demo.isDemo && (authStatus === 'loading' || loading)) return <LoadingState />;
  if (!demo.isDemo && error && list.length === 0) {
    return <ErrorState message={error} onRetry={() => { setLoading(true); fetchRuns(); }} />;
  }

  return (
    <div className="flex flex-col gap-10">
      <PageHero
        emoji={PAGE_EMOJI.monitor}
        title={t('title')}
        description={
          <>
            <ScopeNote />
            {openCount > 0
              ? t.rich('subtitleOpen', { count: openCount, strong: (chunks) => <strong className="tabular-nums">{chunks}</strong> })
              : t('subtitleNone')}
          </>
        }
        actions={
          <Button variant="outline" onClick={handleCheckMerged} disabled={checkingMerge}>
            {checkingMerge ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {checkingMerge ? t('checking', { seconds: mergeElapsed }) : t('checkMerged')}
          </Button>
        }
      />
      {/* 「수정안 ↔ PR」을 이어주는 **유일한** 자리다. 메뉴·배지·목록은 쉬운 말만 쓰고,
          GitHub 으로 건너가는 다리는 여기 한 줄과 상세의 「GitHub 에서 PR #N 보기」 링크뿐이다.
          괄호 병기를 화면 곳곳에 뿌리지 않는다 — 글자가 두 배가 되고 위계가 무너진다. */}
      <div className="-mt-7 flex flex-col gap-1.5">
        <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
          {t('bridge')}
        </p>
        {mergeNotice && <p className="text-[12.5px] leading-[1.45] text-muted-foreground">{mergeNotice}</p>}
      </div>

      {list.length === 0 ? (
        <p className="py-6 text-sm leading-relaxed text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid items-start gap-10 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-12">
          <div className="card-surface overflow-hidden">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1 border-b border-border px-5">
              {visibleFilters.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    '-mb-px inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 text-sm font-semibold transition-colors',
                    filter === f.value ? 'border-foreground text-foreground' : 'border-transparent text-faint hover:text-muted-foreground',
                  )}
                >
                  {f.label}
                  <small className={cn('text-[12.5px] font-medium tabular-nums', filter === f.value ? 'text-muted-foreground' : 'text-faint')}>
                    {counts[f.value]}
                  </small>
                </button>
              ))}
              {hiddenFilters > 0 && (
                <button
                  type="button"
                  aria-expanded={showAllFilters}
                  aria-controls="monitor-hidden-filters"
                  onClick={() => setShowAllFilters((v) => !v)}
                  className="-mb-px ml-auto inline-flex min-h-11 items-center whitespace-nowrap border-b-2 border-transparent text-[12.5px] font-medium text-faint transition-colors hover:text-muted-foreground"
                >
                  {showAllFilters ? t('lessFilters') : t('moreFilters', { count: hiddenFilters })}
                </button>
              )}
            </div>
            {/* 접힌 0건 탭 — 펼치면 아래 줄에 붙는다. 여기서 고른 탭은 위 줄로 올라가 남는다 */}
            {showAllFilters && hiddenFilters > 0 && (
              <div id="monitor-hidden-filters" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/60 px-5 py-2">
                {FILTERS.filter((f) => !visibleFilters.includes(f)).map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    className="inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-faint transition-colors hover:text-muted-foreground"
                  >
                    {f.label}
                    <small className="tabular-nums">{counts[f.value]}</small>
                  </button>
                ))}
              </div>
            )}

            <ul>
              {filtered.length === 0 && (
                <li className="px-5 py-5 text-sm text-muted-foreground">{t('noRunsInState')}</li>
              )}
              {filtered.map((r, i) => {
                const isSelected = selected?.id === r.id;
                const prevSelected = i > 0 && selected?.id === filtered[i - 1].id;
                // 연습용 화면에서 방금 [PR 만들기]로 만든 행. 목록 맨 위에 새로 생기는데,
                // 짚어 주지 않으면 「뭐가 달라졌지?」로 지나친다.
                const isJustMade = demo.isDemo && r.id.startsWith('demo-run-demo-group-');
                return (
                  <li key={r.id} className={cn('relative border-t border-border first:border-t-0', (isSelected || prevSelected) && 'border-t-transparent')}>
                    {isJustMade && <DemoHint />}
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={cn(
                        'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-5 py-4 text-left',
                        isSelected && 'bg-brand-subtle shadow-[inset_3px_0_0_var(--primary)]',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-semibold leading-snug">
                          {/* 연습용 화면에서 방금 만든 행임을 «행 안에서» 알린다 —
                              위로 띄우는 말풍선은 바로 윗줄의 상태 탭(전체·검토 대기·…)을 가린다. */}
                          {isJustMade && (
                            <span className="flex-none rounded-full bg-[#D13A2D] px-2 py-0.5 text-[11.5px] font-bold text-white">
                              {t('justMade')}
                            </span>
                          )}
                          <span className="truncate">{r.title}</span>
                        </p>
                        <p className="mt-1 truncate text-[12.5px] leading-[1.45] text-muted-foreground tabular-nums" title={subline(r, td)}>{subline(r, td)}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <span className="text-[12.5px] text-faint tabular-nums">{timeAgo(r.createdAt, tAgo)}</span>
                        <RunBadge state={runState(r)} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {selected && (
            <RunDetail
              key={selected.id}
              run={selected}
              streamUrl={demo.isDemo ? undefined : `/api/auto-dev/stream?runId=${selected.id}`}
              staticLines={demo.isDemo ? demo.data.lines : undefined}
              onSettled={handleComplete}
              readOnly={demo.isDemo}
              onRunChange={(next) => setRuns((prev) => prev.map((r) => (r.id === next.id ? next : r)))}
              // 반영 뒤 되돌림 목록(responses)은 서버가 만든다 — 다시 읽어야 상세에 뜬다.
              // 데모(비로그인)는 서버에 읽을 실행이 없으므로 부르지 않는다
              onRefresh={() => { if (!demo.isDemo) fetchRuns(); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

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

type Translate = ReturnType<typeof useTranslations<'monitor'>>;

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

export default function MonitorPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <MonitorContent />
    </Suspense>
  );
}

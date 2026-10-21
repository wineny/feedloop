'use client';

// 피드백 — 들어온 피드백을 AI 가 건별로 나눈 목록. 같은 문제끼리 묶는 일(그룹핑)은
// 대시보드 「피드백 묶음」이 한다. 이 화면은 건별로 어디까지 갔는지(묶음 → PR → 머지)를 보여준다.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { ClassificationTabs } from '@/components/classify/ClassificationTabs';
import type { GroupRef, Insight } from '@/components/classify/types';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHero, PAGE_EMOJI } from '@/components/layout/PageHero';
import { LoadingState, ErrorState } from '@/components/layout/PageState';
import { useDemoMode } from '@/lib/demo/useDemoMode';
import { getDemoData } from '@/lib/demo/mock-data';
import { GroupingStatusLine } from '@/components/groups/GroupingStatusLine';
import type { GroupingStatus } from '@/lib/groups/grouping-status';
import { useBotScope } from '@/lib/scope/BotScopeProvider';
import { scopedBody, scopedUrl } from '@/lib/scope/scope';
import { ScopeNote } from '@/components/layout/BotScopeSelect';
import { isGroupable } from '@/lib/classify/taxonomy';

interface RecoveryState { counts: Record<string, number>; failures: { id: string; classification_state: string; classification_attempts: number; classification_error: string | null }[] }

type Translate = ReturnType<typeof useTranslations<'classify'>>;

const EMPTY_GROUPS = new Map<string, GroupRef>();

/**
 * 분류 실행 결과를 한 줄로.
 *
 * ⚠️ 예전엔 `classified > 0` 하나로 갈라 **「분류할 새 피드백이 없어요」** 아니면
 * 건수였다. 키가 죽었거나 전부 타임아웃하면 `classified === 0` 이고 응답은 200 이라,
 * 미분류가 쌓여 있는데도 「없어요」가 떴다 — 조용한 실패다. 라우트가 `pending`·
 * `failedBots` 를 싣는 이유가 이걸 가르기 위해서다.
 */
function describeClassifyResult(json: {
  classified?: number;
  failed?: number;
  exhausted?: number;
  noInsight?: number;
  deferred?: boolean;
  pending?: number;
  failedBots?: number;
  deferredBots?: number;
  limitedBots?: number;
}, t: Translate): string {
  const done = json.classified ?? 0;
  const parts: string[] = [];

  if (json.failed) parts.push(t('result.failed', { count: json.failed }));
  if (json.exhausted) parts.push(t('result.exhausted', { count: json.exhausted }));
  if (json.noInsight) parts.push(t('result.noInsight', { count: json.noInsight }));
  if (json.deferred) parts.push(t('result.deferred'));
  if (done > 0) parts.push(t('result.done', { count: done }));

  if (json.failedBots) {
    parts.push(done > 0 ? t('result.failedBotsPartial', { count: json.failedBots }) : t('result.failedBotsAll'));
  }
  if (json.limitedBots) parts.push(t('result.limitedBots', { count: json.limitedBots }));
  if (json.deferredBots) parts.push(t('result.deferredBots', { count: json.deferredBots }));

  if (parts.length === 0) {
    // 실패도 없고 분류한 것도 없다. 남은 게 있는지로 갈린다.
    return json.pending ? t('result.leftNone', { count: json.pending }) : t('result.nothingNew');
  }
  if (done > 0 && json.pending) parts.push(t('result.left', { count: json.pending }));

  return parts.join(' · ');
}

export default function ClassifyPage() {
  const t = useTranslations('classify');
  const { status: authStatus } = useSession();
  const demo = useDemoMode<{ insights: Insight[] }>('classify');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [groupsById, setGroupsById] = useState<Map<string, GroupRef>>(EMPTY_GROUPS);
  // I-12 — 이 탭에서도 「몇 건이 안 묶였고 언제 묶이는지」를 본다. 조각마다 PR 버튼만 보이던 자리.
  const [grouping, setGrouping] = useState<GroupingStatus | null>(null);
  const [runningGrouping, setRunningGrouping] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState>({ counts: {}, failures: [] });
  const [retrying, setRetrying] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [classifying, setClassifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 헤더 셀렉터의 서비스 스코프(I-27) — 목록·분류·묶기 전부 같은 봇으로 좁힌다.
  const scope = useBotScope();
  const botId = scope.botId;

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      // 묶음은 행 우측(묶음 → PR → 머지)을 그리는 근거다. 실패해도 목록은 보여준다.
      const [insightsRes, groupsRes] = await Promise.all([
        fetch(scopedUrl('/api/classify', botId)),
        fetch(scopedUrl('/api/groups', botId)),
      ]);
      if (!insightsRes.ok) throw new Error(t('errors.api', { status: insightsRes.status }));
      const insightsJson = await insightsRes.json();
      setInsights(insightsJson.insights || []);
      setRecovery(insightsJson.recovery ?? { counts: {}, failures: [] });

      if (groupsRes.ok) {
        const groupsJson = await groupsRes.json();
        const map = new Map<string, GroupRef>();
        for (const g of (groupsJson.groups ?? []) as GroupRef[]) map.set(g.id, g);
        setGroupsById(map);
        setGrouping(groupsJson.grouping ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.load'));
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  const handleClassify = async () => {
    try {
      setClassifying(true);
      setNotice(null);
      const res = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scopedBody({}, botId)),
      });
      if (!res.ok) throw new Error(t('errors.classifyStatus', { status: res.status }));
      const json = await res.json();
      setNotice(describeClassifyResult(json, t));
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.classify'));
    } finally {
      setClassifying(false);
    }
  };

  // [지금 묶기] — 자동 묶기(제보 뒤 1~2분)를 기다리기 싫을 때의 폴백. 대시보드와 같은 라우트.
  const handleRunGrouping = async () => {
    if (demo.isDemo) return;
    setRunningGrouping(true);
    setError(null);
    try {
      const res = await fetch('/api/groups/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scopedBody({}, botId)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.group'));
      setNotice(
        json.busy && !json.grouped ? t('group.busy')
          : json.grouped ? t('group.grouped', { count: json.grouped }) : t('group.nothing'),
      );
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.group'));
    } finally {
      setRunningGrouping(false);
    }
  };

  const retryExhausted = async (messageId: string) => {
    setRetrying(messageId);
    setError(null);
    try {
      const response = await fetch('/api/classify', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? t('errors.reschedule'));
      await fetchData();
      setNotice(t('rescheduled'));
    } catch (err) { setError(err instanceof Error ? err.message : t('errors.retry')); }
    finally { setRetrying(null); }
  };

  // 스코프가 바뀌면 옛 목록을 새 스코프 이름 밑에 두지 않는다
  useEffect(() => {
    if (!demo.isDemo) setLoading(true);
  }, [botId, demo.isDemo]);

  // 세션이 판정되기 전(loading)에는 isDemo 도 false 라, 여기서 바로 부르면 401 이 화면에 새어 나온다.
  useEffect(() => {
    if (demo.isDemo) {
      setLoading(false);
      return;
    }
    if (authStatus === 'authenticated') {
      if (scope.ready) void fetchData();
    } else if (authStatus === 'unauthenticated') setLoading(false);
  }, [authStatus, demo.isDemo, scope.ready, fetchData]);

  // 데모의 묶음은 대시보드 데모와 같은 것을 쓴다 — 두 화면의 「묶음 · PR」 표시가 어긋나지 않게
  const locale = useLocale();
  const demoGroups = useMemo(() => {
    const map = new Map<string, GroupRef>();
    const groups = ((getDemoData(locale).dashboard as { groups?: GroupRef[] }).groups ?? []);
    for (const g of groups) map.set(g.id, g);
    return map;
  }, [locale]);

  if (!demo.isDemo && (authStatus === 'loading' || loading)) {
    return <LoadingState />;
  }

  if (!demo.isDemo && error && insights.length === 0) {
    return <ErrorState message={error} onRetry={() => { setLoading(true); fetchData(); }} />;
  }

  const shown = demo.isDemo ? demo.data.insights : insights;

  // 부제 한 줄(v4 §5) — 이 화면이 크게 말하는 한 가지는 「아직 안 묶인 제보」다. 서버가 묶기 상태를 줬으면
  // 그 수(상태줄과 같은 출처)를, 못 받았거나 데모면 목록에서 센다 — 묶기 대상(버그·UX·기능 요청)만.
  const ungrouped = grouping
    ? grouping.pending
    : shown.filter((i) => !i.group_id && isGroupable(i.category)).length;

  // ⚠️ 두 숫자의 «출처가 다르다». `ungrouped` 는 서버의 무제한 count 인데 `shown` 은
  // `/api/classify` 가 `.limit(50)` 으로 자른 목록이다. 그대로 나란히 쓰면 제보가 50건을 넘는
  // 계정에서 「안 묶인 제보 120건 · 전체 50건」처럼 부분이 전체보다 커진다.
  // 목록이 상한에 닿았으면 「50건+」로 적어 «여기 보이는 게 전부가 아니다»를 말한다.
  const CLASSIFY_LIST_LIMIT = 50;
  const shownLabel = t('total', { count: shown.length, plus: shown.length >= CLASSIFY_LIST_LIMIT ? 'yes' : 'no' });

  return (
    <div className="flex flex-col gap-10 sm:gap-12">
      <PageHero
        emoji={PAGE_EMOJI.classify}
        title={t('title')}
        description={
          <>
            <ScopeNote />
            {shown.length === 0
              ? t('subtitleEmpty')
              : ungrouped > 0
                ? t.rich('subtitleUngrouped', { count: ungrouped, total: shownLabel, strong: (chunks) => <strong className="tabular-nums">{chunks}</strong> })
                : t.rich('subtitleAllGrouped', { total: shownLabel, strong: (chunks) => <strong className="tabular-nums">{chunks}</strong> })}
          </>
        }
        actions={
          <Button onClick={handleClassify} disabled={classifying || demo.isDemo}>
            {classifying ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {t('runClassify')}
          </Button>
        }
      />

      {(notice || error) && (
        <p className={error ? '-mt-6 text-[12.5px] text-destructive sm:-mt-8' : '-mt-6 text-[12.5px] text-muted-foreground sm:-mt-8'}>
          {error ?? notice}
        </p>
      )}

      {/* 복구 상태 — 카드 하나. 제목은 본문 크기(14/600)다. 이 화면의 주인공은 아래 목록이라
          20px 섹션 제목을 주면 보조 패널이 주인공과 같은 음량으로 말한다. */}
      {!demo.isDemo && <section className="card-surface p-5 sm:p-6" aria-label={t('recovery.aria')}>
        <h2 className="text-sm font-semibold">{t('recovery.title')}</h2>
        {/* 0 인 항목은 말하지 않는다. 늘 네 가지를 나열하면 평상시에 0 이 세 개씩 붙어
            390px 에서 두 줄로 접히고, 정작 중요한 「대기 3」이 그 안에 묻힌다. */}
        <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
          {[
            recovery.counts.pending ? t('recovery.pending', { count: recovery.counts.pending }) : null,
            recovery.counts.processing ? t('recovery.processing', { count: recovery.counts.processing }) : null,
            recovery.counts.failed ? t('recovery.failed', { count: recovery.counts.failed }) : null,
            recovery.counts.exhausted ? t('recovery.exhausted', { count: recovery.counts.exhausted }) : null,
          ].filter(Boolean).join(' · ') || t('recovery.none')}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-faint">{t('recovery.note')}</p>
        {recovery.failures.map(failure => <div key={failure.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="min-w-0 text-[12.5px] text-muted-foreground">{t('recovery.row', { id: failure.id.slice(0, 8), attempts: failure.classification_attempts, error: failure.classification_error ?? t('recovery.unknownCause') })}</p>
          {failure.classification_state === 'exhausted' && <Button size="sm" variant="outline" disabled={retrying !== null} onClick={() => retryExhausted(failure.id)}>{t('recovery.reschedule')}</Button>}
        </div>)}
      </section>}

      {/* 묶기 상태 한 줄은 목록 «바로 위»에 둔다 — 목록이 답하는 질문(어디까지 갔나)의 첫 문장이라서 */}
      <div className="flex flex-col gap-4">
        {/* 이 화면엔 [PR 만들기]가 없다(I-10 — 묶기가 자동이라 PR 은 묶음 단위로만 만든다).
            그 사실을 어디서도 말하지 않으면 운영자는 버튼을 찾다가 못 찾는다. */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t.rich('hint', {
            link: (chunks) => (
              <Link href="/dashboard" className="font-semibold text-brand-strong underline underline-offset-2">
                {chunks}
              </Link>
            ),
          })}
        </p>
        {!demo.isDemo && (
          <GroupingStatusLine
            status={grouping}
            onRunNow={handleRunGrouping}
            running={runningGrouping}
            onRefresh={fetchData}
          />
        )}
        <ClassificationTabs
          insights={shown}
          groupsById={demo.isDemo ? demoGroups : groupsById}
          demo={demo.isDemo}
        />
      </div>
    </div>
  );
}

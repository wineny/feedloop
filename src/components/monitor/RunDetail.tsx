'use client';

// 수정 PR 상세 — 판단 재료 · 담당자용 설명 · 바뀐 코드 · 행동(반영 / 반영하지 않기) · 되돌림 · 실행 로그.
// 되돌림은 별도 탭이 아니라 여기서 본다: PR 하나가 반영되면 그 문제를 말한 사람 모두에게 나가므로
// PR 을 기준으로 묶여야 읽힌다. PR 이 있는 실행의 검토·행동은 `PrReviewPanel` 이 맡는다 (I-19).

import { useRef, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronRight, Check, X, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CLOSE_REASONS, CLOSE_NOTE_MAX, type CloseReason } from '@/lib/auto-dev/close-reason';
import { stopReasonLabel } from '@/lib/auto-dev/stop-reason-labels';
import { dynamicT } from '@/i18n/dynamic';
import { Button } from '@/components/ui/button';
import { ChannelChip } from '@/components/dashboard/RecentFeedback';
import {
  buildRetryMessage,
  countUndeliveredBySource,
  parseRunRetryOutcome,
  RetryShapeError,
  type RetryMessage,
} from '@/lib/monitor/redeliver-message';
import { TerminalLog, type CompletionData } from '@/components/monitor/TerminalLog';
import { RunBadge, runState } from '@/components/monitor/RunBadge';
import { PrReviewPanel } from '@/components/monitor/PrReviewPanel';
import type { RunItem, RunReturn } from '@/app/api/auto-dev/runs/route';
import { ExternalLink } from '@/components/demo/ExternalLink';

// 배포 확인이 「모름」인 이유 코드(`checkDeployment`, lib/auto-dev/loop-closed.ts)는 사전 `monitor.detail.deployReason.<코드>` 로 사람 말로 옮긴다.
// 내부 식별자를 심사자 화면에 그대로 두지 않는다. 모르는 값이 오면 원래 문자열을 그대로 보여준다 — 조용히 숨기면 새 사유가 생겼을 때 아무 말도 안 하는 화면이 된다.

interface RunDetailProps {
  run: RunItem;
  /** 진행 중이면 스트림을 연다. 끝난 실행은 저장된 결과를 재생한다 */
  streamUrl?: string;
  staticLines?: { type: string; message: string }[];
  onComplete?: (data: CompletionData) => void;
  /** 실행이 실패로 끝났을 때 — 부모가 목록을 다시 읽는다 (I-14) */
  onSettled?: () => void;
  /** 데모 모드 — GitHub 를 읽지 않고 행동도 없다 */
  readOnly?: boolean;
  /** 저장 뒤 목록 쪽 상태를 맞추려고 바뀐 run 을 돌려준다 */
  onRunChange?: (run: RunItem) => void;
  /** run 여러 칸이 한꺼번에 바뀌는 경우 — 반영 뒤 되돌림 목록이 생기거나, 되돌림을 재전송했을 때 */
  onRefresh?: () => void;
}

function Confirmation({ r }: { r: RunReturn }) {
  const t = useTranslations('monitor.detail');
  if (!r.deliveredAt) return <span className="text-[12.5px] font-medium text-faint">{t('notify.beforeDelivery')}</span>;
  if (r.confirmation === 'fixed') {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-strong">
        <Check className="h-3 w-3" aria-hidden />{t('confirm.fixed')}
      </span>
    );
  }
  if (r.confirmation === 'not_fixed') {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-destructive">
        <X className="h-3 w-3" aria-hidden />{t('confirm.notFixed')}
      </span>
    );
  }
  return <span className="text-[12.5px] font-medium text-faint">{t('confirm.noReply')}</span>;
}

/**
 * 닫은 사유 — 사람이 고른다. GitHub 는 닫힌 것만 알고 「왜」는 모른다.
 * 앱 안에서 「반영하지 않기」로 닫으면 사유가 같이 저장되지만, GitHub 에서 직접 닫은 PR 은
 * 「머지 확인」이 닫힘만 감지하므로 여기서 뒤늦게 고른다. 강제하지 않는다(미분류로 둘 수 있다).
 */
function CloseReasonControl({
  run,
  readOnly,
  onRunChange,
}: {
  run: RunItem;
  readOnly?: boolean;
  onRunChange?: (run: RunItem) => void;
}) {
  const t = useTranslations('monitor');
  const [reason, setReason] = useState<CloseReason | null>(run.pr?.closeReason ?? null);
  const [note, setNote] = useState(run.pr?.closeNote ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 저장은 직렬로. 메모 입력에 포커스가 있을 때 셀렉트를 바꾸면 blur → change 순으로 두 번 저장되는데,
  // 동시에 보내면 서버 도착 순서에 따라 옛 값이 남을 수 있다. 마지막에 저장된 값이 DB 값이 되게 줄 세운다.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const persisted = useRef<{ reason: CloseReason | null; note: string }>({
    reason: run.pr?.closeReason ?? null,
    note: run.pr?.closeNote ?? '',
  });

  const save = (nextReason: CloseReason | null, nextNote: string) => {
    if (!run.pr) return;
    queue.current = queue.current.then(async () => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/auto-dev/runs/${run.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ close_reason: nextReason, close_note: nextNote }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t('errors.save'));
        persisted.current = { reason: json.closeReason ?? null, note: json.closeNote ?? '' };
        onRunChange?.({ ...run, pr: { ...run.pr!, closeReason: json.closeReason, closeNote: json.closeNote } });
        if (!json.closeReason) setNote('');
      } catch (err) {
        // 화면이 DB 와 다른 말을 하면 이 기능의 목적(정확한 실패 집계)이 무너진다 — 마지막 저장값으로 되돌린다
        setReason(persisted.current.reason);
        setNote(persisted.current.note);
        setError(err instanceof Error ? err.message : t('errors.save'));
      } finally {
        setSaving(false);
      }
    });
  };

  if (readOnly) {
    return (
      <span className="text-sm">
        {reason ? t(`closeReason.${reason}.label`) : <span className="text-faint">{t('detail.closeReason.unset')}</span>}
        {reason && note && <span className="ml-1.5 text-muted-foreground">· {note}</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={reason ?? ''}
          disabled={saving}
          aria-label={t('detail.closeReason.aria')}
          title={reason ? t(`closeReason.${reason}.hint`) : t('detail.closeReason.hintEmpty')}
          onChange={(e) => {
            const next = (e.target.value || null) as CloseReason | null;
            setReason(next);
            save(next, note);
          }}
          className={cn(
            'h-8 rounded-md border border-border bg-background px-2 text-sm',
            !reason && 'text-muted-foreground',
          )}
        >
          <option value="">{t('detail.closeReason.unset')}</option>
          {CLOSE_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`closeReason.${r}.label`)}
            </option>
          ))}
        </select>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-faint" aria-hidden />}
        {error && <span className="text-[12.5px] text-destructive">{error}</span>}
      </div>
      {reason && (
        <input
          type="text"
          value={note}
          maxLength={CLOSE_NOTE_MAX}
          placeholder={t('detail.closeReason.notePlaceholder')}
          aria-label={t('detail.closeReason.noteAria')}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (persisted.current.note !== note.trim()) save(reason, note);
          }}
          className="h-8 w-full max-w-md rounded-md border border-border bg-background px-2 text-sm placeholder:text-faint"
        />
      )}
      {reason && <p className="text-[12.5px] leading-[1.45] text-faint">{t(`closeReason.${reason}.hint`)}</p>}
    </div>
  );
}

export function RunDetail({
  run,
  streamUrl,
  staticLines,
  onComplete,
  // I-14 의 `onError` 는 파이프라인이 `onSettled` 로 이름을 바꿨다 — 메시지를 넘기지 않고
  // 「끝났다」만 알리고 부모가 목록을 다시 읽는다. 기능은 같다.
  onSettled,
  readOnly,
  onRunChange,
  onRefresh,
}: RunDetailProps) {
  const t = useTranslations('monitor');
  const td = dynamicT(t);
  const format = useFormatter();
  const state = runState(run);
  const delivered = run.returns.filter((r) => r.deliveredAt);
  const firstReturnAt = delivered.map((r) => r.deliveredAt!).sort()[0];
  const pending = countUndeliveredBySource(run.returns);

  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<RetryMessage | null>(null);

  const fmt = (value: string | null | undefined, timeOnly = false): string => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return format.dateTime(d, timeOnly ? { hour: 'numeric', minute: '2-digit' } : { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const duration = (ms: number | null): string => {
    if (ms == null) return '';
    const sec = Math.round(ms / 1000);
    return sec >= 60 ? t('duration.minutesSeconds', { minutes: Math.floor(sec / 60), seconds: sec % 60 }) : t('duration.seconds', { seconds: sec });
  };
  const stopLabel = stopReasonLabel(td, run.stopReason);

  // 채널톡 되돌림만 여기서 다시 민다. 카카오는 «실패»가 아니라 대기열이라 밀 곳이 없다.
  const handleRedeliver = async () => {
    setRetrying(true);
    setRetryResult(null);
    try {
      const res = await fetch(`/api/auto-dev/runs/${run.id}/redeliver`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('errors.redeliver'));
      // 형태를 확인하고 넘긴다 — 어긋나면 「보낼 되돌림이 없어요」로 조용히 잘못 뜬다.
      setRetryResult(buildRetryMessage(parseRunRetryOutcome(json), (key, values) => td(`retry.${key}`, values)));
      // 보낸 건 목록의 「전달됨」으로 바뀌어야 한다 — 한 칸만 고치지 않고 다시 읽는다.
      onRefresh?.();
    } catch (err) {
      setRetryResult({
        headline: err instanceof RetryShapeError ? t('errors.shape') : err instanceof Error ? err.message : t('errors.redeliver'),
        warning: null,
        note: null,
      });
    } finally {
      setRetrying(false);
    }
  };

  const validationLabel =
    run.validationStatus === 'validated' && run.validationEvidence?.checks?.length
      ? t('detail.validation.passed')
      : run.validationStatus === 'failed'
        ? t('detail.validation.failed')
        : run.validationStatus === 'stopped'
          ? t('detail.validation.stopped')
          : run.validationStatus === 'unverifiable'
            ? t('detail.validation.unverifiable')
            : t('detail.validation.unknown');
  const deploymentLabel =
    run.deploymentStatus === 'success'
      ? t('detail.deploy.success')
      : run.deploymentStatus === 'failed'
        ? t('detail.deploy.failed')
        : run.deploymentStatus === 'pending'
          ? t('detail.deploy.pending')
          : t('detail.deploy.unknown');
  const deploymentReason = run.deploymentReason
    ? td.has(`detail.deployReason.${run.deploymentReason}`)
      ? td(`detail.deployReason.${run.deploymentReason}`)
      : run.deploymentReason
    : null;
  const userConfirmLabel = run.returns.some((r) => r.confirmation === 'not_fixed')
    ? t('detail.userConfirm.unresolved')
    : run.returns.length > 0 && run.returns.every((r) => r.confirmation === 'fixed')
      ? t('detail.userConfirm.allFixed')
      : t('detail.userConfirm.waiting');
  const emailNote = (r: RunReturn) =>
    r.emailDeliveryStatus === 'delivery_unknown'
      ? t('detail.notify.emailUnknown')
      : r.emailDeliveryStatus === 'failed'
        ? t('detail.notify.emailFailed')
        : r.emailDeliveryStatus === 'skipped'
          ? // 재제보 합류(B1)로 만든 되돌림. 메일을 «일부러» 안 붙였다 —
            // 안 쓰면 대기 중인 행과 똑같이 보여 운영자가 장애로 읽는다.
            t('detail.notify.emailSkipped')
          : r.emailSentAt
            ? t('detail.notify.emailSent')
            : null;
  const bold = { b: (chunks: ReactNode) => <b className="font-semibold">{chunks}</b> };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* 제목이 먼저 잘리던 결함(v4 §7) — `min-w-0` 이 핵심이다. flex 자식의 기본 min-width:auto 가
          축소를 막아 형제(배지·링크)가 대신 찌그러졌다. sm 미만은 제목이 한 줄을 독차지하고 링크는 다음 줄 */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border pb-4">
        {/* 배지는 인라인으로 흘린다 — 제목이 꺾여도 마지막 단어 뒤에 붙고, 따로 한 줄을 차지하지 않는다 */}
        <h2 className="min-w-0 flex-1 basis-full text-xl font-bold leading-snug tracking-[-0.02em] sm:basis-0">
          {run.title}
          <RunBadge state={state} className="ml-2 align-[3px]" />
        </h2>
        {run.pr && (
          // 부속 링크다 — 검토·행동은 이 화면 안에서 끝난다. GitHub 는 확인용
          <ExternalLink
            href={run.pr.url}
            className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12.5px] font-semibold text-muted-foreground hover:underline sm:mt-1.5"
          >
            {t('detail.viewOnGithub', { number: run.pr.number })}
            <ChevronRight className="h-3 w-3" aria-hidden />
          </ExternalLink>
        )}
      </div>

      {/* 상태 4행 — 값은 잉크색 반굵게, 라벨만 회색. 전부 같은 회색이면 상태로 안 읽힌다 */}
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm leading-snug [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:font-semibold [&_dt]:text-muted-foreground">
        <dt>{t('detail.dt.validation')}</dt>
        <dd>{validationLabel}{run.validationEvidence?.reason && <span className="font-normal text-muted-foreground"> · {run.validationEvidence.reason}</span>}</dd>
        <dt>{t('detail.dt.prCreated')}</dt><dd>{run.pr ? t('detail.pr.created') : run.publicationStatus === 'pending' ? t('detail.pr.publishing') : t('detail.pr.notYet')}</dd>
        <dt>{t('detail.dt.deployment')}</dt><dd>{deploymentLabel}{deploymentReason && <span className="font-normal text-muted-foreground"> · {deploymentReason}</span>}</dd>
        <dt>{t('detail.dt.userConfirm')}</dt><dd>{userConfirmLabel}</dd>
        {run.stopReason && <><dt>{t('detail.dt.stopReason')}</dt><dd>{stopLabel}{stopLabel !== run.stopReason && <span className="font-normal text-muted-foreground"> · {run.stopReason}</span>}</dd></>}
        {run.followUpError && <><dt>{t('detail.dt.followUpError')}</dt><dd className="text-destructive">{t('detail.followUpHint', { error: run.followUpError })}</dd></>}
      </dl>
      {run.validationEvidence && <details className="rounded-[10px] border border-border px-4 py-3 text-[12.5px] leading-[1.45]">
        <summary className="cursor-pointer font-semibold">{t('detail.evidenceSummary', { attempt: run.validationEvidence.attempt })}</summary>
        <p className="break-all py-2 text-muted-foreground">{t('detail.evidenceCommit', { base: run.validationEvidence.baseSha, patch: run.validationEvidence.patchDigest })}</p>
        {run.validationEvidence.checks.map((check, index) => <div key={index} className="border-t border-border py-2">
          <p>{t('detail.checkLine', { stage: check.stage === 'base' ? t('detail.checkBefore') : t('detail.checkAfter'), id: check.id, exitCode: check.exitCode ?? t('detail.exitNone'), durationMs: check.durationMs })}{check.timedOut ? t('detail.timedOut') : ''}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono">{check.output}</pre>
        </div>)}
        {run.validationEvidence.checks.length === 0 && <p className="text-muted-foreground">{t('detail.noChecks')}</p>}
      </details>}

      {run.pr ? (
        <PrReviewPanel
          run={run}
          readOnly={readOnly}
          onRunChange={(next) => onRunChange?.(next)}
          onRefresh={() => onRefresh?.()}
        />
      ) : (
        // PR 이 없는 실행(진행 중·중단) — 사실만 몇 줄
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 py-1 text-sm leading-snug [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
          <dt>{t('detail.dt.evidence')}</dt>
          <dd className="tabular-nums">
            {t.rich('detail.evidenceItems', { count: run.evidence.insightCount, ...bold })}
            {run.evidence.conversationCount > 0 && (
              <>
                {' · '}
                {t.rich('detail.evidencePeople', { count: run.evidence.conversationCount, ...bold })}
              </>
            )}
          </dd>
          <dt>{t('detail.dt.repo')}</dt>
          <dd>{run.repo ?? <span className="text-faint">{t('detail.noRepo')}</span>}</dd>
          {run.errorMessage && (
            <>
              <dt>{t('detail.dt.stopDetail')}</dt>
              <dd className="text-[#8a5c06] dark:text-[#e2b34f]">{run.errorMessage}</dd>
            </>
          )}
          <dt>{t('detail.dt.elapsed')}</dt>
          <dd className="tabular-nums">
            {duration(run.durationMs) || (state === 'running' ? t('detail.running') : '—')} · {t('detail.startedAt', { when: fmt(run.createdAt) })}
          </dd>
        </dl>
      )}

      {run.pr && (
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 py-1 text-sm leading-snug [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
          <dt>{t('detail.dt.elapsed')}</dt>
          <dd className="tabular-nums">
            {duration(run.durationMs) || '—'} · {t('detail.startedAt', { when: fmt(run.createdAt) })}
          </dd>
          {run.pr.closedAt && !run.pr.mergedAt && (
            <>
              <dt>{t('detail.dt.closedNotShipped')}</dt>
              <dd className="tabular-nums">{t('detail.closedLine', { when: fmt(run.pr.closedAt) })}</dd>
              <dt>{t('detail.dt.reason')}</dt>
              <dd>
                <CloseReasonControl run={run} readOnly={readOnly} onRunChange={onRunChange} />
              </dd>
            </>
          )}
          {run.pr.mergedAt && (
            <>
              <dt>{t('detail.dt.shipped')}</dt>
              <dd className="tabular-nums">
                {fmt(run.pr.mergedAt)}
                {delivered.length > 0 && t('detail.shippedNotified', { count: delivered.length, time: fmt(firstReturnAt, true) })}
              </dd>
            </>
          )}
        </dl>
      )}

      {/* 되돌림 — 반영된 PR 에만 의미가 있다 */}
      {state === 'merged' && (
        <section className="flex flex-col gap-1 pt-2">
          {/* 설명은 제목 옆이 아니라 아래 한 줄로(v4 §5) */}
          <h3 className="text-[15px] font-bold tracking-[-0.01em]">{t('detail.notify.title')}</h3>
          <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
            {t('detail.notify.sub')}
          </p>
          {run.returns.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t('detail.notify.empty')}
            </p>
          ) : (
            <ul className="mt-2">
              {run.returns.map((r) => (
                <li
                  key={r.conversationId}
                  className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-border py-3.5 first:border-t-0 sm:grid-cols-[36px_minmax(0,1fr)_auto_auto] sm:gap-3"
                >
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                    {r.name.slice(0, 1)}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                    <span className="truncate">{r.name}</span>
                    <ChannelChip source={r.source} />
                  </span>
                  {/* 폰 폭은 이름 아래 줄(둘째 칸)로 내려간다 — 한 줄에 넷을 두면 「Not delivered」가 잘렸다 */}
                  <span className="col-start-2 text-[12.5px] text-muted-foreground tabular-nums sm:col-start-auto sm:whitespace-nowrap">
                    {r.deliveredAt ? (
                      <>
                        <b className="font-semibold text-foreground">{t('detail.notify.delivered')}</b> · {fmt(r.deliveredAt, true)}
                      </>
                    ) : (
                      t('detail.notify.waiting')
                    )}
                    {/* 이메일은 채널과 별개로 지금 나간다 — 카카오 대기 중이어도 메일은 이미 갔을 수 있다 */}
                    {emailNote(r)}
                    {r.emailError && <span className="block max-w-md whitespace-normal break-words text-[12.5px] text-destructive">{r.emailError.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}</span>}
                  </span>
                  <span className="col-start-2 sm:col-start-auto">
                    <Confirmation r={r} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(pending.channel > 0 || retryResult) && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                {pending.channel > 0 && (
                  <>
                    <span className="text-sm font-semibold tabular-nums">
                      {t('detail.notify.channelFailed', { count: pending.channel })}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRedeliver}
                      disabled={retrying || readOnly}
                    >
                      {retrying ? <Loader2 className="animate-spin" /> : t('detail.notify.resend')}
                    </Button>
                  </>
                )}
                {retryResult && (
                  <span className="text-[12.5px] text-muted-foreground">{retryResult.headline}</span>
                )}
              </div>
              {/* 더 눌러도 안 나가는 것 — 버튼을 계속 누르게 두지 않으려고 색을 다르게 준다 */}
              {retryResult?.warning && (
                <p className="text-[12.5px] leading-[1.45] text-[#8a5c06] dark:text-[#e2b34f]">
                  {retryResult.warning}
                </p>
              )}
              {/* 실패가 아니라 정상 동작 — 중립으로 둔다 */}
              {retryResult?.note && (
                <p className="text-[12.5px] leading-[1.45] text-muted-foreground">{retryResult.note}</p>
              )}
            </div>
          )}
          {pending.kakao > 0 && (
            <p className="pt-1 text-[12.5px] leading-[1.45] text-muted-foreground tabular-nums">
              {t('detail.notify.kakaoPending', { count: pending.kakao })}
            </p>
          )}
          <p className="flex items-start gap-1.5 pt-1 text-[12.5px] leading-[1.45] text-muted-foreground">
            <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
            {t('detail.notify.kakaoNote')}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2 pt-2">
        <h3 className="text-[15px] font-bold tracking-[-0.01em]">{t('detail.log.title')}</h3>
        <TerminalLog streamUrl={streamUrl} staticLines={staticLines} onComplete={onComplete} onSettled={onSettled} />
        <p className={cn('flex items-start gap-1.5 pt-1 text-[12.5px] leading-[1.45] text-muted-foreground')}>
          <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
          {t('detail.log.note')}
        </p>
      </section>
    </div>
  );
}

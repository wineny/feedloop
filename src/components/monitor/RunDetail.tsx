'use client';

// 수정 PR 상세 — 판단 재료 · 담당자용 설명 · 바뀐 코드 · 행동(반영 / 반영하지 않기) · 되돌림 · 실행 로그.
// 되돌림은 별도 탭이 아니라 여기서 본다: PR 하나가 반영되면 그 문제를 말한 사람 모두에게 나가므로
// PR 을 기준으로 묶여야 읽힌다. PR 이 있는 실행의 검토·행동은 `PrReviewPanel` 이 맡는다 (I-19).

import { useRef, useState } from 'react';
import { ChevronRight, Check, X, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CLOSE_REASONS,
  CLOSE_REASON_LABEL,
  CLOSE_REASON_HINT,
  CLOSE_NOTE_MAX,
  type CloseReason,
} from '@/lib/auto-dev/close-reason';
import { stopReasonLabel } from '@/lib/auto-dev/stop-reason-labels';
import { Button } from '@/components/ui/button';
import { ChannelChip } from '@/components/dashboard/RecentFeedback';
import {
  buildRetryMessage,
  countUndeliveredBySource,
  parseRunRetryOutcome,
  type RetryMessage,
} from '@/lib/monitor/redeliver-message';
import { TerminalLog, type CompletionData } from '@/components/monitor/TerminalLog';
import { RunBadge, runState } from '@/components/monitor/RunBadge';
import { PrReviewPanel } from '@/components/monitor/PrReviewPanel';
import type { RunItem, RunReturn } from '@/app/api/auto-dev/runs/route';

/**
 * 배포 확인이 「모름」인 이유를 사람 말로 옮긴다.
 *
 * `checkDeployment`(lib/auto-dev/loop-closed.ts)가 돌려주는 식별자가 화면에 그대로 찍혀
 * 「배포 미확인 · environment_not_configured」처럼 보였다. 심사자가 읽는 화면에 내부 식별자를
 * 두지 않는다. 모르는 값이 오면 원래 문자열을 그대로 보여준다 — 조용히 숨기면 새 사유가
 * 생겼을 때 아무 말도 안 하는 화면이 된다.
 */
const DEPLOYMENT_REASON_LABEL: Record<string, string> = {
  environment_not_configured: '배포 환경이 연결돼 있지 않아요',
  merge_sha_unknown: '반영 기록을 찾지 못했어요',
};

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

const dateTime = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

function fmt(value: string | null | undefined, f: Intl.DateTimeFormat = dateTime): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : f.format(d);
}

function duration(ms: number | null): string {
  if (ms == null) return '';
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}

function Confirmation({ r }: { r: RunReturn }) {
  if (!r.deliveredAt) return <span className="text-[12.5px] font-medium text-faint">전달 전</span>;
  if (r.confirmation === 'fixed') {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-strong">
        <Check className="h-3 w-3" aria-hidden />네, 잘 돼요
      </span>
    );
  }
  if (r.confirmation === 'not_fixed') {
    return (
      <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-destructive">
        <X className="h-3 w-3" aria-hidden />아직 그대로예요
      </span>
    );
  }
  return <span className="text-[12.5px] font-medium text-faint">응답 없음</span>;
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
        if (!res.ok) throw new Error(json.error || '저장하지 못했습니다');
        persisted.current = { reason: json.closeReason ?? null, note: json.closeNote ?? '' };
        onRunChange?.({ ...run, pr: { ...run.pr!, closeReason: json.closeReason, closeNote: json.closeNote } });
        if (!json.closeReason) setNote('');
      } catch (err) {
        // 화면이 DB 와 다른 말을 하면 이 기능의 목적(정확한 실패 집계)이 무너진다 — 마지막 저장값으로 되돌린다
        setReason(persisted.current.reason);
        setNote(persisted.current.note);
        setError(err instanceof Error ? err.message : '저장하지 못했습니다');
      } finally {
        setSaving(false);
      }
    });
  };

  if (readOnly) {
    return (
      <span className="text-sm">
        {reason ? CLOSE_REASON_LABEL[reason] : <span className="text-faint">사유 미분류</span>}
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
          aria-label="반영하지 않은 이유"
          title={reason ? CLOSE_REASON_HINT[reason] : '이유를 골라두면 어떤 실수가 반복되는지 보입니다'}
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
          <option value="">사유 미분류</option>
          {CLOSE_REASONS.map((r) => (
            <option key={r} value={r}>
              {CLOSE_REASON_LABEL[r]}
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
          placeholder="메모 (선택) — 무엇이 틀렸는지 한 줄"
          aria-label="반영하지 않은 이유 메모"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (persisted.current.note !== note.trim()) save(reason, note);
          }}
          className="h-8 w-full max-w-md rounded-md border border-border bg-background px-2 text-sm placeholder:text-faint"
        />
      )}
      {reason && <p className="text-[12.5px] leading-[1.45] text-faint">{CLOSE_REASON_HINT[reason]}</p>}
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
  const state = runState(run);
  const delivered = run.returns.filter((r) => r.deliveredAt);
  const firstReturnAt = delivered.map((r) => r.deliveredAt!).sort()[0];
  const pending = countUndeliveredBySource(run.returns);

  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<RetryMessage | null>(null);

  // 채널톡 되돌림만 여기서 다시 민다. 카카오는 «실패»가 아니라 대기열이라 밀 곳이 없다.
  const handleRedeliver = async () => {
    setRetrying(true);
    setRetryResult(null);
    try {
      const res = await fetch(`/api/auto-dev/runs/${run.id}/redeliver`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '재전송하지 못했습니다');
      // 형태를 확인하고 넘긴다 — 어긋나면 「보낼 되돌림이 없어요」로 조용히 잘못 뜬다.
      setRetryResult(buildRetryMessage(parseRunRetryOutcome(json)));
      // 보낸 건 목록의 「전달됨」으로 바뀌어야 한다 — 한 칸만 고치지 않고 다시 읽는다.
      onRefresh?.();
    } catch (err) {
      setRetryResult({
        headline: err instanceof Error ? err.message : '재전송하지 못했습니다',
        warning: null,
        note: null,
      });
    } finally {
      setRetrying(false);
    }
  };

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
          <a
            href={run.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12.5px] font-semibold text-muted-foreground hover:underline sm:mt-1.5"
          >
            GitHub 에서 PR #{run.pr.number} 보기
            <ChevronRight className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>

      {/* 상태 4행 — 값은 잉크색 반굵게, 라벨만 회색. 전부 같은 회색이면 상태로 안 읽힌다 */}
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm leading-snug [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:font-semibold [&_dt]:text-muted-foreground">
        <dt>실행 검증</dt>
        <dd>{run.validationStatus === 'validated' && run.validationEvidence?.checks?.length ? '실행 검증 통과' : run.validationStatus === 'failed' ? '검증 실패' : run.validationStatus === 'stopped' ? '검증 중단' : run.validationStatus === 'unverifiable' ? '격리 검증 안 됨' : '실행 검증 미확인'}{run.validationEvidence?.reason && <span className="font-normal text-muted-foreground"> · {run.validationEvidence.reason}</span>}</dd>
        <dt>PR 생성</dt><dd>{run.pr ? '생성됨' : run.publicationStatus === 'pending' ? '생성 결과 확인 중 · 중복 생성 보류' : '생성 전'}</dd>
        <dt>배포 확인</dt><dd>{run.deploymentStatus === 'success' ? '배포 성공 보고됨' : run.deploymentStatus === 'failed' ? '배포 실패' : run.deploymentStatus === 'pending' ? '배포 진행 중' : '배포 미확인'}{run.deploymentReason && <span className="font-normal text-muted-foreground"> · {DEPLOYMENT_REASON_LABEL[run.deploymentReason] ?? run.deploymentReason}</span>}</dd>
        <dt>사용자 확인</dt><dd>{run.returns.some(r => r.confirmation === 'not_fixed') ? '미해결 응답 있음' : run.returns.length > 0 && run.returns.every(r => r.confirmation === 'fixed') ? '제보자 모두 해결 확인' : '해결 확인 대기'}</dd>
        {run.stopReason && <><dt>중단 이유</dt><dd>{stopReasonLabel(run.stopReason)}{stopReasonLabel(run.stopReason) !== run.stopReason && <span className="font-normal text-muted-foreground"> · {run.stopReason}</span>}</dd></>}
        {run.followUpError && <><dt>후속 확인 오류</dt><dd className="text-destructive">{run.followUpError} · 「반영됐는지 확인」으로 다시 확인할 수 있습니다</dd></>}
      </dl>
      {run.validationEvidence && <details className="rounded-[10px] border border-border px-4 py-3 text-[12.5px] leading-[1.45]">
        <summary className="cursor-pointer font-semibold">실행한 검사와 결과 · 시도 {run.validationEvidence.attempt}</summary>
        <p className="break-all py-2 text-muted-foreground">기준 커밋 {run.validationEvidence.baseSha} · 패치 {run.validationEvidence.patchDigest}</p>
        {run.validationEvidence.checks.map((check, index) => <div key={index} className="border-t border-border py-2">
          <p>{check.stage === 'base' ? '수정 전' : '수정 후'} · {check.id} · 종료 코드 {check.exitCode ?? '없음'} · {check.durationMs}ms{check.timedOut ? ' · 시간 초과' : ''}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono">{check.output}</pre>
        </div>)}
        {run.validationEvidence.checks.length === 0 && <p className="text-muted-foreground">실행된 검사 기록이 없습니다.</p>}
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
          <dt>근거 피드백</dt>
          <dd className="tabular-nums">
            <b className="font-semibold">{run.evidence.insightCount}</b>건
            {run.evidence.conversationCount > 0 && (
              <>
                {' · '}
                <b className="font-semibold">{run.evidence.conversationCount}</b>명
              </>
            )}
          </dd>
          <dt>저장소</dt>
          <dd>{run.repo ?? <span className="text-faint">저장소 없음</span>}</dd>
          {run.errorMessage && (
            <>
              <dt>중단 사유</dt>
              <dd className="text-[#8a5c06] dark:text-[#e2b34f]">{run.errorMessage}</dd>
            </>
          )}
          <dt>소요</dt>
          <dd className="tabular-nums">
            {duration(run.durationMs) || (state === 'running' ? '진행 중' : '—')} · {fmt(run.createdAt)} 시작
          </dd>
        </dl>
      )}

      {run.pr && (
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2.5 py-1 text-sm leading-snug [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted-foreground">
          <dt>소요</dt>
          <dd className="tabular-nums">
            {duration(run.durationMs) || '—'} · {fmt(run.createdAt)} 시작
          </dd>
          {run.pr.closedAt && !run.pr.mergedAt && (
            <>
              <dt>반영 안 하고 닫음</dt>
              <dd className="tabular-nums">{fmt(run.pr.closedAt)} · 반영하지 않고 닫았어요. 반영 알림은 나가지 않습니다</dd>
              <dt>이유</dt>
              <dd>
                <CloseReasonControl run={run} readOnly={readOnly} onRunChange={onRunChange} />
              </dd>
            </>
          )}
          {run.pr.mergedAt && (
            <>
              <dt>반영</dt>
              <dd className="tabular-nums">
                {fmt(run.pr.mergedAt)}
                {delivered.length > 0 && ` · 반영 알림 ${delivered.length}건이 ${fmt(firstReturnAt, timeOnly)} 에 나갔어요`}
              </dd>
            </>
          )}
        </dl>
      )}

      {/* 되돌림 — 반영된 PR 에만 의미가 있다 */}
      {state === 'merged' && (
        <section className="flex flex-col gap-1 pt-2">
          {/* 설명은 제목 옆이 아니라 아래 한 줄로(v4 §5) */}
          <h3 className="text-[15px] font-bold tracking-[-0.01em]">반영 알림</h3>
          <p className="text-[12.5px] leading-[1.45] text-muted-foreground">
            반영됐다고 알립니다. 배포와 문제 해결은 따로 확인합니다
          </p>
          {run.returns.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              아직 나간 반영 알림이 없어요. 「반영됐는지 확인」을 누르면 반영을 감지해 보냅니다.
            </p>
          ) : (
            <ul className="mt-2">
              {run.returns.map((r) => (
                <li
                  key={r.conversationId}
                  className="grid grid-cols-[36px_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-border py-3.5 first:border-t-0"
                >
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                    {r.name.slice(0, 1)}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                    <span className="truncate">{r.name}</span>
                    <ChannelChip source={r.source} />
                  </span>
                  <span className="whitespace-nowrap text-[12.5px] text-muted-foreground tabular-nums">
                    {r.deliveredAt ? (
                      <>
                        <b className="font-semibold text-foreground">전달됨</b> · {fmt(r.deliveredAt, timeOnly)}
                      </>
                    ) : (
                      '대기 · 다음에 말을 걸 때 전달'
                    )}
                    {/* 이메일은 채널과 별개로 지금 나간다 — 카카오 대기 중이어도 메일은 이미 갔을 수 있다 */}
                    {r.emailDeliveryStatus === 'delivery_unknown' ? (
                      <> · 메일 전달 확인 필요 · 제공업체 확인 전 재발송 보류</>
                    ) : r.emailDeliveryStatus === 'failed' ? (
                      <> · 메일 전송 실패 · 재시도 가능</>
                    ) : r.emailDeliveryStatus === 'skipped' ? (
                      // 재제보 합류(B1)로 만든 되돌림. 메일을 «일부러» 안 붙였다 —
                      // 안 쓰면 대기 중인 행과 똑같이 보여 운영자가 장애로 읽는다.
                      <> · 메일 안 보냄 · 재제보 합류</>
                    ) : r.emailSentAt ? <> · 메일 발송</> : null}
                    {r.emailError && <span className="block max-w-md whitespace-normal break-words text-[12.5px] text-destructive">{r.emailError.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}</span>}
                  </span>
                  <Confirmation r={r} />
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
                      채널톡 {pending.channel}건 못 보냄
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRedeliver}
                      disabled={retrying || readOnly}
                    >
                      {retrying ? <Loader2 className="animate-spin" /> : '반영 알림 다시 보내기'}
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
              카카오톡 {pending.kakao}건은 그 사람이 다음에 말을 걸 때 전달됩니다. 여기서 밀 수
              있는 것이 아니에요.
            </p>
          )}
          <p className="flex items-start gap-1.5 pt-1 text-[12.5px] leading-[1.45] text-muted-foreground">
            <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
            카카오톡 대화는 상대가 다음에 말을 걸 때 답변 앞에 붙어 갑니다. 「아직 그대로예요」는 대화 탭에서 이어서
            봅니다.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2 pt-2">
        <h3 className="text-[15px] font-bold tracking-[-0.01em]">실행 로그</h3>
        <TerminalLog streamUrl={streamUrl} staticLines={staticLines} onComplete={onComplete} onSettled={onSettled} />
        <p className={cn('flex items-start gap-1.5 pt-1 text-[12.5px] leading-[1.45] text-muted-foreground')}>
          <Clock className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden />
          실제 실행 결과는 위 검사 기록에서 확인하세요. 기록이 없으면 검증 미확인입니다. 반영, 배포, 사용자 해결 확인은 각각 다른 단계입니다.
        </p>
      </section>
    </div>
  );
}

'use client';

// 「수정 PR」 상세의 검토·행동 영역 — 담당자가 Feedloop 안에서 반영 여부를 정한다 (I-19).
//
// 읽는 순서가 판단 순서다: 판단 재료(근거·프리뷰·빌드) → 담당자용 설명(+확인하지 못한 것) →
// 바뀐 코드(접힘, 개발자용) → 행동. 코랄 주 CTA 는 「서비스에 반영하기」 하나. 부작용(누구에게
// 몇 건, 커밋 저자, 브랜치 삭제)은 버튼 옆 한 문장에 전부 적는다.
// 어휘는 「반영」— 위젯·메일이 방문자에게 「반영됐어요」라고 말하므로 버튼도 같은 말을 쓴다.

import { useReducer } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/monitor/DiffView';
import {
  effectiveBlock,
  isTransientGateBlock,
  usePrReview,
  type DraftGateBlocked,
  type PrBlockReason,
  type PrReviewData,
} from '@/lib/hooks/usePrReview';
import { MERGE_BLOCK_MESSAGE, VERDICT_LABEL } from '@/lib/auto-dev/review-labels';
import {
  CLOSE_REASONS,
  CLOSE_REASON_LABEL,
  CLOSE_REASON_HINT,
  CLOSE_NOTE_MAX,
  type CloseReason,
} from '@/lib/auto-dev/close-reason';
import type { RunExplanation, UnverifiedItem } from '@/lib/auto-dev/explanation';
import type { PickedTarget } from '@/lib/auto-dev/picked-targets';
import type { PickedShotData } from '@/lib/widget/picked-shot';
import { PickedShot } from '@/components/picked/PickedShot';
import type { RunItem } from '@/app/api/auto-dev/runs/route';

interface PrReviewPanelProps {
  run: RunItem;
  /** 데모 모드 — GitHub 를 읽지 않고 행동도 없다 */
  readOnly?: boolean;
  onRunChange: (run: RunItem) => void;
  /** 반영 뒤 되돌림 목록을 채우려고 목록을 다시 읽는다 */
  onRefresh: () => void;
}

// ─── 행동 상태 ────────────────────────────────────────────────────────────────

interface ActionState {
  mode: 'idle' | 'closing' | 'merging' | 'submitting_close';
  verifying: number | null;
  reason: CloseReason | null;
  note: string;
  notice: string | null;
  error: string | null;
}

type ActionEvent =
  | { type: 'open_close' }
  | { type: 'cancel_close' }
  | { type: 'pick_reason'; reason: CloseReason }
  | { type: 'note'; note: string }
  | { type: 'merge_start' }
  | { type: 'close_start' }
  | { type: 'verify_start'; index: number }
  // 확인시키기는 「반영하지 않기」 폼과 무관하다 — 끝나도 mode·사유·메모를 건드리지 않는다
  | { type: 'verify_done' }
  | { type: 'verify_fail'; error: string }
  | { type: 'done'; notice: string | null }
  | { type: 'fail'; error: string };

export const INITIAL: ActionState = { mode: 'idle', verifying: null, reason: null, note: '', notice: null, error: null };

export function reduce(state: ActionState, e: ActionEvent): ActionState {
  switch (e.type) {
    case 'open_close':
      return { ...state, mode: 'closing', error: null };
    case 'cancel_close':
      return { ...state, mode: 'idle', reason: null, note: '', error: null };
    case 'pick_reason':
      return { ...state, reason: e.reason };
    case 'note':
      return { ...state, note: e.note };
    case 'merge_start':
      return { ...state, mode: 'merging', error: null, notice: null };
    case 'close_start':
      return { ...state, mode: 'submitting_close', error: null };
    case 'verify_start':
      return { ...state, verifying: e.index, error: null };
    case 'verify_done':
      return { ...state, verifying: null, error: null };
    case 'verify_fail':
      return { ...state, verifying: null, error: e.error };
    case 'done':
      return { ...state, mode: 'idle', verifying: null, reason: null, note: '', notice: e.notice, error: null };
    case 'fail':
      return { ...state, mode: state.mode === 'submitting_close' ? 'closing' : 'idle', verifying: null, error: e.error };
  }
}

// ─── 조각 ────────────────────────────────────────────────────────────────────

function Dot({ tone }: { tone: 'ok' | 'bad' | 'wait' | 'off' }) {
  return (
    <i
      aria-hidden
      className={cn(
        'inline-block h-2 w-2 rounded-full',
        tone === 'ok' && 'bg-[#1e6b3a] dark:bg-[#7ed69a]',
        tone === 'bad' && 'bg-[#a13a2f] dark:bg-[#f0a19a]',
        tone === 'wait' && 'animate-pulse bg-faint',
        tone === 'off' && 'bg-border-strong',
      )}
    />
  );
}

/** 판단 재료 세 칸 — /bots 의 「칸 = 상태 + 그 상태를 바꾸는 링크 하나」 규칙 */
function Facts({ run, review, targets, shots, loading, error }: { run: RunItem; review: PrReviewData | null; targets: PickedTarget[]; shots: PickedShotData[]; loading: boolean; error: string | null }) {
  const merged = Boolean(run.pr?.mergedAt);
  const build = review?.build;
  const preview = review?.preview;
  return (
    // 판단 재료 세 칸은 카드 한 장(v4 §4-2). 칸 사이는 헤어라인, 카드 밖은 캔버스
    <dl className="card-surface grid grid-cols-1 p-5 sm:grid-cols-3 sm:p-6">
      <div className="pb-4 sm:pb-0 sm:pr-5">
        <dt className="mb-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">근거 피드백</dt>
        <dd className="text-xl font-extrabold leading-none tracking-[-0.02em] tabular-nums">
          {run.evidence.insightCount}
          <small className="ml-0.5 text-sm font-medium tracking-normal text-muted-foreground">건</small>
          {run.evidence.conversationCount > 0 && (
            <>
              <span className="mx-1.5 font-normal text-faint">·</span>
              {run.evidence.conversationCount}
              <small className="ml-0.5 text-sm font-medium tracking-normal text-muted-foreground">명</small>
            </>
          )}
        </dd>
        <dd className="mt-1.5 truncate text-[12.5px] leading-[1.45] text-faint">{run.repo ?? '저장소 없음'}</dd>
        {/* 짚는 순간 찍은 화면(I-55) — 누르면 크게. 「그린다」 줄은 아래에 그대로 */}
        {shots.length > 0 && (
          <dd className="mt-2.5 flex flex-wrap gap-2">
            {shots.map((d, i) => (
              <PickedShot key={i} data={d} size="fact" />
            ))}
          </dd>
        )}
        {/* 제보자가 화면에서 짚은 요소 — 「그린다」까지만. 원인이 거기 있다는 뜻이 아니다(PR #6) */}
        {targets.map((t, i) => (
          <dd key={i} className="mt-1.5 text-[12.5px] leading-[1.45]" title={t.evidence ? `원본에서 확인: ${t.evidence}` : undefined}>
            <span className="text-muted-foreground">짚은 요소 </span>
            <span className="font-medium">{t.label}</span>
            {t.status === 'confirmed' ? (
              <>
                <span className="text-faint"> → </span>
                <span className="break-all font-mono text-[12.5px]">{t.files.map((f) => f.split('/').pop()).join(', ')}</span>
                <span className="text-muted-foreground"> 이(가) 그려요</span>
              </>
            ) : (
              <span className="text-muted-foreground"> · 저장소 원본에서 확인 못 함</span>
            )}
          </dd>
        ))}
      </div>

      <div className="border-t border-border pt-4 sm:border-l sm:border-t-0 sm:px-5 sm:pt-0">
        <dt className="mb-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">프리뷰</dt>
        <dd className="text-sm font-semibold">
          {merged ? (
            '반영됨 · 배포는 따로 확인'
          ) : preview?.url ? (
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-brand-strong hover:underline"
            >
              프리뷰 열기 <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : loading ? (
            <span className="text-faint">읽는 중…</span>
          ) : preview?.state === 'building' ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Dot tone="wait" />만들고 있어요</span>
          ) : (
            <span className="text-faint">프리뷰 없음</span>
          )}
        </dd>
        {preview?.url && !merged && (
          <dd className="mt-1 truncate font-mono text-[12.5px] text-muted-foreground">{preview.url.replace(/^https:\/\//, '')}</dd>
        )}
        <dd className="mt-1 text-[12.5px] leading-[1.45] text-faint">
          {merged
            ? '반영 뒤 프리뷰가 제공되는지는 배포 서비스에 따라 달라요'
            : preview?.url
              ? 'Vercel 에 로그인돼 있어야 열려요'
              : preview?.state === 'building'
                ? '배포가 끝나면 링크가 생겨요'
                : review && !preview?.url
                  ? '이 저장소엔 프리뷰 배포가 없어요'
                  : ' '}
        </dd>
      </div>

      <div className="border-t border-border pt-4 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
        <dt className="mb-1.5 text-[12.5px] leading-[1.45] text-muted-foreground">빌드</dt>
        <dd className="inline-flex items-center gap-1.5 text-sm font-semibold">
          {error ? (
            <><Dot tone="off" />못 읽었어요</>
          ) : !build ? (
            <span className="text-faint">{loading ? '읽는 중…' : '—'}</span>
          ) : build.state === 'success' ? (
            <><Dot tone="ok" />통과</>
          ) : build.state === 'failure' ? (
            <><Dot tone="bad" />실패</>
          ) : build.state === 'pending' ? (
            <><Dot tone="wait" />진행 중</>
          ) : (
            <><Dot tone="off" />알 수 없음</>
          )}
        </dd>
        <dd className="mt-1 text-[12.5px] leading-[1.45] text-faint">
          {error
            ? error
            : build?.state === 'unknown'
              ? build.unavailable
                ? '빌드 상태를 물어볼 수 없었어요 — 토큰에 Checks·Commit statuses 권한이 없거나 GitHub 이 거절했어요. 확인 없이 반영하게 돼요'
                : // 초안 대기 중엔 버튼이 잠겨 있다 — 「막지 않아요」는 아래 상태 한 줄과 어긋난다
                  review?.draftGate === 'waiting'
                  ? 'Vercel 이 연결되지 않은 저장소예요'
                  : 'Vercel 이 연결되지 않은 저장소예요. 반영은 막지 않아요'
              : build?.description
                ? [build.description, build.targetUrl ? null : undefined].filter(Boolean).join('')
                : ' '}
          {build?.targetUrl && build.state !== 'unknown' && (
            <>
              {' · '}
              <a href={build.targetUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-foreground hover:underline">
                빌드 로그
              </a>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** 서버 판정 문구에 초안 대기·수동 초안을 더한다 — 서버 파일(review-labels)은 이번 작업 범위 밖이라 화면에서 잇는다 */
const BLOCK_MESSAGE: Record<PrBlockReason, string> = {
  ...MERGE_BLOCK_MESSAGE,
  draft_waiting: '자동 검사를 기다리는 초안이에요. 검토 요청으로 바뀌면 반영할 수 있어요',
  manual_draft: '담당자가 다시 초안으로 돌려 둔 PR 이에요. GitHub 에서 검토 요청으로 바꾸면 반영할 수 있어요',
};

/** 반영 요청이 409 로 돌아온 이유(`reason`)를 쉬운 말로. 서버 문구는 개발자 말투라 화면 어휘로 다시 쓴다 */
const MERGE_REASON_MESSAGE: Record<DraftGateBlocked, string> = {
  lock_unavailable: '잠시 문제가 있어 반영을 멈췄어요. 잠시 후 다시 눌러 주세요',
  write_failed: '잠시 문제가 있어 반영을 멈췄어요. 잠시 후 다시 눌러 주세요',
  gate_failed: '잠시 문제가 있어 반영을 멈췄어요. 잠시 후 다시 눌러 주세요',
  manual_draft: BLOCK_MESSAGE.manual_draft,
  checks_unavailable: '검사 결과를 읽을 권한이 없어 반영을 멈췄어요. GitHub 에서 검사 조회 권한을 확인한 뒤 다시 눌러 주세요',
};

/** 반영 실패 응답 → 버튼 아래 문구. 아는 `reason` 이면 화면 문구, 모르면 서버 `error`, 그것도 없으면 기본 문구 */
export function mergeErrorMessage(json: { error?: unknown; reason?: unknown } | null): string {
  const reason = json?.reason;
  if (typeof reason === 'string' && Object.hasOwn(MERGE_REASON_MESSAGE, reason)) return MERGE_REASON_MESSAGE[reason as DraftGateBlocked];
  return typeof json?.error === 'string' && json.error ? json.error : '반영하지 못했어요';
}

/** 이미 서버가 https 만 남겨 오지만, 링크로 거는 건 화면이라 한 번 더 본다 */
function safeHref(url: string | null): string | null {
  return url && url.startsWith('https://') ? url : null;
}

type GateLineKind = 'waiting' | 'failed' | 'promoted' | 'unsupported' | 'human' | 'manual' | 'transient';

/** 어떤 줄을 그릴지 — 빌드 실패가 가장 중요한 사실이고, 그다음 사람이 해야 할 일, 그다음 잠깐 실패 */
function gateLineKind(review: Pick<PrReviewData, 'draftGate' | 'draftGateBlocked'>): GateLineKind | null {
  const { draftGate: gate, draftGateBlocked: blocked } = review;
  if (!gate) return null;
  if (gate === 'failed') return 'failed';
  if (blocked === 'manual_draft') return 'manual';
  if (gate === 'awaiting_human' || blocked === 'checks_unavailable') return 'human';
  if (isTransientGateBlock(blocked)) return 'transient';
  return gate === 'not_draft' ? null : gate;
}

const GATE_LINE_TONE: Record<GateLineKind, 'ok' | 'bad' | 'wait' | 'off'> = {
  waiting: 'wait', transient: 'wait', failed: 'bad', promoted: 'ok', unsupported: 'off', human: 'off', manual: 'off',
};

/**
 * 초안 PR 상태 한 줄 — 자동 PR 은 초안으로 열리고 고객 레포의 자동 검사를 지나야 검토 요청이 된다.
 * 옛 PR(not_draft)·데모(필드 없음)는 아무것도 안 그린다. 검사 없이 10분 뒤 바뀐 PR 에 「통과」라고 말하지 않는다.
 */
export function DraftGateLine({ review }: { review: Pick<PrReviewData, 'draftGate' | 'draftGateBlocked' | 'build'> | null }) {
  const kind = review ? gateLineKind(review) : null;
  if (!review || !kind) return null;
  const noChecks = review.build.state === 'unknown';
  const failedChecks = review.build.failedChecks ?? [];
  const [title, tail] = {
    waiting: ['자동 검사를 기다리는 중이에요', noChecks ? '확인할 검사가 없으면 PR 을 연 지 10분 뒤 검토 요청으로 바뀌어요' : '통과하면 검토 요청으로 바뀌어요'],
    failed: ['자동 검사에 실패해 초안으로 두었어요', null],
    promoted: [noChecks ? '확인할 자동 검사가 없어 PR 을 연 지 10분 뒤 검토 요청으로 바꿨어요' : '자동 검사를 통과해 검토 요청으로 바뀌었어요', null],
    unsupported: ['이 레포는 초안 PR 을 지원하지 않아 바로 열었어요', null],
    human: ['검사 결과를 읽을 권한이 없어 자동으로 바꾸지 않았어요', '직접 확인하고 반영하세요'],
    manual: ['담당자가 다시 초안으로 돌려 둔 PR 이에요', '자동으로 바꾸지 않아요'],
    transient: ['잠시 문제가 있어 자동으로 바꾸지 못했어요', '잠시 후 다시 확인해요'],
  }[kind];
  return (
    <p className="mt-3 flex items-start gap-2 text-sm leading-[1.55]">
      <span className="mt-[7px] inline-flex">
        <Dot tone={GATE_LINE_TONE[kind]} />
      </span>
      <span className="min-w-0">
        <span className={cn(kind === 'unsupported' ? 'text-muted-foreground' : 'font-semibold')}>{title}</span>
        {tail && <span className="text-muted-foreground">{` · ${tail}`}</span>}
        {kind === 'failed' && failedChecks.length > 0 && (
          <span className="text-muted-foreground">
            {' · 실패한 검사: '}
            {failedChecks.map((c, i) => {
              const href = safeHref(c.url);
              return (
                <span key={`${c.name}-${i}`}>
                  {i > 0 && ', '}
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-foreground hover:underline">
                      {c.name}
                    </a>
                  ) : (
                    <span className="font-semibold text-foreground">{c.name}</span>
                  )}
                </span>
              );
            })}
          </span>
        )}
      </span>
    </p>
  );
}

const VERIFIABLE_HOW: Record<UnverifiedItem['verifiableBy'], string> = {
  code: '코드로 확인할 수 있어요',
  reporter: '코드로는 확인할 수 없어요 · 제보자만 알아요',
  human: '사람이 프리뷰에서 직접 봐야 해요',
};

function Unverified({
  items,
  runId,
  readOnly,
  open,
  verifying,
  onVerify,
  onCloseWithReason,
}: {
  items: UnverifiedItem[];
  runId: string;
  readOnly?: boolean;
  /** 열린 PR 일 때만 손잡이가 붙는다 */
  open: boolean;
  verifying: number | null;
  onVerify: (index: number) => void;
  onCloseWithReason: (reason: CloseReason) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 grid gap-x-4 gap-y-2 rounded-[10px] bg-[#fbf0d3] px-4 py-3.5 text-[#8a5c06] dark:bg-[#37301a] dark:text-[#e2b34f] sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt className="inline-flex items-start gap-1.5 whitespace-nowrap text-sm font-bold leading-[1.55]">
        <TriangleAlert className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden />
        확인하지 못한 것
      </dt>
      <ul className="m-0 flex list-disc flex-col gap-2 pl-4 text-sm leading-[1.55]">
        {items.map((item, i) => {
          const v = item.verdict;
          return (
            <li key={`${runId}-${i}`} className="flex flex-col gap-1.5">
              <span>{item.text}</span>
              {v ? (
                <span
                  className={cn(
                    '-ml-2.5 rounded-lg bg-background px-2.5 py-2 text-foreground',
                    v.status === 'fix_does_not_hold' && 'shadow-[inset_3px_0_0_var(--destructive)]',
                  )}
                >
                  <b className="font-bold">{VERDICT_LABEL[v.status]}.</b> {v.text}
                  {v.files.length > 0 && (
                    <span className="mt-1 block text-[12.5px] leading-[1.45] text-muted-foreground">
                      읽은 파일: {v.files.map((f) => <code key={f} className="mr-1.5 rounded bg-muted px-1 font-mono text-[12.5px]">{f}</code>)}
                    </span>
                  )}
                  {v.status === 'fix_does_not_hold' && open && !readOnly && (
                    <button
                      type="button"
                      onClick={() => onCloseWithReason('wrong_causality')}
                      className="mt-1.5 inline-flex h-6.5 items-center gap-1 rounded-full border border-current px-2.5 text-[12.5px] font-semibold text-brand-strong"
                    >
                      「인과가 틀린 수정」으로 반영하지 않기
                    </button>
                  )}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  {item.verifiableBy === 'code' && open && !readOnly && (
                    <button
                      type="button"
                      disabled={verifying !== null}
                      onClick={() => onVerify(i)}
                      className="inline-flex h-6.5 items-center gap-1.5 rounded-full border border-current px-2.5 text-[12.5px] font-semibold disabled:opacity-50"
                    >
                      {verifying === i ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
                      {verifying === i ? '확인하는 중…' : 'AI 에게 확인시키기'}
                    </button>
                  )}
                  {item.verifiableBy === 'reporter' && (
                    <Link
                      href="/inbox"
                      className="inline-flex h-6.5 items-center gap-1 rounded-full border border-current px-2.5 text-[12.5px] font-semibold"
                    >
                      제보자에게 물어보기 <ChevronRight className="h-3 w-3" aria-hidden />
                    </Link>
                  )}
                  <span className="text-[12.5px] leading-[1.45] opacity-80">
                    {VERIFIABLE_HOW[item.verifiableBy]}
                    {item.verifiableBy === 'code' && item.files.length > 0 && (
                      <>
                        {' · '}
                        {item.files.map((f) => <code key={f} className="mr-1 font-mono text-[12.5px]">{f}</code>)}
                        를 읽고 다시 판단 · 약 40초
                      </>
                    )}
                    {item.verifiableBy === 'reporter' && item.question && <> · 대화 탭에서 「{item.question}」</>}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-sm font-semibold sm:col-start-2">반영 전에 프리뷰에서 직접 확인해 보세요.</p>
    </div>
  );
}

function Explanation({
  explanation,
  ...rest
}: {
  explanation: RunExplanation | null;
} & Omit<Parameters<typeof Unverified>[0], 'items'>) {
  return (
    <section className="border-b border-border py-5" aria-labelledby={`ex-${rest.runId}`}>
      {/* 출처 설명은 제목 옆이 아니라 아래 한 줄로(v4 §5) */}
      <h3 id={`ex-${rest.runId}`} className="text-[15px] font-bold tracking-[-0.01em]">이 수정이 하는 일</h3>
      <p className="mb-4 mt-1 text-[12.5px] leading-[1.45] text-muted-foreground">
        {explanation?.source === 'pr_body'
          ? '저장된 설명이 없어 PR 본문에서 추출했습니다'
          : 'AI 가 코드를 고치면서 쓴 설명이에요'}
      </p>
      {!explanation ? (
        <p className="text-sm text-muted-foreground">
          이 수정안에는 설명이 없어요. 아래 「바뀐 코드」와 GitHub 의 PR 본문을 봐 주세요.
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-3 sm:gap-y-0">
          {(
            [
              ['무엇이 문제였나', explanation.problem],
              ['무엇을 바꿨나', explanation.change],
              ['반영되면', explanation.effect],
            ] as const
          ).map(([label, text], i) => (
            <div key={label} className={cn('min-w-0', i > 0 && 'sm:border-l sm:border-border sm:pl-5', i < 2 && 'sm:pr-5')}>
              <dt className="mb-1 text-[12.5px] leading-[1.45] text-muted-foreground">{label}</dt>
              <dd className="text-sm leading-[1.6] tracking-[-0.005em]">
                {text || <span className="text-faint">{i === 2 ? '설명에 없어요' : '—'}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {explanation && <Unverified items={explanation.unverified} {...rest} />}
    </section>
  );
}

// ─── 패널 ────────────────────────────────────────────────────────────────────

export function PrReviewPanel({ run, readOnly, onRunChange, onRefresh }: PrReviewPanelProps) {
  const pr = run.pr;
  const { data, error, loading, reload, pollingStopped } = usePrReview(pr ? run.id : null, Boolean(pr) && !readOnly);
  const [state, dispatch] = useReducer(reduce, INITIAL);

  if (!pr) return null;
  const review = data?.review ?? null;
  const isOpen = !pr.mergedAt && !pr.closedAt;
  const explanation = run.explanation ?? data?.legacyExplanation ?? null;
  const blocked = effectiveBlock(data);
  const busy = state.mode === 'merging' || state.mode === 'submitting_close' || state.verifying !== null;

  const handleMerge = async () => {
    dispatch({ type: 'merge_start' });
    try {
      const res = await fetch(`/api/auto-dev/runs/${run.id}/merge`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(mergeErrorMessage(json));
      dispatch({
        type: 'done',
        notice: [
          `서비스에 반영했어요 · 반영 알림 ${json.delivered ?? 0}건 준비`,
          json.emailed > 0 ? `메일 ${json.emailed}통` : null,
          json.mergeMethod === 'merge' ? '저장소 설정 때문에 기본 방식으로 반영했어요' : null,
          json.loopError ? `반영 알림 일부 실패: ${json.loopError}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      onRunChange({ ...run, pr: { ...pr, mergedAt: json.mergedAt } });
      onRefresh();
    } catch (err) {
      dispatch({ type: 'fail', error: err instanceof Error ? err.message : '반영하지 못했어요' });
      reload();
    }
  };

  const handleClose = async () => {
    if (!state.reason) return;
    dispatch({ type: 'close_start' });
    try {
      const res = await fetch(`/api/auto-dev/runs/${run.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ close_reason: state.reason, close_note: state.note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '닫지 못했어요');
      dispatch({ type: 'done', notice: null });
      onRunChange({
        ...run,
        pr: { ...pr, closedAt: json.closedAt, closeReason: json.closeReason, closeNote: json.closeNote },
      });
    } catch (err) {
      dispatch({ type: 'fail', error: err instanceof Error ? err.message : '닫지 못했어요' });
    }
  };

  const handleVerify = async (index: number) => {
    dispatch({ type: 'verify_start', index });
    try {
      const res = await fetch(`/api/auto-dev/runs/${run.id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '확인하지 못했어요');
      dispatch({ type: 'verify_done' });
      onRunChange({ ...run, explanation: json.explanation });
    } catch (err) {
      dispatch({ type: 'verify_fail', error: err instanceof Error ? err.message : '확인하지 못했어요' });
    }
  };

  const handleCloseWithReason = (reason: CloseReason) => {
    dispatch({ type: 'open_close' });
    dispatch({ type: 'pick_reason', reason });
  };

  const people = run.evidence.conversationCount;

  return (
    <div className="flex min-w-0 flex-col">
      <Facts run={run} review={review} targets={data?.pickedTargets ?? []} shots={data?.pickedShots ?? run.demoPickedShots ?? []} loading={loading} error={readOnly ? null : error} />
      {isOpen && <DraftGateLine review={review} />}

      {/* 격리 검증 경고 배너는 뺐다(2026-09-17 ny 결정) — 같은 사실을 위 Facts 의
          「실행 검증」 줄과 GitHub PR 본문 「⚠️ 검증되지 않음」 절이 그대로 말한다. */}

      <Explanation
        explanation={explanation}
        runId={run.id}
        readOnly={readOnly}
        open={isOpen}
        verifying={state.verifying}
        onVerify={handleVerify}
        onCloseWithReason={handleCloseWithReason}
      />

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2 pt-5">
        <h3 className="min-w-0 text-[15px] font-bold tracking-[-0.01em]">
          바뀐 코드
          {review && (
            <span className="ml-2 text-[12.5px] font-normal text-muted-foreground tabular-nums">
              {review.changedFiles}개 파일 · <b className="font-semibold text-[#1e6b3a] dark:text-[#7ed69a]">+{review.additions}</b>{' '}
              <b className="font-semibold text-[#a13a2f] dark:text-[#f0a19a]">−{review.deletions}</b>
            </span>
          )}
        </h3>
        <span className="min-w-0 break-all text-[12.5px] leading-[1.45] text-faint">
          개발자용 · 파일을 눌러 펼치기{review && ` · ${review.headRef} → ${review.baseRef}`}
        </span>
      </div>
      {review ? (
        <DiffView files={review.files} filesTruncated={review.filesTruncated} />
      ) : readOnly ? (
        <p className="py-3 text-sm text-muted-foreground">
          {run.filesChanged.map((f) => f.path).join(', ') || '바뀐 파일 정보가 없어요'}
        </p>
      ) : (
        <p className="py-3 text-sm text-muted-foreground">{error ? `GitHub 에서 읽지 못했어요 — ${error}` : '읽는 중…'}</p>
      )}

      <p className="mt-3 text-[12.5px] leading-[1.45] text-muted-foreground">AI 코드 판단은 참고 의견입니다. 실제 실행 검증 결과는 위 검사 기록에서 확인하세요.</p>

      {/* 행동 — 열린 PR 에만 */}
      {isOpen && !readOnly && state.mode !== 'closing' && state.mode !== 'submitting_close' && (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-border-strong pt-4">
          <Button
            onClick={handleMerge}
            disabled={busy || Boolean(blocked) || !review}
            title={blocked ? BLOCK_MESSAGE[blocked] : undefined}
          >
            {state.mode === 'merging' ? <Loader2 className="animate-spin" /> : <Check />}
            {state.mode === 'merging' ? '반영하는 중…' : review?.build.unavailable ? '빌드 확인 없이 반영하기' : '서비스에 반영하기'}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => dispatch({ type: 'open_close' })}>
            반영하지 않기
          </Button>
          {blocked ? (
            <p className="flex basis-full items-start gap-2 rounded-[10px] bg-[#fbf0d3] px-4 py-3 text-sm leading-[1.55] text-[#8a5c06] dark:bg-[#37301a] dark:text-[#e2b34f]">
              <TriangleAlert className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {BLOCK_MESSAGE[blocked]}
                {blocked === 'build_failed' && (
                  <>
                    {' '}
                    {review?.build.targetUrl && (
                      <a href={review.build.targetUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                        빌드 로그
                      </a>
                    )}
                    를 확인하고, 고칠 수 없으면 「반영하지 않기」에서 「없는 경로·심볼을 지어냄」을 골라 주세요. 빌드가 다시 통과하면 버튼이 열려요.
                  </>
                )}
                {(blocked === 'build_pending' || blocked === 'draft_waiting') &&
                  (pollingStopped ? (
                    <>
                      {' '}
                      30분 넘게 끝나지 않아 자동 확인을 멈췄어요.{' '}
                      <button type="button" onClick={() => reload()} className="font-semibold underline">
                        다시 확인
                      </button>
                    </>
                  ) : (
                    ' 1분마다 다시 확인해요.'
                  ))}
              </span>
            </p>
          ) : (
            <p className="m-0 basis-full text-[12.5px] leading-[1.45] text-muted-foreground">
              PR #{pr.number}을 서비스에 반영하고, 제보자 {people}명에게 반영 알림을 보냅니다. 배포 성공과 문제 해결은 따로 확인합니다.
              이메일 전달 결과는 후속 확인 기록에서 확인하세요. GitHub 반영 기록은 연결된 계정으로 남습니다.
            </p>
          )}
          {state.error && <p className="basis-full text-sm text-destructive">{state.error}</p>}
        </div>
      )}

      {/* 반영하지 않기 — 사유 필수 */}
      {isOpen && !readOnly && (state.mode === 'closing' || state.mode === 'submitting_close') && (
        <div className="mt-5 border-t border-border-strong pt-4">
          <h4 className="text-[15px] font-bold tracking-[-0.01em]">반영하지 않기</h4>
          <p className="mb-3 mt-1 text-sm leading-relaxed text-muted-foreground">
            이유를 하나 골라 두면 AI 가 어떤 실수를 반복하는지 보여요. 피드백을 남긴 분들에게는 아무것도 가지 않고, GitHub 의 PR #
            {pr.number} 은 닫혀요.
          </p>
          <div role="radiogroup" aria-label="반영하지 않는 이유" className="grid gap-1.5 sm:grid-cols-2">
            {CLOSE_REASONS.map((r) => {
              const on = state.reason === r;
              return (
                <label
                  key={r}
                  className={cn(
                    'grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 rounded-[10px] border border-border-strong px-3 py-2.5',
                    on && 'border-foreground bg-foreground text-background',
                  )}
                >
                  <input
                    type="radio"
                    name={`close-reason-${run.id}`}
                    value={r}
                    checked={on}
                    onChange={() => dispatch({ type: 'pick_reason', reason: r })}
                    className="mt-[3px] accent-foreground"
                    // label 이 설명 문단까지 감싸므로 이름과 설명을 갈라 준다 — 안 그러면 선택지 이름이 문단 전체다
                    aria-labelledby={`close-label-${run.id}-${r}`}
                    aria-describedby={`close-hint-${run.id}-${r}`}
                  />
                  <span>
                    <span id={`close-label-${run.id}-${r}`} className="block text-sm font-semibold">{CLOSE_REASON_LABEL[r]}</span>
                    <span id={`close-hint-${run.id}-${r}`} className={cn('mt-0.5 block text-[12.5px] leading-[1.45]', on ? 'text-background/70' : 'text-muted-foreground')}>
                      {CLOSE_REASON_HINT[r]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <input
            type="text"
            value={state.note}
            maxLength={CLOSE_NOTE_MAX}
            placeholder="메모 (선택) — 무엇이 틀렸는지 한 줄"
            aria-label="반영하지 않는 이유 메모"
            onChange={(e) => dispatch({ type: 'note', note: e.target.value })}
            className="mt-2.5 h-9 w-full max-w-xl rounded-[10px] border border-border-strong bg-background px-3 text-sm placeholder:text-faint"
          />
          <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
            <Button variant="secondary" className="bg-foreground text-background hover:bg-foreground/90" disabled={!state.reason || busy} onClick={handleClose}>
              {state.mode === 'submitting_close' && <Loader2 className="animate-spin" />}
              반영하지 않기
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => dispatch({ type: 'cancel_close' })}>
              돌아가기
            </Button>
            <span className="text-[12.5px] text-muted-foreground">이 피드백 묶음은 다시 「열림」으로 돌아가요. 나중에 다시 수정을 시킬 수 있어요</span>
          </div>
          {state.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
        </div>
      )}

      {state.notice && (
        <p className="mt-4 flex items-start gap-2 text-sm font-semibold text-brand-strong">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {state.notice}
        </p>
      )}
      {!isOpen && !readOnly && state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}
    </div>
  );
}

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RunItem } from '@/app/api/auto-dev/runs/route';

export type RunState = 'running' | 'open' | 'merged' | 'closed' | 'failed' | 'stopped' | 'unverifiable';

/** 실행 하나를 화면 상태 다섯으로 접는다 — 진행 중 · 열림 · 머지됨 · 닫힘(머지 없이) · 중단 */
export function runState(run: Pick<RunItem, 'status' | 'pr'>): RunState {
  if (run.pr) {
    if (run.pr.mergedAt) return 'merged';
    return run.pr.closedAt ? 'closed' : 'open';
  }
  if (run.status === 'running' || run.status === 'in_progress') return 'running';
  if (run.status === 'stopped' || run.status === 'unverifiable') return run.status;
  return 'failed';
}

export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: '진행 중',
  open: '검토 대기',
  merged: '반영됨',
  closed: '닫힘',
  failed: '실패',
  stopped: '중단',
  unverifiable: '검증 불가',
};

/** 20px 알약 배지 — 머지됨만 브랜드, 중단은 경고 톤, 나머지는 중립 */
export function RunBadge({ state, className }: { state: RunState; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium leading-none',
        state === 'merged' && 'bg-brand-subtle text-brand-strong',
        ['failed', 'stopped', 'unverifiable'].includes(state) && 'bg-[#fbf0d3] text-[#8a5c06] dark:bg-[#37301a] dark:text-[#e2b34f]',
        (state === 'open' || state === 'running') && 'bg-muted text-muted-foreground',
        state === 'closed' && 'bg-muted text-faint',
        className,
      )}
    >
      {state === 'merged' && <Check className="h-2.5 w-2.5" aria-hidden />}
      {state === 'running' && <i className="block h-1.5 w-1.5 animate-pulse rounded-full bg-foreground" aria-hidden />}
      {RUN_STATE_LABEL[state]}
    </span>
  );
}

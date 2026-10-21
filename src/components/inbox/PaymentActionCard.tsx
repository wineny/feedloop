'use client';

// The approval card (design v2 §4): one refund request of the open conversation, with the checks that
// kept it from running automatically and — while it is pending — Approve / Reject. English: this is
// the judges' screen (§10). The decision is taken once; the server answers 409 on a second attempt.

import { useState } from 'react';
import { Loader2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, failedChecks, type PaymentActionView } from '@/lib/paypal/action-view';

export type PaymentDecision = 'approve' | 'reject';

export interface PaymentActionCardProps {
  action: PaymentActionView;
  /** Resolves with the row as the server now sees it. Rejects with a message to show. */
  onDecide: (actionId: string, decision: PaymentDecision) => Promise<PaymentActionView>;
  /** The practice (logged-out) screen never calls the server. */
  disabled?: boolean;
}

const STATUS_TONE: Record<PaymentActionView['status'], string> = {
  pending: 'bg-brand-subtle text-brand-strong',
  executing: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
  executed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-destructive/10 text-destructive',
  rejected: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * One decision in flight at a time. The card never keeps its own copy of the row: the parent owns the
 * list and replaces the row from the server's answer (`onDecide` resolves with it, and the parent
 * stores it), so a refreshed row with the same id is always what is shown.
 */
function usePaymentDecision(actionId: string, onDecide: PaymentActionCardProps['onDecide']) {
  const [busy, setBusy] = useState<PaymentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: PaymentDecision) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await onDecide(actionId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision could not be saved. Reload and try again.');
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, decide };
}

function StatusIcon({ status }: { status: PaymentActionView['status'] }) {
  if (status === 'pending') return <ShieldAlert className="h-4 w-4 text-brand-strong" aria-hidden />;
  if (status === 'executed') return <ShieldCheck className="h-4 w-4 text-emerald-700" aria-hidden />;
  return <XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

export function PaymentActionCard({ action, onDecide, disabled }: PaymentActionCardProps) {
  const { busy, error, decide } = usePaymentDecision(action.id, onDecide);
  const current = action;
  const failed = failedChecks(current);

  const handleApprove = () => void decide('approve');
  const handleReject = () => void decide('reject');

  return (
    <section
      aria-label="Refund request"
      className="flex flex-col gap-3 rounded-[16px] border border-border bg-card px-4 py-3.5 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={current.status} />
          <span className="font-semibold">Refund request · {current.amount ?? '?'}</span>
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-[12.5px] font-semibold', STATUS_TONE[current.status])}>
          {STATUS_LABELS[current.status]}
        </span>
      </div>

      {current.reason && <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">“{current.reason}”</p>}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
        <dt>PayPal capture</dt>
        <dd className="truncate font-mono" title={current.captureId}>{current.captureId}</dd>
        <dt>Requested</dt>
        <dd>{dateFormatter.format(new Date(current.createdAt))}</dd>
        {current.paypalRef && (
          <>
            <dt>PayPal refund</dt>
            <dd className="truncate font-mono" title={current.paypalRef}>{current.paypalRef}</dd>
          </>
        )}
        {current.error && (
          <>
            <dt>Detail</dt>
            <dd className="font-mono">{current.error}</dd>
          </>
        )}
      </dl>

      {failed.length > 0 && (
        <div className="rounded-[12px] bg-muted/60 px-3 py-2 text-[12.5px]">
          <p className="mb-1 font-semibold text-foreground">Why it waits for you</p>
          <ul className="list-disc pl-4 text-muted-foreground">
            {failed.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      )}

      {current.decidable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleApprove} disabled={busy !== null || disabled}>
            {busy === 'approve' ? <Loader2 className="animate-spin" /> : `Approve ${current.amount ?? ''}`.trim()}
          </Button>
          <Button size="sm" variant="outline" onClick={handleReject} disabled={busy !== null || disabled}>
            {busy === 'reject' ? <Loader2 className="animate-spin" /> : 'Reject'}
          </Button>
          <span className="text-[12.5px] text-faint">Approving sends exactly this amount to PayPal. Decided once.</span>
        </div>
      )}
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}
    </section>
  );
}

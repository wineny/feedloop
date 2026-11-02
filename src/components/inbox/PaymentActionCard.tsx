'use client';

// The approval card (design v2 §4): one refund request of the open conversation, with the checks that
// kept it from running automatically and — while it is pending — Approve / Reject. This is the judges'
// screen (§10), so the English text is the one that gets the care; ko mirrors it (messages/*/inbox.json). The decision is taken once; the server answers 409 on a second attempt.

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PaymentActionView } from '@/lib/paypal/action-view';
import { dynamicT } from '@/i18n/dynamic';
import type { PaymentPrecedent } from '@/lib/paypal/precedent';
import { ACTION_STATUS_TONE } from '@/lib/paypal/action-status-tone';

export type PaymentDecision = 'approve' | 'reject';

export interface PaymentActionCardProps {
  action: PaymentActionView;
  /** Resolves with the row as the server now sees it. Rejects with a message to show. */
  onDecide: (actionId: string, decision: PaymentDecision) => Promise<PaymentActionView>;
  /** The practice (logged-out) screen never calls the server. */
  disabled?: boolean;
  /** What happened to similar past requests (display only). Nothing is shown without it. */
  precedent?: PaymentPrecedent | null;
}

/**
 * One decision in flight at a time. The card never keeps its own copy of the row: the parent owns the
 * list and replaces the row from the server's answer (`onDecide` resolves with it, and the parent
 * stores it), so a refreshed row with the same id is always what is shown.
 */
function usePaymentDecision(actionId: string, onDecide: PaymentActionCardProps['onDecide']) {
  const t = useTranslations('inbox.payment');
  const [busy, setBusy] = useState<PaymentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: PaymentDecision) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      await onDecide(actionId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
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

export function PaymentActionCard({ action, onDecide, disabled, precedent }: PaymentActionCardProps) {
  const t = useTranslations('inbox.payment');
  const format = useFormatter();
  const { busy, error, decide } = usePaymentDecision(action.id, onDecide);
  const current = action;
  // 검사 이름은 key 로 사전에서 읽고, 사전에 없는 새 key 는 서버가 준 라벨을 그대로 쓴다.
  const failed = current.checks.filter((c) => !c.passed).map((c) => (dynamicT(t).has(`checks.${c.key}`) ? dynamicT(t)(`checks.${c.key}`) : c.label));

  const handleApprove = () => void decide('approve');
  const handleReject = () => void decide('reject');

  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-3 rounded-[16px] border border-border bg-card px-4 py-3.5 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={current.status} />
          <span className="font-semibold">{t('title', { amount: current.amount ?? '?' })}</span>
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-[12.5px] font-semibold', ACTION_STATUS_TONE[current.status])}>
          {t(`status.${current.status}`)}
        </span>
      </div>

      {current.reason && <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">“{current.reason}”</p>}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
        <dt>{t('capture')}</dt>
        <dd className="truncate font-mono" title={current.captureId}>{current.captureId}</dd>
        <dt>{t('requested')}</dt>
        <dd>{format.dateTime(new Date(current.createdAt), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
        {current.paypalRef && (
          <>
            <dt>{t('refund')}</dt>
            <dd className="truncate font-mono" title={current.paypalRef}>{current.paypalRef}</dd>
          </>
        )}
        {current.error && (
          <>
            <dt>{t('detail')}</dt>
            <dd className="font-mono">{current.error}</dd>
          </>
        )}
      </dl>

      {failed.length > 0 && (
        <div className="rounded-[12px] bg-muted/60 px-3 py-2 text-[12.5px]">
          <p className="mb-1 font-semibold text-foreground">{t('why')}</p>
          <ul className="list-disc pl-4 text-muted-foreground">
            {failed.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      )}

      {precedent && (
        <div className="text-[12.5px] text-muted-foreground">
          <p>
            {t(precedent.basis === 'check' ? 'precedent.check' : 'precedent.amount', { refunded: precedent.refunded, total: precedent.total })}
            {precedent.auto > 0 && ` · ${t('precedent.auto', { auto: precedent.auto })}`}
          </p>
          {precedent.evidence.length > 0 && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{t('precedent.evidence')}:</span>
              {precedent.evidence.map((e) => (
                <span key={e.actionId} className="inline-flex items-center gap-1">
                  <Link href={e.href} className="font-semibold text-brand-strong hover:underline">
                    {e.amount ?? '?'} · {t(`status.${e.status}`)}
                  </Link>
                  {e.sample && <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold">{t('precedent.sample')}</span>}
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {current.decidable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleApprove} disabled={busy !== null || disabled}>
            {busy === 'approve' ? <Loader2 className="animate-spin" /> : current.amount ? t('approve', { amount: current.amount }) : t('approveBare')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleReject} disabled={busy !== null || disabled}>
            {busy === 'reject' ? <Loader2 className="animate-spin" /> : t('reject')}
          </Button>
          <span className="text-[12.5px] text-faint">{t('once')}</span>
        </div>
      )}
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}
    </section>
  );
}

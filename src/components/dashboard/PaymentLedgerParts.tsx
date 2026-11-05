'use client';

// Pieces of the payment ledger shared by the desktop grid (`PaymentLedgerGrid`, AG Grid) and the phone
// card list (`PaymentLedger`): status badge, Approve / Reject with an inline confirm, and the execution
// record. The ledger's UI state lives in `LedgerUiContext` — AG Grid renders React cells through portals,
// which keep React context, so a cell re-renders when the state it reads changes.

import { createContext, useContext, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/paypal/money';
import { ACTION_STATUS_TONE } from '@/lib/paypal/action-status-tone';
import { dynamicT } from '@/i18n/dynamic';
import {
  ledgerConversationHref,
  parseLedgerStatusKey,
  type LedgerActionRow,
  type LedgerDecision,
  type LedgerPurchaseRow,
  type LedgerRow,
  type LedgerStatusKey,
} from '@/lib/paypal/ledger';
import type { OrderStatus } from '@/lib/paypal/store';

export interface LedgerRowMessage {
  text: string;
  tone: 'ok' | 'error';
}

export interface LedgerUi {
  /** Sample-data dashboard: Approve / Reject are shown but off. */
  demo: boolean;
  expandedKey: string | null;
  toggleExpanded: (key: string) => void;
  /** The row whose decision waits for «Confirm». */
  confirming: { key: string; decision: LedgerDecision } | null;
  askConfirm: (key: string, decision: LedgerDecision | null) => void;
  busyKey: string | null;
  decide: (row: LedgerActionRow, decision: LedgerDecision) => void;
  messages: Record<string, LedgerRowMessage>;
  /**
   * Where keyboard focus goes back after the confirm step closes: the button that opened it (Cancel, or a
   * decision that left the row pending) or the row's Details toggle (the buttons are gone).
   */
  focusRequest: { key: string; target: LedgerDecision | 'details' } | null;
  clearFocusRequest: () => void;
}

/** A ref that takes focus when the ledger asks for this row's `target`. */
function useFocusTarget<T extends HTMLElement>(key: string, target: LedgerDecision | 'details') {
  const ui = useLedgerUi();
  const ref = useRef<T>(null);
  const wanted = ui.focusRequest?.key === key && ui.focusRequest.target === target;
  const { clearFocusRequest } = ui;
  useEffect(() => {
    if (!wanted || !ref.current) return;
    ref.current.focus();
    clearFocusRequest();
  }, [wanted, clearFocusRequest]);
  return ref;
}

export const LedgerUiContext = createContext<LedgerUi | null>(null);

export function useLedgerUi(): LedgerUi {
  const ui = useContext(LedgerUiContext);
  if (!ui) throw new Error('LedgerUiContext missing');
  return ui;
}

const ORDER_STATUS_TONE: Record<OrderStatus, string> = {
  created: 'bg-muted text-muted-foreground',
  approved: 'bg-muted text-muted-foreground',
  captured: 'bg-emerald-50 text-emerald-700',
  expired: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  partially_refunded: 'bg-brand-subtle text-brand-strong',
  refunded: 'bg-brand-subtle text-brand-strong',
  reversed: 'bg-destructive/10 text-destructive',
};

export function ledgerAmount(row: Pick<LedgerRow, 'amountCents' | 'currency'>): string {
  return row.amountCents !== null && row.currency ? formatMoney(row.amountCents, row.currency) : '—';
}

/** Status words: refunds reuse the approval card's (`inbox.payment.status`), orders have their own. */
export function useStatusLabel(): (row: Pick<LedgerRow, 'type' | 'status'>) => string {
  const tInbox = useTranslations('inbox.payment.status');
  const tOrder = useTranslations('dashboard.payments.ledger.orderStatus');
  return (row) => (row.type === 'purchase' ? dynamicT(tOrder)(row.status) : dynamicT(tInbox)(row.status));
}

/** A status filter choice: «Refund · Failed» under Type = All (refund «Failed» ≠ purchase «Declined»), else just «Failed». */
export function useStatusKeyLabel(): (key: LedgerStatusKey, withType: boolean) => string {
  const label = useStatusLabel();
  const tType = useTranslations('dashboard.payments.ledger.types');
  return (key, withType) => {
    const parsed = parseLedgerStatusKey(key);
    const status = label(parsed as Pick<LedgerRow, 'type' | 'status'>);
    return withType ? `${tType(parsed.type)} · ${status}` : status;
  };
}

export function StatusBadge({ row }: { row: LedgerRow }) {
  const label = useStatusLabel();
  const tone = row.type === 'purchase' ? ORDER_STATUS_TONE[row.status] : ACTION_STATUS_TONE[row.status];
  const text = label(row);
  return (
    <span title={text} className={cn('inline-block max-w-full truncate rounded-full px-2 py-0.5 align-middle text-[12px] font-semibold leading-5', tone)}>
      {text}
    </span>
  );
}

/** Seeded sample history (`LedgerActionRow.sample`). Its PayPal ids are plain text like every other id here. */
export function SampleChip({ row }: { row: LedgerRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  if (row.type === 'purchase' || !row.sample) return null;
  return (
    <span className="ml-1.5 inline-block rounded-full bg-muted px-1.5 align-middle text-[11px] font-semibold leading-[18px] text-muted-foreground">
      {t('sample')}
    </span>
  );
}

/** `withSample=false`: the grid's narrow Type column — the grid shows the chip in its Actions cell instead. */
export function TypeLabel({ row, withSample = true }: { row: LedgerRow; withSample?: boolean }) {
  const t = useTranslations('dashboard.payments.ledger.types');
  return (
    <>
      {t(row.type)}
      {withSample && <SampleChip row={row} />}
    </>
  );
}

export function LedgerTime({ at }: { at: string }) {
  const format = useFormatter();
  const locale = useLocale();
  // Same rule as ConnectChooser: English names the time zone (UTC before the browser's zone is known).
  return (
    <time dateTime={at} className="tabular-nums">
      {format.dateTime(new Date(at), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(locale === 'ko' ? {} : { timeZoneName: 'short' as const }),
      })}
    </time>
  );
}

export function ConversationLink({ row }: { row: LedgerRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  if (!row.conversationId) return <span className="text-faint">—</span>;
  return (
    <Link href={ledgerConversationHref(row.conversationId)} className="font-semibold text-brand-strong hover:underline">
      {t('open')}
    </Link>
  );
}

export function RecordToggle({ row }: { row: LedgerRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  const ui = useLedgerUi();
  const open = ui.expandedKey === row.key;
  const ref = useFocusTarget<HTMLButtonElement>(row.key, 'details');
  return (
    <Button ref={ref} size="xs" variant="ghost" aria-expanded={open} onClick={() => ui.toggleExpanded(row.key)}>
      {open ? t('hideRecord') : t('showRecord')}
      {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
    </Button>
  );
}

/**
 * Approve / Reject for a pending refund. The first press asks («Approve the $79 refund?» → Confirm / Cancel)
 * — the decision moves money and is taken once. The result (or the route's error) shows with the row.
 *
 * `inline` (grid rows are 48px): the message sits beside the buttons, one line, truncated, full text in
 * `title`. The card list stacks it under the buttons instead.
 */
export function DecisionControls({ row, inline = false }: { row: LedgerRow; inline?: boolean }) {
  const t = useTranslations('dashboard.payments.ledger');
  const tCard = useTranslations('inbox.payment');
  const ui = useLedgerUi();
  const approveRef = useFocusTarget<HTMLButtonElement>(row.key, 'approve');
  const rejectRef = useFocusTarget<HTMLButtonElement>(row.key, 'reject');
  const message = ui.messages[row.key];
  const messageLine = message && (
    <p
      title={inline ? message.text : undefined}
      className={cn(
        'text-[12px] leading-snug',
        inline && 'min-w-0 truncate',
        message.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {message.text}
    </p>
  );
  if (row.type === 'purchase' || !row.decidable) return messageLine || null;

  const busy = ui.busyKey === row.key;
  const confirming = ui.confirming?.key === row.key ? ui.confirming.decision : null;
  const amount = row.amountCents !== null && row.currency ? formatMoney(row.amountCents, row.currency) : null;

  if (confirming) return <ConfirmStep row={row} decision={confirming} amount={amount} busy={busy} />;

  return (
    <div className={cn('flex min-w-0 gap-1.5', inline ? 'items-center' : 'flex-col')}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button ref={approveRef} size="xs" disabled={ui.demo || busy} title={ui.demo ? t('demoOff') : undefined} onClick={() => ui.askConfirm(row.key, 'approve')}>
          {tCard('approveBare')}
        </Button>
        <Button ref={rejectRef} size="xs" variant="outline" disabled={ui.demo || busy} title={ui.demo ? t('demoOff') : undefined} onClick={() => ui.askConfirm(row.key, 'reject')}>
          {tCard('reject')}
        </Button>
      </div>
      {messageLine}
    </div>
  );
}

/** «Approve the $79 refund?  Confirm  Cancel». Cancel takes focus when the step opens — the safe default. */
function ConfirmStep({ row, decision, amount, busy }: { row: LedgerActionRow; decision: LedgerDecision; amount: string | null; busy: boolean }) {
  const t = useTranslations('dashboard.payments.ledger');
  const ui = useLedgerUi();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const question =
    decision === 'reject'
      ? amount ? t('confirm.reject', { amount }) : t('confirm.rejectBare')
      : amount ? t('confirm.approve', { amount }) : t('confirm.approveBare');
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={question}>
      <span className="text-[12.5px] font-semibold">{question}</span>
      <Button size="xs" variant={decision === 'reject' ? 'outline' : 'default'} disabled={busy} onClick={() => ui.decide(row, decision)}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {t('confirm.yes')}
      </Button>
      <Button ref={cancelRef} size="xs" variant="ghost" disabled={busy} onClick={() => ui.askConfirm(row.key, null)}>
        {t('confirm.no')}
      </Button>
    </div>
  );
}

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono text-[12px]')}>{children}</dd>
    </>
  );
}

function ActionRecord({ row }: { row: LedgerActionRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  const tCard = useTranslations('inbox.payment');
  const d = row.detail;
  // Names come only to the bot's owner (the route); an approver sees «you» or «a team member».
  const decider = d.decidedBy ? t('record.by', { name: d.decidedBy.self ? t('record.you') : (d.decidedBy.name ?? t('record.teammate')) }) : null;
  const checks = d.failedChecks.map((key) => (dynamicT(tCard).has(`checks.${key}`) ? dynamicT(tCard)(`checks.${key}`) : key));

  // created → decided (approval rows) → executed / failed. Rejected and expired rows end at the decision.
  // Expired rows have no decided_at — `expirePendingActions` sets only status + updated_at — so that step is
  // read from `updatedAt`, like a failure (there is no failed_at either).
  const steps: { label: string; at: string; note?: string | null }[] = [{ label: t('record.requested'), at: d.createdAt }];
  if (d.decidedAt && row.status !== 'expired') {
    steps.push({ label: row.status === 'rejected' ? t('record.rejected') : t('record.approved'), at: d.decidedAt, note: decider });
  }
  if (d.executedAt) steps.push({ label: d.kind === 'accept_dispute' ? t('record.accepted') : t('record.executed'), at: d.executedAt });
  else if (row.status === 'failed') steps.push({ label: t('record.failed'), at: d.updatedAt });
  else if (row.status === 'expired') steps.push({ label: t('record.expired'), at: d.updatedAt });

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-1 text-[12.5px]">
        <Field label={t('record.call')}>{d.kind === 'accept_dispute' ? t('record.callDispute') : t('record.callRefund')}</Field>
        <Field label={t('columns.origin')}>{t(`origin.${row.origin}`)}</Field>
        <Field label={t('record.sent')}>
          {d.sent ? `${d.sent.value} ${d.sent.currency}` : <span className="text-muted-foreground">{t('record.notSent')}</span>}
        </Field>
        {d.resultStatus && <Field label={t('record.result')} mono>{d.resultStatus}</Field>}
        <Field label={d.kind === 'accept_dispute' ? t('record.dispute') : tCard('capture')} mono>{d.targetId}</Field>
        {d.paypalRef && <Field label={d.kind === 'accept_dispute' ? t('record.reference') : tCard('refund')} mono>{d.paypalRef}</Field>}
        {d.reason && <Field label={t('record.reason')}>“{d.reason}”</Field>}
        {d.error && <Field label={t('record.error')} mono><span className="text-destructive">{d.error}</span></Field>}
      </dl>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div>
          <p className="mb-1 font-semibold">{t('record.timeline')}</p>
          <ol className="flex flex-col gap-1">
            {steps.map((step) => (
              <li key={step.label} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{step.label}</span>
                <span className="text-muted-foreground"><LedgerTime at={step.at} /></span>
                {step.note && <span className="text-muted-foreground">{step.note}</span>}
              </li>
            ))}
          </ol>
        </div>
        {/* «Why this needs your approval» only while it does — after the decision it reads as a pending ask. */}
        {row.status === 'pending' && checks.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">{tCard('why')}</p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {checks.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function PurchaseRecord({ row }: { row: LedgerPurchaseRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  const d = row.detail;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-1 text-[12.5px] sm:max-w-xl">
      <Field label={t('record.orderId')} mono>{d.orderId}</Field>
      {d.captureId && <Field label={t('record.captureId')} mono>{d.captureId}</Field>}
      {d.product && <Field label={t('record.product')}>{d.product}{d.quantity > 1 ? ` × ${d.quantity}` : ''}</Field>}
      <Field label={t('record.created')}><LedgerTime at={row.at} /></Field>
      {d.capturedAt && <Field label={t('record.paid')}><LedgerTime at={d.capturedAt} /></Field>}
      {d.refundedCents > 0 && row.currency && <Field label={t('record.refundedAmount')}>{formatMoney(d.refundedCents, row.currency)}</Field>}
      {d.refundedAt && <Field label={t('record.refundRecorded')}><LedgerTime at={d.refundedAt} /></Field>}
    </dl>
  );
}

/** The execution record (refund / dispute) or the order record (purchase). */
export function LedgerRecord({ row }: { row: LedgerRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  return (
    <section aria-label={t('record.title')} className="flex flex-col gap-2">
      <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-muted-foreground">{t('record.title')}</p>
      {row.type === 'purchase' ? <PurchaseRecord row={row} /> : <ActionRecord row={row} />}
    </section>
  );
}

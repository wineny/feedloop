'use client';

// «Payment activity» in an inbox conversation (stage 5, item 6): this conversation's refunds, disputes and
// purchases, newest first, each with the ledger's execution record. Read-only — Approve / Reject stay on the
// approval card above (`PaymentActionCard`). Rows are the ledger's own (`GET /api/payments/ledger?conversationId=`),
// so masking and owner/approver rules are the ledger's; the record view is the ledger's `LedgerRecord`.

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LedgerRow } from '@/lib/paypal/ledger';
import { LedgerRecord, LedgerTime, StatusBadge, TypeLabel, ledgerAmount } from '@/components/dashboard/PaymentLedgerParts';

/** More rows than this and the panel starts collapsed — the thread stays in view. */
const OPEN_UP_TO = 2;

function ActivityRow({ row, cardShown }: { row: LedgerRow; cardShown: boolean }) {
  const t = useTranslations('inbox.activity');
  const tLedger = useTranslations('dashboard.payments.ledger');
  const [open, setOpen] = useState(false);
  const recordId = useId();
  const extra = row.type === 'purchase' ? row.detail.product : tLedger(`origin.${row.origin}`);
  return (
    <li className="flex min-w-0 flex-col gap-2 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="font-semibold"><TypeLabel row={row} /></span>
        <span className="font-semibold tabular-nums">{ledgerAmount(row)}</span>
        <StatusBadge row={row} />
        {extra && <span className="min-w-0 truncate text-muted-foreground">{extra}</span>}
        <span className="text-[12.5px] text-faint"><LedgerTime at={row.at} /></span>
        <Button size="xs" variant="ghost" className="ml-auto" aria-expanded={open} aria-controls={recordId} onClick={() => setOpen((v) => !v)}>
          {open ? tLedger('hideRecord') : tLedger('showRecord')}
          {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
      </div>
      {/* Only when the approval card above can actually take the decision (not on sample data). */}
      {row.decidable && cardShown && <p className="text-[12.5px] text-muted-foreground">{t('decideAbove')}</p>}
      {open && (
        <div id={recordId} className="rounded-[12px] border border-border bg-card px-3 py-3 sm:px-4">
          <LedgerRecord row={row} />
        </div>
      )}
    </li>
  );
}

/** Nothing when the conversation has no payment rows. Render with `key={conversationId}`. */
export function PaymentActivityPanel({
  rows,
  hasCard = () => false,
}: {
  rows: readonly LedgerRow[];
  /** A decidable approval card for this payment_actions id is on screen (and can be pressed). */
  hasCard?: (actionId: string) => boolean;
}) {
  const t = useTranslations('inbox.activity');
  const listId = useId();
  // null until the operator toggles: the rows arrive after the panel mounts, so the default follows them.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? rows.length <= OPEN_UP_TO;
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('title')} className="flex flex-col border-b border-border px-5 py-3 sm:px-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setToggled(!open)}
        className="flex min-h-9 items-center gap-2 text-left text-sm font-semibold"
      >
        {t('title')}
        <small className="text-[12.5px] font-medium tabular-nums text-muted-foreground">{t('count', { count: rows.length })}</small>
        <span className="ml-auto inline-flex items-center gap-0.5 text-[12.5px] font-medium text-muted-foreground">
          {open ? t('hide') : t('show')}
          {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        </span>
      </button>
      {open && (
        <ul id={listId} className="divide-y divide-border">
          {rows.map((row) => <ActivityRow key={row.key} row={row} cardShown={row.type !== 'purchase' && hasCard(row.id)} />)}
        </ul>
      )}
    </section>
  );
}

'use client';

// The payment ledger under the PayPal numbers (stage 5, item 3): refunds and purchases in one list,
// newest first, with Type / Status filters, Approve / Reject for pending refunds and an expandable
// execution record. Data: `GET /api/payments/ledger` (or the sample rows on the sample-data dashboard).
//
// Wide screens (Tailwind `xl`, 1280px) get the AG Grid table (`PaymentLedgerGrid`, loaded only there and
// only on the client); narrower screens get a card list. The switch is a media query read after hydration —
// the server and the first client render both show the card list's markup (hidden by CSS from `xl`), and
// once the query answers only one of the two stays mounted, so nothing mismatches and nothing is doubled.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { scopedUrl } from '@/lib/scope/scope';
import {
  applyActionView,
  filterLedger,
  ledgerStatusOptions,
  ledgerTypeOptions,
  postLedgerDecision,
  replaceLedgerRow,
  type LedgerActionRow,
  type LedgerDecision,
  type LedgerResponse,
  type LedgerRow,
  type LedgerStatusFilter,
  type LedgerTypeFilter,
} from '@/lib/paypal/ledger';
import {
  ConversationLink,
  DecisionControls,
  LedgerRecord,
  LedgerTime,
  LedgerUiContext,
  RecordToggle,
  StatusBadge,
  TypeLabel,
  ledgerAmount,
  useLedgerUi,
  useStatusKeyLabel,
  useStatusLabel,
  type LedgerRowMessage,
  type LedgerUi,
} from './PaymentLedgerParts';

const PaymentLedgerGrid = dynamic(() => import('./PaymentLedgerGrid'), {
  ssr: false,
  loading: () => <div className="card-surface h-40 animate-pulse" aria-hidden />,
});

/**
 * Tailwind `xl`. Below it the card list, at and above it the grid. Narrower, the seven columns either scroll
 * sideways (Approve / Reject out of view) or cut their text («Waiting for ap…»); measured at 1024px.
 */
const WIDE_QUERY = '(min-width: 1280px)';

function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** false on the server and in the hydration render; the real answer right after. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);
}

interface PaymentLedgerProps {
  /** Bot scope. Render with `key={botId}` so switching scope drops the old bot's rows. */
  botId: string | null;
  /** Sample-data dashboard: these rows, no fetch, Approve / Reject off. */
  demoRows?: LedgerRow[] | null;
  /** After a decision — the dashboard reloads its numbers (pending approvals). */
  onChanged?: () => void;
}

export function PaymentLedger({ botId, demoRows, onChanged }: PaymentLedgerProps) {
  const t = useTranslations('dashboard.payments.ledger');
  const tInbox = useTranslations('inbox.errors');
  const statusLabel = useStatusLabel();
  const statusKeyLabel = useStatusKeyLabel();
  const demo = Boolean(demoRows);
  const wide = useWide();

  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [typeFilter, setTypeFilter] = useState<LedgerTypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<LedgerStatusFilter>('all');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<LedgerUi['confirming']>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, LedgerRowMessage>>({});
  // Rows decided here stay visible (with their message) until a filter changes or the page reloads.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [focusRequest, setFocusRequest] = useState<LedgerUi['focusRequest']>(null);
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(scopedUrl('/api/payments/ledger', botId));
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as LedgerResponse);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [botId]);

  // The dashboard keys this component by bot scope, so a new scope starts from an empty state.
  useEffect(() => {
    if (!demo) void load();
  }, [demo, load]);

  const rows = useMemo(() => (demo ? (demoRows ?? []) : (data?.rows ?? [])), [demo, demoRows, data]);
  const typeOptions = useMemo(() => ledgerTypeOptions(rows), [rows]);
  const statusOptions = useMemo(() => ledgerStatusOptions(rows, typeFilter, statusFilter), [rows, typeFilter, statusFilter]);
  const shown = useMemo(() => filterLedger(rows, typeFilter, statusFilter, kept), [rows, typeFilter, statusFilter, kept]);

  const changeFilters = (type: LedgerTypeFilter, status: LedgerStatusFilter) => {
    setTypeFilter(type);
    setStatusFilter(status);
    setKept(new Set());
  };

  const decide = useCallback(
    async (row: LedgerActionRow, decision: LedgerDecision) => {
      if (demo || busyKey) return;
      setBusyKey(row.key);
      setKept((prev) => new Set(prev).add(row.key));
      // Focus goes back to the button used while the row is still pending, else to its Details toggle.
      let focusTarget: LedgerDecision | 'details' = decision;
      const say = (message: LedgerRowMessage) => setMessages((prev) => ({ ...prev, [row.key]: message }));
      try {
        const effect = await postLedgerDecision(row, decision);
        // The route answers with the row as the server has it now — show that first, then reload the rest.
        if (effect.action) {
          const next = applyActionView(row, effect.action);
          if (!next.decidable) focusTarget = 'details';
          setData((prev) => (prev ? { ...prev, rows: replaceLedgerRow(prev.rows, next) } : prev));
        }
        if (effect.cardError || !effect.action) {
          say({
            tone: 'error',
            text:
              effect.cardErrorCode === 'alreadyDecided'
                ? t('alreadyDecided')
                : effect.cardErrorCode === 'failed'
                  ? tInbox('decisionFailed', { status: effect.status })
                  : (effect.cardError ?? tInbox('decisionFailed', { status: effect.status })),
          });
        } else if (effect.notice) {
          say({ tone: 'error', text: effect.noticeIsFallback ? tInbox('notCompleted', { status: effect.status }) : effect.notice });
        } else {
          say({ tone: 'ok', text: t('decided', { status: statusLabel({ type: 'refund', status: effect.action.status }) }) });
        }
      } catch {
        say({ tone: 'error', text: tInbox('decisionFailed', { status: 0 }) });
      } finally {
        setBusyKey(null);
        setConfirming(null);
        setFocusRequest({ key: row.key, target: focusTarget });
      }
      void load();
      onChanged?.();
    },
    [demo, busyKey, load, onChanged, statusLabel, t, tInbox],
  );

  const ui: LedgerUi = {
    demo,
    expandedKey,
    toggleExpanded: (key) => setExpandedKey((prev) => (prev === key ? null : key)),
    confirming,
    askConfirm: (key, decision) => {
      // Cancel returns focus to the button that opened the step.
      if (!decision && confirming?.key === key) setFocusRequest({ key, target: confirming.decision });
      setConfirming(decision ? { key, decision } : null);
    },
    busyKey,
    decide: (row, decision) => void decide(row, decision),
    messages,
    focusRequest,
    clearFocusRequest,
  };

  const loading = !demo && !data && !loadError;
  const hasPending = rows.some((row) => row.decidable);

  return (
    <LedgerUiContext.Provider value={ui}>
      <section aria-labelledby="paypal-ledger-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="paypal-ledger-title" className="text-sm font-bold">
            {t('title')}
          </h3>
          <p className="text-[12.5px] text-muted-foreground">{t('subtitle')}</p>
        </div>

        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t('filters.type')} className="inline-flex rounded-full bg-muted p-0.5">
              {typeOptions.map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={typeFilter === type}
                  onClick={() => changeFilters(type, 'all')}
                  className={cn(
                    'rounded-full px-3 py-1 text-[12.5px] font-semibold transition-colors',
                    typeFilter === type ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`typeFilters.${type}`)}
                </button>
              ))}
            </div>
            <label className="sr-only" htmlFor="paypal-ledger-status">
              {t('filters.status')}
            </label>
            <select
              id="paypal-ledger-status"
              value={statusFilter}
              onChange={(e) => changeFilters(typeFilter, e.target.value as LedgerStatusFilter)}
              className="h-8 rounded-full border border-border bg-card px-3 text-[12.5px] font-semibold"
            >
              <option value="all">{t('filters.allStatuses')}</option>
              {statusOptions.map((key) => (
                <option key={key} value={key}>
                  {statusKeyLabel(key, typeFilter === 'all')}
                </option>
              ))}
            </select>
            {demo && hasPending && <p className="text-[12.5px] text-faint">{t('demoOff')}</p>}
          </div>
        )}

        {loading ? (
          <div className="card-surface flex items-center gap-2 px-5 py-4 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('loading')}
          </div>
        ) : loadError && !data ? (
          <div className="card-surface flex flex-wrap items-center justify-between gap-2 px-5 py-4 text-[12.5px]">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="card-surface px-5 py-4 text-[12.5px] text-muted-foreground">{t('empty')}</p>
        ) : shown.length === 0 ? (
          <p className="card-surface px-5 py-4 text-[12.5px] text-muted-foreground">{t('emptyFiltered')}</p>
        ) : (
          <>
            {/* Below xl: cards. Before the media query answers they are hidden by CSS from xl, so the server and
                the hydration render agree; after it, only one of the two lists is mounted. */}
            {!wide && (
              <ul className="grid items-start gap-2 md:grid-cols-2 xl:hidden">
                {shown.map((row) => (
                  <LedgerCard key={row.key} row={row} />
                ))}
              </ul>
            )}
            {wide && <PaymentLedgerGrid rows={shown} />}
          </>
        )}

        {data?.truncated && <p className="text-[12.5px] text-faint">{t('truncated', { count: data.rows.length })}</p>}
      </section>
    </LedgerUiContext.Provider>
  );
}

function LedgerCard({ row }: { row: LedgerRow }) {
  const t = useTranslations('dashboard.payments.ledger');
  const open = useLedgerUi().expandedKey === row.key;
  return (
    <li className="card-surface flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-muted-foreground">
            <TypeLabel row={row} />
            {row.origin && <span className="font-normal"> · {t(`origin.${row.origin}`)}</span>}
          </p>
          <p className="text-lg font-extrabold leading-tight tracking-[-0.02em] tabular-nums">{ledgerAmount(row)}</p>
          <p className="text-[12px] text-muted-foreground">
            <LedgerTime at={row.at} />
          </p>
        </div>
        <StatusBadge row={row} />
      </div>
      <DecisionControls row={row} />
      <div className="flex items-center justify-between gap-2 text-[12.5px]">
        <ConversationLink row={row} />
        <RecordToggle row={row} />
      </div>
      {open && (
        <div className="border-t border-border pt-3">
          <LedgerRecord row={row} />
        </div>
      )}
    </li>
  );
}

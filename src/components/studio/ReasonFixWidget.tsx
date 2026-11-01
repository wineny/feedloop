'use client';

// Custom AG Studio widget "Reason → Fix": the top refund reasons, each with where it went (fix PR · spec · nothing),
// or — when `format.style.highlightReasonKey` is set — an alert card for one reason: refunds in the last N days
// vs the N days before. Refund Watch (the agent) places the alert version with its `add_reason_alert` tool.
//
// Data comes through Studio (`widgetApi.getData`), so page filters and cross filters apply. The widget reads the
// `refunds` table from the report schema instead of a data mapping — the fields it needs are fixed.

import { useEffect, useRef, useState } from 'react';
import type { AgBaseRegistry, AgBaseWidgetDefinition, AgDefaultWidgetDefinition, AgWidgetDataFormat, AgWidgetField, AgWidgetParams } from 'ag-studio';
import { isSampleUrl } from '@/lib/demo/sample-url';
import { reasonWindows, type ReasonWindow, type SampleRefund } from '@/lib/studio/sample';

export const REASON_FIX_WIDGET = 'reason-fix';

export interface ReasonFixStyle {
  /** Reason key to alert on. Unset = the top-reasons list. */
  highlightReasonKey?: string;
  /** Window for "last N days vs the N before". Default 7. */
  windowDays?: number;
  /** How many reasons the list shows. Default 3. */
  limit?: number;
}

export interface ReasonFixDef {
  type: typeof REASON_FIX_WIDGET;
  /** No data mapping — the widget reads the `refunds` table from the report schema. */
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<ReasonFixStyle>;
}

export interface StudioRegistry extends AgBaseRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgBaseWidgetDefinition<typeof REASON_FIX_WIDGET, ReasonFixDef>)[];
}

/** Studio `context`: the sample's "today", so windows are counted from the data's own end date. */
export interface StudioContext {
  asOf: string;
}

const NEEDED = ['id', 'date', 'reasonKey', 'reason', 'bucket', 'fixStatus', 'fixUrl'] as const;
type Needed = (typeof NEEDED)[number];

function refundFields(params: AgWidgetParams<ReasonFixDef>): Record<Needed, AgWidgetField> | null {
  // The schema omits hidden fields, so none of these are hidden in `lib/studio/data.ts`.
  const fields = params.widgetApi.getSchema().find((t) => t.id === 'refunds')?.fields ?? [];
  const out = {} as Record<Needed, AgWidgetField>;
  for (const name of NEEDED) {
    const f = fields.find((x) => x.fieldId === `refunds.${name}`);
    if (!f) return null;
    out[name] = f;
  }
  return out;
}

const BUCKET_TONE: Record<string, string> = {
  'Bug / UX': 'bg-[var(--brand-subtle)] text-[var(--brand-strong)]',
  'Feature request': 'bg-[var(--muted)] text-[var(--foreground)]',
  Other: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
  'Not classified yet': 'bg-[var(--muted)] text-[var(--muted-foreground)]',
};

function FixLink({ w }: { w: ReasonWindow }) {
  const label = w.fixUrl ? `${w.fixStatus} · #${w.fixUrl.split('/').pop()}` : w.fixStatus;
  // Sample PR addresses (github.com/example/…) are text, not links — same rule as the dashboard (4340ef4).
  if (!w.fixUrl || isSampleUrl(w.fixUrl)) {
    return <span className="text-xs text-[var(--muted-foreground)]">{label}</span>;
  }
  return (
    <a href={w.fixUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-[var(--primary)] hover:underline">
      {label} ↗
    </a>
  );
}

export function ReasonFixWidget(params: AgWidgetParams<ReasonFixDef>) {
  const { widgetApi, format, context } = params;
  const style = format?.style ?? {};
  const windowDays = style.windowDays ?? 7;
  const highlight = style.highlightReasonKey;
  const limit = style.limit ?? 3;
  const asOf = (context as StudioContext | undefined)?.asOf ?? new Date().toISOString().slice(0, 10);
  const [windows, setWindows] = useState<ReasonWindow[] | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const f = refundFields(params);
      if (!f) {
        widgetApi.setDisplayState('noData');
        return;
      }
      widgetApi.setDisplayState('loading', { prominent: !loaded.current });
      const res = await widgetApi.getData({ fields: NEEDED.map((n) => f[n]) });
      if (cancelled) return;
      const rows = res.results.rows.map((r) => ({
        date: String(r[f.date.key] ?? '').slice(0, 10),
        reasonKey: String(r[f.reasonKey.key] ?? ''),
        reason: String(r[f.reason.key] ?? ''),
        bucket: r[f.bucket.key] as SampleRefund['bucket'],
        fixStatus: r[f.fixStatus.key] as SampleRefund['fixStatus'],
        fixUrl: (r[f.fixUrl.key] as string | null) ?? null,
      }));
      const w = reasonWindows(rows, asOf, windowDays);
      loaded.current = w.length > 0;
      setWindows(w);
      widgetApi.setDisplayState(w.length > 0 ? 'displayed' : 'noData');
    };
    load().catch(() => {
      if (!cancelled) widgetApi.setDisplayState('noData');
    });
    return () => {
      cancelled = true;
    };
    // `params` changes identity on every Studio refresh (filters, schema); that is when the data must reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, asOf, windowDays]);

  if (!windows) return null;

  if (highlight) {
    const w = windows.find((x) => x.reasonKey === highlight);
    if (!w) return <div className="p-3 text-sm text-[var(--muted-foreground)]">No refunds for this reason in the current filter.</div>;
    const rising = w.recent > w.previous;
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${rising ? 'bg-[var(--brand-subtle)] text-[var(--brand-strong)]' : 'bg-[var(--muted)] text-[var(--muted-foreground)]'}`}>
            {rising ? 'Refund spike' : 'Refund reason'}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${BUCKET_TONE[w.bucket] ?? ''}`}>{w.bucket}</span>
        </div>
        <p className="text-base font-semibold leading-snug text-[var(--foreground)]">{w.reason}</p>
        <p className="text-sm text-[var(--muted-foreground)]">
          <span className="text-2xl font-bold text-[var(--foreground)]">{w.recent}</span> refunds in the last {windowDays} days ·{' '}
          {w.previous} in the {windowDays} days before
        </p>
        <div className="mt-auto">
          <FixLink w={w} />
        </div>
      </div>
    );
  }

  const top = [...windows].sort((a, b) => b.total - a.total || b.recent - a.recent).slice(0, limit);
  return (
    <ul className="flex h-full flex-col gap-2 overflow-auto p-2">
      {top.map((w) => (
        <li key={w.reasonKey} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-snug text-[var(--foreground)]">{w.reason}</p>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--foreground)]">{w.total}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${BUCKET_TONE[w.bucket] ?? ''}`}>{w.bucket}</span>
            <span aria-hidden className="text-[var(--faint)]">→</span>
            <FixLink w={w} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>';

export const reasonFixDefinition: AgBaseWidgetDefinition<typeof REASON_FIX_WIDGET, ReasonFixDef> = {
  id: REASON_FIX_WIDGET,
  label: 'Reason → Fix',
  icon: ICON,
  form: (p) => p.createDefaults({}),
  comp: ReasonFixWidget,
  defaultSize: { width: 420, height: 300 },
  minSize: { width: 260, height: 160 },
  ai: {
    label: 'Reason → Fix',
    description:
      'Feedloop card list: the top refund reasons, each with its type (Bug / UX, Feature request, Other) and where the reason went (fix PR, spec, nothing). ' +
      'With a highlighted reason it becomes an alert card: refunds for that reason in the last N days vs the N days before.',
    usage: 'Place it with the add_reason_alert tool, not by hand — the tool sets the highlighted reason.',
  },
};

'use client';

// The ledger's desktop table — AG Grid **Community** only. Loaded lazily (`next/dynamic`, ssr:false) by
// `PaymentLedger`, so the dashboard's first load does not carry the grid.
//
// Modules: only what this table uses — the client-side row model and cell classes
// (`ValidationModule` in development only, for AG Grid's own warnings). No Enterprise package is installed.
//
// Expanding a row: Community has no master/detail, so the record is a **full-width row** (Community
// feature: `isFullWidthRow` + `fullWidthCellRenderer`) inserted right after the opened row. Sorting is
// off — the list is already newest first, and sorting would separate a record from its row.
// Filtering happens before the rows reach the grid (`filterLedger`), not with AG Grid filters.

import { useMemo } from 'react';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type ICellRendererParams,
  type IsFullWidthRowParams,
  type Module,
  type RowHeightParams,
} from 'ag-grid-community';
import { useTranslations } from 'next-intl';
import type { LedgerRow } from '@/lib/paypal/ledger';
import {
  ConversationLink,
  DecisionControls,
  LedgerRecord,
  LedgerTime,
  RecordToggle,
  SampleChip,
  StatusBadge,
  TypeLabel,
  ledgerAmount,
  useLedgerUi,
} from './PaymentLedgerParts';

const MODULES: Module[] = [
  ClientSideRowModelModule,
  CellStyleModule,
  ...(process.env.NODE_ENV !== 'production' ? [ValidationModule] : []),
];

const ROW_HEIGHT = 48;
const HEADER_HEIGHT = 38;

/** App tokens (globals.css) — the grid follows the app's light / dark theme without a second palette. */
const THEME = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12.5,
  headerFontWeight: 600,
  spacing: 6,
  backgroundColor: 'var(--card)',
  foregroundColor: 'var(--foreground)',
  headerBackgroundColor: 'var(--muted)',
  headerTextColor: 'var(--muted-foreground)',
  borderColor: 'var(--border)',
  rowHoverColor: 'var(--muted)',
  accentColor: 'var(--primary)',
  wrapperBorderRadius: 16,
  // Heights as theme params (not grid props): the theme derives the cells' line-height from them, which
  // centres text vertically.
  rowHeight: ROW_HEIGHT,
  headerHeight: HEADER_HEIGHT,
  browserColorScheme: 'inherit',
});

/** Record rows scroll inside when longer. Refund records carry a timeline; purchases are a few lines. */
const RECORD_HEIGHT = { action: 300, purchase: 200 } as const;
const MAX_GRID_HEIGHT = 560;

type GridRow = { kind: 'row'; key: string; row: LedgerRow } | { kind: 'record'; key: string; row: LedgerRow };

function recordHeight(row: LedgerRow): number {
  return row.type === 'purchase' ? RECORD_HEIGHT.purchase : RECORD_HEIGHT.action;
}

// Grid callbacks as stable functions: AG Grid reads some of them only once (getRowId).
const getRowId = (p: GetRowIdParams<GridRow>) => p.data.key;
const getRowHeight = (p: RowHeightParams<GridRow>) => (p.data?.kind === 'record' ? recordHeight(p.data.row) : undefined);
const isFullWidthRow = (p: IsFullWidthRowParams<GridRow>) => p.rowNode.data?.kind === 'record';
const DEFAULT_COL_DEF: ColDef<GridRow> = { sortable: false, resizable: false, suppressMovable: true };

function RecordRow({ data }: ICellRendererParams<GridRow>) {
  if (!data) return null;
  return (
    <div className="h-full overflow-y-auto border-b border-border bg-muted/40 px-5 py-4 leading-normal whitespace-normal">
      <LedgerRecord row={data.row} />
    </div>
  );
}

function ActionsCell({ data }: ICellRendererParams<GridRow>) {
  const { confirming } = useLedgerUi();
  if (!data) return null;
  // While the confirm step is open it needs the whole cell; Details comes back when it closes.
  const confirmingHere = confirming?.key === data.row.key;
  return (
    <div className="flex h-full w-full min-w-0 items-center gap-2 leading-normal">
      <div className="min-w-0 flex-1">
        <DecisionControls row={data.row} inline />
      </div>
      <SampleChip row={data.row} />
      {!confirmingHere && <RecordToggle row={data.row} />}
    </div>
  );
}

export default function PaymentLedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const t = useTranslations('dashboard.payments.ledger');
  const tOrigin = useTranslations('dashboard.payments.ledger.origin');
  const { expandedKey } = useLedgerUi();

  const gridRows = useMemo<GridRow[]>(
    () =>
      rows.flatMap((row) =>
        row.key === expandedKey
          ? [{ kind: 'row', key: row.key, row }, { kind: 'record', key: `${row.key}:record`, row }]
          : [{ kind: 'row', key: row.key, row }],
      ),
    [rows, expandedKey],
  );

  // Flex columns with minimum widths. The minimums (~1050px) fit what the page has from `xl` (the 1120px
  // container minus padding), so nothing scrolls sideways or cuts short labels where the grid takes over from
  // the cards; longer statuses truncate with the full text in `title`. Actions gets the spare room and is
  // wide enough for the confirm step («Approve the $79 refund?  Confirm  Cancel») on one line. `t` from
  // next-intl is memoised on (messages, locale, time zone), so these defs are rebuilt only when the language
  // or the time zone changes.
  const columnDefs = useMemo<ColDef<GridRow>[]>(
    () => [
      { colId: 'time', headerName: t('columns.time'), flex: 1.4, minWidth: 190, cellRenderer: (p: ICellRendererParams<GridRow>) => (p.data ? <LedgerTime at={p.data.row.at} /> : null) },
      { colId: 'type', headerName: t('columns.type'), flex: 0.8, minWidth: 90, cellRenderer: (p: ICellRendererParams<GridRow>) => (p.data ? <TypeLabel row={p.data.row} withSample={false} /> : null) },
      {
        colId: 'amount',
        headerName: t('columns.amount'),
        flex: 0.8,
        minWidth: 76,
        cellClass: 'tabular-nums font-semibold',
        valueGetter: (p) => (p.data ? ledgerAmount(p.data.row) : ''),
      },
      { colId: 'status', headerName: t('columns.status'), flex: 1.3, minWidth: 176, cellRenderer: (p: ICellRendererParams<GridRow>) => (p.data ? <StatusBadge row={p.data.row} /> : null) },
      {
        colId: 'origin',
        headerName: t('columns.origin'),
        flex: 1,
        minWidth: 130,
        cellClass: 'text-muted-foreground',
        valueGetter: (p) => (p.data?.row.origin ? tOrigin(p.data.row.origin) : '—'),
      },
      { colId: 'conversation', headerName: t('columns.conversation'), flex: 0.9, minWidth: 110, cellRenderer: (p: ICellRendererParams<GridRow>) => (p.data ? <ConversationLink row={p.data.row} /> : null) },
      { colId: 'actions', headerName: t('columns.actions'), flex: 2.6, minWidth: 280, cellRenderer: ActionsCell },
    ],
    [t, tOrigin],
  );

  const height = Math.min(
    MAX_GRID_HEIGHT,
    // +4: the wrapper border; without it the grid shows an empty scrollbar track.
    HEADER_HEIGHT + 4 + gridRows.reduce((sum, r) => sum + (r.kind === 'record' ? recordHeight(r.row) : ROW_HEIGHT), 0),
  );

  return (
    <AgGridProvider modules={MODULES}>
      <div style={{ height }}>
        <AgGridReact<GridRow>
          theme={THEME}
          rowData={gridRows}
          columnDefs={columnDefs}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={getRowId}
          getRowHeight={getRowHeight}
          isFullWidthRow={isFullWidthRow}
          fullWidthCellRenderer={RecordRow}
          suppressCellFocus
          // Rows in the DOM in visual order — screen readers and Tab follow the list, not render order.
          ensureDomOrder
          animateRows={false}
        />
      </div>
    </AgGridProvider>
  );
}

// The report Refund Studio opens on: one page, "Refunds & reasons". Field ids refer to `./data.ts`.
// Canvas grid: 24 columns wide, rows of `studioCanvasRowHeight` (18px).

import type { AgReportState, AgWidgetLayoutState } from 'ag-studio';
import { REASON_FIX_WIDGET } from '@/components/studio/ReasonFixWidget';

export const STUDIO_PAGE_ID = 'refunds';

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle && { subtitle: { enabled: true, text: subtitle } }),
});
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const countd = (id: string) => ({ id, aggregation: 'countd' as const });

const kpi = (text: string, value: { id: string; aggregation?: 'sum' | 'countd' }, sparklineX?: string) => ({
  type: 'value' as const,
  dataMapping: { value: [value], ...(sparklineX && { sparklineX: [{ id: sparklineX }] }) },
  format: { title: { enabled: true, text }, caption: { enabled: false } },
});

export function initialReport(): AgReportState {
  return {
    selectedPageId: STUDIO_PAGE_ID,
    // The filters panel would say "No filters available" beside the canvas — start it collapsed.
    panels: { filters: { collapsed: true } },
    pages: [
      {
        id: STUDIO_PAGE_ID,
        widgets: {
          'kpi-refunds': kpi('Refund requests', countd('refunds.id'), 'calendar::week'),
          'kpi-rate': { type: 'value', dataMapping: { value: [{ id: 'refundRate' }] }, format: { title: { enabled: true, text: 'Refund rate' }, caption: { enabled: true, text: 'of revenue' } } },
          'kpi-refunded': kpi('Refunded', sum('refunds.amount'), 'calendar::week'),
          'kpi-revenue': kpi('Revenue', sum('payments.amount'), 'calendar::week'),
          'by-week': {
            type: 'column-chart-stacked',
            dataMapping: {
              categoryKey: [{ id: 'refunds.weekStart' }],
              valueKey: [countd('refunds.id')],
              legendKey: [{ id: 'refunds.bucket' }],
            },
            format: {
              ...title('Refunds per week, by reason type'),
              style: { theme: { common: { legend: { enabled: true } } } },
            },
          },
          'reason-fix': {
            type: REASON_FIX_WIDGET,
            format: { ...title('Every refund has a reason', 'Top reasons and where each one went') },
          },
          'by-reason': {
            type: 'bar-chart-grouped',
            dataMapping: {
              categoryKey: [{ id: 'refunds.reason' }],
              valueKey: [sum('refunds.amount')],
            },
            sort: [{ field: sum('refunds.amount'), direction: 'desc' }],
            format: title('Refunded amount by reason'),
          },
          ledger: {
            type: 'grid',
            dataMapping: {
              cols: [
                { id: 'refunds.date' },
                { id: 'refunds.product' },
                { id: 'refunds.reason' },
                { id: 'refunds.bucket' },
                { id: 'refunds.fixStatus' },
                sum('refunds.amount'),
              ],
            },
            sort: [{ field: { id: 'refunds.date' }, direction: 'desc' }],
            format: title('Refund ledger'),
          },
        },
        widgetLayout: {
          'kpi-refunds': at(0, 0, 6, 7),
          'kpi-rate': at(6, 0, 6, 7),
          'kpi-refunded': at(12, 0, 6, 7),
          'kpi-revenue': at(18, 0, 6, 7),
          'by-week': at(0, 7, 14, 18),
          'reason-fix': at(14, 7, 10, 18),
          'by-reason': at(0, 25, 12, 18),
          ledger: at(12, 25, 12, 18),
        },
      },
    ],
  } as unknown as AgReportState;
}

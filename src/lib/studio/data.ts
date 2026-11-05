// AG Studio data sources for Refund Studio: two tables (payments, refunds), the refund → payment link,
// a shared calendar and two measures. Field ids ('refunds.amount') are what the report state and the agent use.

import type { AgDataSourcesDefinition, AgFieldDefinition, AgFormat } from 'ag-studio';
import type { SampleStore } from './sample';

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];
// Fixed en-US formatters: the sample is a USD store, and the browser's own locale rendered dates oddly.
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const FORMAT_OPTIONS: Partial<Record<string, { format: Intl.NumberFormat | Intl.DateTimeFormat }>> = {
  currencyFormat: { format: USD },
  dateFormat: { format: DAY },
};

const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({
    id,
    name,
    format,
    ...(FORMAT_OPTIONS[format] && { formatOptions: FORMAT_OPTIONS[format] }),
    ...(hide && { hide }),
  }));

export const CALENDAR_ID = 'calendar';

export function buildStudioData(store: SampleStore): AgDataSourcesDefinition {
  return {
    description:
      'Sample store data (not measured): 90 days of a small SaaS shop that sells Starter ($9), Pro ($29) and Agency ($79) through PayPal, all in USD. ' +
      'Feedloop, the store’s AI support agent, records why each refund was asked for and classifies the reason: ' +
      '"Bug / UX" reasons go to a fix pull request, "Feature request" reasons to a spec, "Other" needs no code. ' +
      'Every refund has a reason — the point of this dashboard is to see which reason is costing money and whether its fix shipped.',
    sources: [
      {
        id: 'payments',
        name: 'Payments',
        description: 'One row per PayPal purchase (captured order). Refunded amount is the part paid back.',
        data: store.payments,
        fields: fields([
          ['id', 'Payment ID', 'textFormat'],
          ['date', 'Payment Date', 'dateFormat'],
          ['product', 'Product', 'textFormat'],
          ['status', 'Payment Status', 'textFormat'],
          ['amount', 'Revenue', 'currencyFormat'],
          ['refundedAmount', 'Refunded', 'currencyFormat'],
        ]),
      },
      {
        id: 'refunds',
        name: 'Refunds',
        description:
          'One row per refund request, with the reason the customer gave and where that reason went. ' +
          'Reason key identifies a reason group; Fix URL is the fix PR or null.',
        data: store.refunds,
        fields: fields([
          ['id', 'Refund ID', 'textFormat'],
          ['paymentId', 'Payment ID', 'textFormat', true],
          ['date', 'Refund Date', 'dateFormat'],
          ['weekStart', 'Refund Week', 'dateFormat'],
          ['product', 'Refunded Product', 'textFormat'],
          ['amount', 'Refund Amount', 'currencyFormat'],
          // Not hidden: the Reason → Fix widget reads these through the report schema, which omits hidden fields.
          ['reasonKey', 'Reason Key', 'textFormat'],
          ['reason', 'Refund Reason', 'textFormat'],
          ['bucket', 'Reason Type', 'textFormat'],
          ['fixStatus', 'Fix Status', 'textFormat'],
          ['fixUrl', 'Fix URL', 'textFormat'],
        ]),
      },
    ],
    relationships: [
      {
        id: 'refund-payment',
        source: { tableId: 'refunds', fieldId: 'paymentId' },
        target: { tableId: 'payments', fieldId: 'id' },
        type: 'many-to-one',
      },
      { id: 'payments-date-calendar', source: { tableId: 'payments', fieldId: 'date' }, target: { calendarId: CALENDAR_ID } },
      { id: 'refunds-date-calendar', source: { tableId: 'refunds', fieldId: 'date' }, target: { calendarId: CALENDAR_ID } },
    ],
    calendars: [
      {
        id: CALENDAR_ID,
        label: 'Calendar',
        range: { from: { type: 'date', value: store.from }, to: { type: 'date', value: store.asOf } },
        fragments: ['year', 'quarter', 'month', 'week', 'day', 'dayOfWeek'],
      },
    ],
    expressions: [
      {
        id: 'refundRate',
        name: 'Refund Rate',
        description: 'Refunded / revenue, over payments.',
        format: 'percentageFormat',
        isMeasure: true,
        expression: {
          operator: 'divide',
          inputs: [
            { id: 'payments.refundedAmount', aggregation: 'sum' },
            { id: 'payments.amount', aggregation: 'sum' },
          ],
        },
      },
    ],
  };
}

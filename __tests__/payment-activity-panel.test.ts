// The inbox «Payment activity» panel (stage 5, item 6) and the sample-data payment conversation.
// The panel renders the ledger's own rows and record view, read-only; the approval card above keeps the buttons.
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentActivityPanel } from '@/components/inbox/PaymentActivityPanel';
import { actionToLedgerRow, orderToLedgerRow, type LedgerActionRow, type LedgerRow } from '@/lib/paypal/ledger';
import type { PaymentActionView } from '@/lib/paypal/action-view';
import { getDemoData } from '@/lib/demo/mock-data';
import { renderWithIntl } from './helpers/intl';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const pending = actionToLedgerRow({
  id: 'act-1',
  kind: 'refund',
  origin: 'approval',
  status: 'pending',
  amount_cents: 7900,
  currency: 'USD',
  target_id: 'CAPTURE1',
  conversation_id: 'conv-1',
  paypal_ref: null,
  reason: 'too expensive',
  guardrail: { amount_within_max: false, within_days: true },
  error: null,
  decided_at: null,
  decided_by: null,
  executed_at: null,
  created_at: '2026-10-22T10:00:00.000Z',
  updated_at: '2026-10-22T10:00:00.000Z',
  payload: null,
  result: null,
});

const purchase = orderToLedgerRow({
  order_id: 'ORDER1',
  status: 'captured',
  amount_cents: 7900,
  currency: 'USD',
  quantity: 1,
  capture_id: 'CAPTURE1',
  conversation_id: 'conv-1',
  refunded_cents: 0,
  created_at: '2026-10-20T10:00:00.000Z',
  captured_at: '2026-10-20T10:01:00.000Z',
  refunded_at: null,
  product_name: 'Agency',
});

const render = (rows: LedgerRow[], locale: 'en' | 'ko' = 'en', hasCard?: (id: string) => boolean) =>
  renderWithIntl(React.createElement(PaymentActivityPanel, { rows, hasCard }), locale);

describe('PaymentActivityPanel', () => {
  it('renders nothing when the conversation has no payment rows', () => {
    expect(render([])).toBe('');
  });

  it('lists the rows (refund + purchase) with amount, status, origin, product — read-only', () => {
    const html = render([pending, purchase], 'en', (id) => id === 'act-1');
    for (const text of ['Payment activity', '2 entries', 'Refund', 'Purchase', '$79', 'Waiting for approval', 'Manual approval', 'Paid', 'Agency', 'Details']) {
      expect(html).toContain(text);
    }
    // No decision buttons here — the approval card above has them.
    expect(html).not.toMatch(/>Approve</);
    expect(html).not.toMatch(/>Reject</);
    expect(html).toContain('Approve or reject it in the approval card above.');
    // Toggles name what they open.
    expect(html).toMatch(/aria-controls="[^"]+"/);
  });

  it('points to the approval card only when a decidable card for that row is on screen (not on sample data)', () => {
    expect(render([pending])).not.toContain('approval card above');
    expect(render([pending], 'en', (id) => id === 'other')).not.toContain('approval card above');
  });

  it('starts collapsed when long (more than 2 rows)', () => {
    const many = [pending, purchase, { ...purchase, key: 'order:ORDER2', id: 'ORDER2' }];
    const html = render(many);
    expect(html).toContain('3 entries');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Waiting for approval');
  });

  it('ko', () => {
    const html = render([pending], 'ko');
    expect(html).toContain('결제 내역');
    expect(html).toContain('승인 대기');
  });
});

describe('sample-data payment conversation', () => {
  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: the pending $79 refund and its Agency purchase lead to one inbox conversation with the card and the panel`, () => {
      const data = getDemoData(locale);
      const ledger = (data.dashboard as { ledger: LedgerRow[] }).ledger;
      const inbox = data.inbox as {
        conversations: { id: string; escalated?: boolean }[];
        timelines: Record<string, unknown[]>;
        payments: Record<string, { actions: PaymentActionView[]; rows: LedgerRow[] }>;
      };
      const linked = ledger.filter((r) => r.conversationId !== null);
      const convId = linked[0]?.conversationId as string;
      expect(linked.map((r) => [r.type, r.status, r.amountCents])).toEqual([
        ['refund', 'pending', 7900],
        ['purchase', 'captured', 7900],
      ]);
      expect(linked.every((r) => r.conversationId === convId)).toBe(true);

      const conv = inbox.conversations.find((c) => c.id === convId);
      expect(conv?.escalated).toBe(true);
      expect(inbox.timelines[convId]?.length).toBeGreaterThan(0);

      // The panel shows exactly the ledger's rows for that conversation.
      const payment = inbox.payments[convId];
      expect(payment.rows).toEqual(linked);
      // The approval card is the same pending refund: $79, the one failed check.
      const pendingRow = linked[0] as LedgerActionRow;
      expect(payment.actions).toHaveLength(1);
      expect(payment.actions[0]).toMatchObject({ id: pendingRow.id, status: 'pending', amountCents: 7900, amount: '$79', decidable: true });
      expect(payment.actions[0].checks.filter((c) => !c.passed).map((c) => c.key)).toEqual(pendingRow.detail.failedChecks);
      // The dashboard's «1 waiting for approval» is this one.
      const pendingCount = (data.dashboard as { payments: { pendingApprovals: number } }).payments.pendingApprovals;
      expect(ledger.filter((r) => r.status === 'pending')).toHaveLength(pendingCount);
    });
  }
});

// The payment ledger's pure parts (row mapping, filters, decision wiring) and its server-rendered
// card list / execution record. The grid itself (AG Grid) needs a browser and is not rendered here.
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  actionToLedgerRow,
  applyActionView,
  compareLedgerRows,
  filterLedger,
  ledgerConversationHref,
  ledgerStatusOptions,
  ledgerTypeOptions,
  shortOrderId,
  mergeLedger,
  orderToLedgerRow,
  postLedgerDecision,
  replaceLedgerRow,
  type LedgerActionRow,
  type LedgerActionSource,
  type LedgerOrderSource,
  type LedgerRow,
} from '@/lib/paypal/ledger';
import { PaymentLedger } from '@/components/dashboard/PaymentLedger';
import { LedgerRecord, LedgerUiContext, type LedgerUi } from '@/components/dashboard/PaymentLedgerParts';
import { getDemoData } from '@/lib/demo/mock-data';
import { renderWithIntl } from './helpers/intl';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const actionSource = (o: Partial<LedgerActionSource> = {}): LedgerActionSource => ({
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
  ...o,
});

const orderSource = (o: Partial<LedgerOrderSource> = {}): LedgerOrderSource => ({
  order_id: 'ORDER1',
  status: 'captured',
  amount_cents: 2900,
  currency: 'USD',
  quantity: 1,
  capture_id: 'CAPTURE1',
  conversation_id: null,
  refunded_cents: 0,
  created_at: '2026-10-22T09:00:00.000Z',
  captured_at: '2026-10-22T09:01:00.000Z',
  refunded_at: null,
  product_name: 'Pro',
  ...o,
});

describe('row mapping', () => {
  it('refund: decidable only when pending, a refund, and in a conversation', () => {
    expect(actionToLedgerRow(actionSource()).decidable).toBe(true);
    expect(actionToLedgerRow(actionSource({ status: 'executed' })).decidable).toBe(false);
    expect(actionToLedgerRow(actionSource({ conversation_id: null })).decidable).toBe(false);
    expect(actionToLedgerRow(actionSource({ kind: 'accept_dispute' }))).toMatchObject({ type: 'dispute', decidable: false });
  });

  it('reads payload / result defensively and keeps only the amount sent and the status word', () => {
    const row = actionToLedgerRow(
      actionSource({ payload: { amount: { value: '79.00', currency_code: 'USD' }, note_to_payer: 'x' }, result: { status: 'COMPLETED', id: 'R1', links: [] } }),
    );
    expect(row.detail.sent).toEqual({ value: '79.00', currency: 'USD' });
    expect(row.detail.resultStatus).toBe('COMPLETED');
    expect(actionToLedgerRow(actionSource({ payload: 'garbage', result: 42 })).detail).toMatchObject({ sent: null, resultStatus: null });
    expect(actionToLedgerRow(actionSource({ payload: { amount: { value: 79 } } })).detail.sent).toBeNull();
  });

  it('failed checks are the guardrail keys that did not pass', () => {
    expect(actionToLedgerRow(actionSource()).detail.failedChecks).toEqual(['amount_within_max']);
    expect(actionToLedgerRow(actionSource({ guardrail: null })).detail.failedChecks).toEqual([]);
  });

  it('sample: a SAMPLE- capture or refund id (seeded sample history); real ids are not', () => {
    expect(actionToLedgerRow(actionSource()).sample).toBe(false);
    expect(actionToLedgerRow(actionSource({ target_id: 'SAMPLE-CAP-0001', status: 'executed', paypal_ref: 'SAMPLE-REF-0001' })).sample).toBe(true);
    expect(actionToLedgerRow(actionSource({ paypal_ref: 'SAMPLE-REF-0002' })).sample).toBe(true);
    expect(actionToLedgerRow(actionSource({ target_id: '5O190127TN364715T', paypal_ref: '7XK01234AB567890C' })).sample).toBe(false);
  });

  it('purchase row', () => {
    expect(orderToLedgerRow(orderSource({ refunded_cents: null }))).toMatchObject({
      key: 'order:ORDER1',
      type: 'purchase',
      origin: null,
      decidable: false,
      detail: { refundedCents: 0, product: 'Pro' },
    });
  });

  it('merge: newest first, ties stable by key, cut past the limit', () => {
    const a = actionToLedgerRow(actionSource({ id: 'b', created_at: '2026-10-22T10:00:00.000Z' }));
    const b = actionToLedgerRow(actionSource({ id: 'a', created_at: '2026-10-22T10:00:00.000Z' }));
    const o = orderToLedgerRow(orderSource());
    expect(mergeLedger([a, b], [o], 10).rows.map((r) => r.key)).toEqual(['action:a', 'action:b', 'order:ORDER1']);
    expect(mergeLedger([a, b], [o], 2)).toMatchObject({ cut: true });
    expect(compareLedgerRows(o, a)).toBeGreaterThan(0);
  });
});

describe('filters', () => {
  const rows: LedgerRow[] = [
    actionToLedgerRow(actionSource({ id: 'p' })),
    actionToLedgerRow(actionSource({ id: 'e', status: 'executed', origin: 'auto' })),
    orderToLedgerRow(orderSource({ order_id: 'O1' })),
    orderToLedgerRow(orderSource({ order_id: 'O2', status: 'refunded' })),
  ];

  it('type and status combine; status is keyed by type, so refund «failed» ≠ purchase «failed»', () => {
    expect(filterLedger(rows, 'all', 'all')).toHaveLength(4);
    expect(filterLedger(rows, 'refund', 'all').map((r) => r.id)).toEqual(['p', 'e']);
    expect(filterLedger(rows, 'all', 'purchase:refunded').map((r) => r.id)).toEqual(['O2']);
    expect(filterLedger(rows, 'purchase', 'refund:pending')).toEqual([]);
    const failed = [actionToLedgerRow(actionSource({ id: 'rf', status: 'failed' })), orderToLedgerRow(orderSource({ order_id: 'OF', status: 'failed' }))];
    expect(filterLedger(failed, 'all', 'refund:failed').map((r) => r.id)).toEqual(['rf']);
    expect(ledgerStatusOptions(failed, 'all')).toEqual(['refund:failed', 'purchase:failed']);
  });

  it('status choices are those present for the type; type choices hide absent types', () => {
    expect(ledgerStatusOptions(rows, 'all')).toEqual(['refund:pending', 'refund:executed', 'purchase:captured', 'purchase:refunded']);
    expect(ledgerStatusOptions(rows, 'purchase')).toEqual(['purchase:captured', 'purchase:refunded']);
    expect(ledgerTypeOptions(rows)).toEqual(['all', 'refund', 'purchase']);
  });

  it('after a decision: the active status stays a choice, and the decided row stays on screen', () => {
    // «Waiting for approval» was chosen; the only pending row was approved and is now executed.
    const after = [actionToLedgerRow(actionSource({ id: 'p', status: 'executed' })), orderToLedgerRow(orderSource())];
    expect(ledgerStatusOptions(after, 'all', 'refund:pending')).toContain('refund:pending');
    expect(filterLedger(after, 'all', 'refund:pending')).toEqual([]);
    expect(filterLedger(after, 'all', 'refund:pending', new Set(['action:p'])).map((r) => r.id)).toEqual(['p']);
    // The type filter still applies to kept rows.
    expect(filterLedger(after, 'purchase', 'all', new Set(['action:p'])).map((r) => r.id)).toEqual(['ORDER1']);
  });

  it('short order id for non-owners', () => {
    expect(shortOrderId('5O190127TN364715T')).toBe('…64715T');
    expect(orderToLedgerRow(orderSource({ order_id: '5O190127TN364715T' }), { fullOrderId: false })).toMatchObject({
      id: '…64715T',
      detail: { orderId: '…64715T' },
    });
  });

  it('conversation link is the inbox deep link', () => {
    expect(ledgerConversationHref('conv 1')).toBe('/inbox?c=conv%201');
  });
});

describe('Approve / Reject reuse the inbox decision route', () => {
  const row = actionToLedgerRow(actionSource());
  const view = (o: Record<string, unknown> = {}) => ({
    id: 'act-1', kind: 'refund', status: 'executed', origin: 'approval', amountCents: 7900, currency: 'USD', amount: '$79',
    reason: null, captureId: 'CAPTURE1', checks: [], paypalRef: 'R1', error: null, createdAt: row.at, decidedAt: '2026-10-22T11:00:00.000Z', decidable: false, ...o,
  });

  it('POSTs { decision } to /api/inbox/<conversation>/payment-actions/<action>', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ decision: 'approve', action: view() }), { status: 200 }));
    const effect = await postLedgerDecision(row, 'approve', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith('/api/inbox/conv-1/payment-actions/act-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(effect).toMatchObject({ status: 200, cardError: null, action: { status: 'executed' } });
  });

  it('409 (already decided) → the current row plus the «already decided» code', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'x', action: view({ status: 'rejected' }) }), { status: 409 }));
    const effect = await postLedgerDecision(row, 'reject', fetchImpl as unknown as typeof fetch);
    expect(effect).toMatchObject({ status: 409, cardErrorCode: 'alreadyDecided', action: { status: 'rejected' } });
  });

  it('a denial (403) surfaces the route’s error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "You don't have access to this bot" }), { status: 403 }));
    const effect = await postLedgerDecision(row, 'approve', fetchImpl as unknown as typeof fetch);
    expect(effect).toMatchObject({ status: 403, action: null, cardError: "You don't have access to this bot" });
  });

  it('no conversation → no request', async () => {
    const fetchImpl = vi.fn();
    const effect = await postLedgerDecision({ ...row, conversationId: null }, 'approve', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(effect.action).toBeNull();
  });

  it('the answer replaces the row in place', () => {
    const next = applyActionView(row, view() as never);
    expect(next).toMatchObject({ status: 'executed', decidable: false, detail: { paypalRef: 'R1', decidedAt: '2026-10-22T11:00:00.000Z' } });
    expect(applyActionView(row, view({ id: 'other' }) as never)).toBe(row);
    const rows = [row, orderToLedgerRow(orderSource())];
    expect(replaceLedgerRow(rows, next)[0]).toBe(next);
  });
});

describe('sample-data ledger', () => {
  const sample = (getDemoData('en').dashboard as { ledger: LedgerRow[] }).ledger;

  it('matches the sample numbers: 3 auto refunds = $47, 1 pending, 1 failed; newest first', () => {
    const auto = sample.filter((r) => r.type === 'refund' && r.origin === 'auto' && r.status === 'executed');
    expect(auto).toHaveLength(3);
    expect(auto.reduce((s, r) => s + (r.amountCents ?? 0), 0)).toBe(4700);
    expect(sample.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(sample.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect([...sample].sort(compareLedgerRows).map((r) => r.key)).toEqual(sample.map((r) => r.key));
  });

  it('card list renders with Approve / Reject off and the hint (en + ko)', () => {
    const en = renderWithIntl(React.createElement(PaymentLedger, { botId: null, demoRows: sample }), 'en');
    expect(en).toContain('Payment ledger');
    expect(en).toContain('$79');
    expect(en).toContain('Waiting for approval');
    expect(en).toContain('Sample data: Approve and Reject are off.');
    expect(en).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(en).toContain('Refunded');
    // Type = All: status choices name the type, so refund «Failed» and purchase «Paid» read apart.
    expect(en).toContain('Refund · Failed');
    expect(en).toContain('Purchase · Paid');
    expect(en).toContain('Manual approval');
    const ko = renderWithIntl(React.createElement(PaymentLedger, { botId: null, demoRows: sample }), 'ko');
    expect(ko).toContain('결제 장부');
    expect(ko).toContain('승인 대기');
  });
});

describe('seeded sample rows', () => {
  const chip = />Sample<\/span>/g;
  it('card list: a Sample chip on the sample refund only; its PayPal ids stay plain text (en + ko)', () => {
    const rows: LedgerRow[] = [
      actionToLedgerRow(actionSource({ id: 's1', target_id: 'SAMPLE-CAP-0001', status: 'executed', paypal_ref: 'SAMPLE-REF-0001' })),
      actionToLedgerRow(actionSource({ id: 'r1', status: 'executed', paypal_ref: 'REF1' })),
      orderToLedgerRow(orderSource()),
    ];
    const en = renderWithIntl(React.createElement(PaymentLedger, { botId: null, demoRows: rows }), 'en');
    expect(en.match(chip)).toHaveLength(1);
    expect(en).not.toMatch(/href="[^"]*SAMPLE-/);
    const ko = renderWithIntl(React.createElement(PaymentLedger, { botId: null, demoRows: rows }), 'ko');
    expect(ko.match(/>샘플<\/span>/g)).toHaveLength(1);
  });
});

describe('execution record', () => {
  const ui: LedgerUi = {
    demo: false, expandedKey: null, toggleExpanded: () => {}, confirming: null, askConfirm: () => {}, busyKey: null, decide: () => {}, messages: {},
    focusRequest: null, clearFocusRequest: () => {},
  };
  const render = (row: LedgerRow, locale: 'en' | 'ko' = 'en') =>
    renderWithIntl(React.createElement(LedgerUiContext.Provider, { value: ui }, React.createElement(LedgerRecord, { row })), locale);

  it('refund: call, amount sent, result, capture, reference, timeline, why, error', () => {
    const row: LedgerActionRow = actionToLedgerRow(
      actionSource({
        status: 'failed',
        payload: { amount: { value: '79.00', currency_code: 'USD' } },
        paypal_ref: 'R1',
        error: 'REFUND_FAILED',
        decided_at: '2026-10-22T10:30:00.000Z',
        decided_by: 'u',
      }),
      () => ({ self: true, name: 'Owner' }),
    );
    const html = render(row);
    for (const text of ['Execution record', 'Refund a captured payment', '79.00 USD', 'CAPTURE1', 'R1', 'Requested', 'Approved', 'by you', 'Failed', 'REFUND_FAILED']) {
      expect(html).toContain(text);
    }
    // Decided: «Why this needs your approval» is gone.
    expect(html).not.toContain('Why this needs your approval');
    expect(render(row, 'ko')).toContain('실행 기록');
  });

  it('pending refund: shows why it waits; an approver sees «a team member», never a name', () => {
    expect(render(actionToLedgerRow(actionSource()))).toContain('Over the auto-refund limit');
    expect(render(actionToLedgerRow(actionSource()))).not.toContain('within auto limit');
    const decided = actionToLedgerRow(actionSource({ status: 'rejected', decided_at: '2026-10-22T10:30:00.000Z', decided_by: 'u' }), () => ({ self: false, name: null }));
    expect(render(decided)).toContain('by a team member');
  });

  it('expired: an Expired step from updated_at (expiry sets no decided_at)', () => {
    const html = render(actionToLedgerRow(actionSource({ status: 'expired', updated_at: '2026-10-29T10:00:00.000Z' })));
    expect(html).toContain('Expired');
    expect(html).toContain('2026-10-29T10:00:00.000Z');
    expect(html).not.toContain('>Approved<');
  });

  it('dispute: the executed step reads «Accepted»', () => {
    const html = render(actionToLedgerRow(actionSource({ kind: 'accept_dispute', status: 'executed', executed_at: '2026-10-22T11:00:00.000Z' })));
    expect(html).toContain('Accepted');
    expect(html).not.toContain('Sent to PayPal');
  });

  it('English times name the time zone', () => {
    expect(render(orderToLedgerRow(orderSource()))).toMatch(/UTC/);
  });

  it('purchase: order, capture, product, refunded amount', () => {
    const html = render(orderToLedgerRow(orderSource({ status: 'partially_refunded', refunded_cents: 900, refunded_at: '2026-10-22T12:00:00.000Z' })));
    for (const text of ['ORDER1', 'CAPTURE1', 'Pro', '$9', 'Refund recorded']) expect(html).toContain(text);
  });
});

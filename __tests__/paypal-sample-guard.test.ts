// F4: a seeded sample refund (SAMPLE- capture id, scripts/seed-sample-history.ts) never reaches PayPal — not
// through an approval, not through reconciliation, not through the daily sweep — and gets no sentence in its chat.
import { describe, expect, it } from 'vitest';
import { executeApprovedAction, reconcileAction } from '@/lib/paypal/refund';
import { sweepStuckActions } from '@/lib/paypal/reconcile';
import type { PaymentActionRow } from '@/lib/paypal/store';
import { BOT, CONVERSATION, fakePayPal, memoryStore } from './fixtures/paypal/fakes';

const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

function sampleRow(o: Partial<PaymentActionRow> = {}): PaymentActionRow {
  return {
    id: `sample-action-${o.status ?? 'executing'}`,
    bot_id: BOT,
    conversation_id: CONVERSATION,
    kind: 'refund',
    target_id: 'SAMPLE-CAP-0001',
    amount_cents: 2900,
    currency: 'USD',
    customer_key: null,
    origin: 'approval',
    status: 'executing',
    reason: 'Coupon code not applied',
    guardrail: { amount_within_max: false },
    paypal_ref: null,
    error: null,
    decided_by: null,
    decided_at: HOUR_AGO,
    created_at: HOUR_AGO,
    updated_at: HOUR_AGO,
    reconcile_attempts: 0,
    reconcile_attempted_at: null,
    sent_at: null,
    send_attempts: 0,
    ...o,
  };
}

function setup(rows: PaymentActionRow[]) {
  const store = memoryStore();
  const pp = fakePayPal();
  store.actions.push(...rows.map((r) => ({ ...r })));
  return { store, pp, deps: { store, paypal: pp.client } };
}

describe('SAMPLE- refunds never reach PayPal', () => {
  it('executeApprovedAction: not_executable, no PayPal call, row untouched', async () => {
    const row = sampleRow();
    const { store, pp, deps } = setup([row]);
    const r = await executeApprovedAction(deps, store.actions[0]);
    expect(r.status).toBe('not_executable');
    expect(pp.calls).toHaveLength(0);
    expect(store.actions[0]).toMatchObject({ status: 'executing', sent_at: null, send_attempts: 0 });
  });

  it.each([
    ['executing', null],
    ['unknown', null],
    ['unknown', 'SAMPLE-REF-0001'],
  ] as const)('reconcileAction (%s, paypal_ref %s): noop, no PayPal call', async (status, paypalRef) => {
    const { store, pp, deps } = setup([sampleRow({ status, paypal_ref: paypalRef })]);
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('noop');
    expect(pp.calls).toHaveLength(0);
    expect(store.actions[0].status).toBe(status);
  });

  it('reconcileAction on a finished sample row writes no sentence into the conversation', async () => {
    const { store, pp, deps } = setup([sampleRow({ status: 'executed', paypal_ref: 'SAMPLE-REF-0001' })]);
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('noop');
    expect(store.responses).toHaveLength(0);
    expect(pp.calls).toHaveLength(0);
  });

  it('sweepStuckActions: stuck sample rows are skipped without any PayPal call', async () => {
    const { store, pp } = setup([
      sampleRow({ id: 'a1', status: 'executing' }),
      sampleRow({ id: 'a2', status: 'unknown', target_id: 'SAMPLE-CAP-0002', paypal_ref: 'SAMPLE-REF-0002' }),
    ]);
    const result = await sweepStuckActions({ store, paypalFor: async () => pp.client });
    expect(result).toMatchObject({ scanned: 2, executed: 0, failed: 0, stillPending: 0, unreachable: 0, skipped: 2, errors: 0 });
    expect(pp.calls).toHaveLength(0);
    expect(store.actions.map((a) => a.status)).toEqual(['executing', 'unknown']);
  });

  it('a real capture id still goes through (the guard is the prefix only)', async () => {
    const store = memoryStore();
    const pp = fakePayPal();
    const captureId = pp.seedCaptured('ORDER0000001', '29.00', 'USD');
    store.actions.push({ ...sampleRow({ target_id: captureId }) });
    const r = await executeApprovedAction({ store, paypal: pp.client }, store.actions[0]);
    expect(r.status).not.toBe('not_executable');
    expect(pp.calls.length).toBeGreaterThan(0);
  });
});

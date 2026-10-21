// requestRefund (design v2 §4): facts from PayPal → guardrail RPC → PayPal refund with
// PayPal-Request-Id = action id. The RPC decision itself is scripted here (the SQL is covered by
// supabase/tests/guardrail_refund.sql); what this file pins is the orchestration around it.
import { describe, expect, it } from 'vitest';
import { reconcileAction, requestRefund } from '@/lib/paypal/refund';
import { valueToCents } from '@/lib/paypal/money';
import { BOT, CONVERSATION, fakePayPal, memoryStore } from './fixtures/paypal/fakes';

const ORDER = 'ORDER0000001';

function setup() {
  const store = memoryStore();
  const pp = fakePayPal();
  const captureId = pp.seedCaptured(ORDER, '29.00', 'USD', { captureTime: '2026-10-18T10:00:00Z' });
  const deps = { store, paypal: pp.client };
  const base = { botId: BOT, conversationId: CONVERSATION, captureId, reason: 'double charged', customerKey: 'Buyer@Example.com' };
  return { store, pp, captureId, deps, base };
}

describe('valueToCents', () => {
  it('parses PayPal amount strings with integer math', () => {
    expect(valueToCents('29.00')).toBe(2900);
    expect(valueToCents('9.5')).toBe(950);
    expect(valueToCents('0.07')).toBe(7);
    expect(valueToCents('100')).toBe(10000);
    expect(valueToCents('1e3')).toBeNull();
    expect(valueToCents('-1.00')).toBeNull();
    expect(valueToCents('1.234')).toBeNull();
    expect(valueToCents(29)).toBeNull();
  });
});

describe('requestRefund — facts the RPC receives', () => {
  it('passes what the server read from PayPal, lower-cases the customer key, never a model amount', async () => {
    const { store, deps, base, captureId } = setup();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('executed');
    expect(store.openRefundCalls).toHaveLength(1);
    expect(store.openRefundCalls[0]).toEqual({
      botId: BOT,
      conversationId: CONVERSATION,
      captureId,
      amountCents: 2900,
      currency: 'USD',
      capturedAt: '2026-10-18T10:00:00Z',
      captureHasRefund: false,
      hasDispute: false,
      customerKey: 'buyer@example.com',
      reason: 'double charged',
      captureTotalCents: 2900,
    });
  });

  it('reports a prior refund when PayPal says PARTIALLY_REFUNDED', async () => {
    const { store, pp, deps, base } = setup();
    pp.setCaptureStatus(ORDER, 'PARTIALLY_REFUNDED');
    store.nextDecision = 'pending';
    const r = await requestRefund(deps, { ...base, amountCents: 500 });
    expect(r.status).toBe('pending');
    expect(store.openRefundCalls[0].captureHasRefund).toBe(true);
  });

  it('passes hasDispute=true when a dispute exists and null when the disputes read fails', async () => {
    const { store, pp, deps, base, captureId } = setup();
    pp.addDispute(captureId);
    store.nextDecision = 'pending';
    await requestRefund(deps, base);
    expect(store.openRefundCalls[0].hasDispute).toBe(true);

    const second = setup();
    second.pp.failDisputes();
    second.store.nextDecision = 'pending';
    await requestRefund(second.deps, second.base);
    expect(second.store.openRefundCalls[0].hasDispute).toBeNull();
  });

  it('truncates the reason to 300 characters', async () => {
    const { store, deps, base } = setup();
    await requestRefund(deps, { ...base, reason: 'x'.repeat(1000) });
    expect(store.openRefundCalls[0].reason).toHaveLength(300);
  });
});

describe('requestRefund — refusals before any row is written', () => {
  it('refuses a capture that is not completed', async () => {
    const { store, pp, deps, base } = setup();
    pp.setCaptureStatus(ORDER, 'PENDING');
    expect(await requestRefund(deps, base)).toEqual({ status: 'refused', reason: 'capture_not_completed' });
    expect(store.openRefundCalls).toHaveLength(0);
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('refuses when the capture cannot be read', async () => {
    const { store, pp, deps, base } = setup();
    pp.failCaptureRead();
    expect(await requestRefund(deps, base)).toEqual({ status: 'refused', reason: 'paypal_unreadable' });
    expect(store.openRefundCalls).toHaveLength(0);
  });

  it('refuses more than the capture, zero and fractional cents', async () => {
    const { store, deps, base } = setup();
    expect(await requestRefund(deps, { ...base, amountCents: 2901 })).toEqual({ status: 'refused', reason: 'amount_too_high' });
    expect(await requestRefund(deps, { ...base, amountCents: 0 })).toEqual({ status: 'refused', reason: 'bad_amount' });
    expect(await requestRefund(deps, { ...base, amountCents: 10.5 })).toEqual({ status: 'refused', reason: 'bad_amount' });
    expect(store.openRefundCalls).toHaveLength(0);
  });
});

describe('requestRefund — execution', () => {
  it('auto: one PayPal refund with PayPal-Request-Id = action id and an explicit amount; row executed', async () => {
    const { store, pp, deps, base, captureId } = setup();
    const r = await requestRefund(deps, { ...base, amountCents: 950 });
    expect(r.status).toBe('executed');
    if (r.status !== 'executed') return;

    const calls = pp.refundCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`/v2/payments/captures/${captureId}/refund`);
    expect(calls[0].requestId).toBe(r.action.id);
    expect(calls[0].body).toEqual({ amount: { value: '9.50', currency_code: 'USD' } });

    const row = store.actions[0];
    expect(row.status).toBe('executed');
    expect(row.paypal_ref).toBe(r.refundId);
    expect(row.payload).toEqual({ amount: { value: '9.50', currency_code: 'USD' } });
    expect(r.amountCents).toBe(950);
  });

  it('omitted amount = the whole capture, sent explicitly', async () => {
    const { pp, deps, base } = setup();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('executed');
    expect((pp.refundCalls()[0].body as { amount: { value: string } }).amount.value).toBe('29.00');
  });

  it('pending: a row is written and PayPal is not called', async () => {
    const { store, pp, deps, base } = setup();
    store.nextDecision = 'pending';
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('pending');
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0].status).toBe('pending');
    expect(store.actions[0].origin).toBe('approval');
  });

  it('a second request for the same capture finds the live action and sends nothing', async () => {
    const { store, pp, deps, base } = setup();
    const first = await requestRefund(deps, base);
    const second = await requestRefund(deps, { ...base, reason: 'again' });
    expect(first.status).toBe('executed');
    expect(second.status).toBe('already_open');
    if (second.status !== 'already_open') return;
    expect(second.action.id).toBe(store.actions[0].id);
    expect(pp.refundCalls()).toHaveLength(1);
    expect(store.actions).toHaveLength(1);
  });

  it('two concurrent requests for the same capture execute once', async () => {
    const { store, pp, deps, base } = setup();
    const [a, b] = await Promise.all([requestRefund(deps, base), requestRefund(deps, base)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['already_open', 'executed']);
    expect(pp.refundCalls()).toHaveLength(1);
    expect(store.actions).toHaveLength(1);
  });

  it('PayPal definitely refuses (4xx): row failed with the error name, slot freed, outcome failed', async () => {
    const { store, pp, deps, base } = setup();
    pp.rejectRefund();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('paypal_failed');
    expect(store.actions[0].status).toBe('failed');
    expect(store.actions[0].error).toBe('UNPROCESSABLE_ENTITY');
    expect(pp.refundCalls()).toHaveLength(1);
    // failed frees the slot: a new request opens a NEW action
    const again = await requestRefund(deps, base);
    expect(again.status).toBe('executed');
    expect(store.actions).toHaveLength(2);
  });
});

describe('requestRefund — the sentence the visitor reads (payment line)', () => {
  const lines = (store: ReturnType<typeof memoryStore>) => store.responses.map((r) => r.body);

  it('pending → one waiting line; a repeat request adds nothing', async () => {
    const { store, deps, base } = setup();
    store.nextDecision = 'pending';
    await requestRefund(deps, base);
    expect(lines(store)).toEqual(["Your refund request for $29 is waiting for the store's approval. You'll see the result here."]);
    await requestRefund(deps, base);
    expect(lines(store)).toHaveLength(1);
  });

  it('auto executed → one "sent to PayPal" line', async () => {
    const { store, deps, base } = setup();
    await requestRefund(deps, { ...base, amountCents: 950 });
    expect(lines(store)).toEqual(['Refund of $9.50 sent to PayPal. It usually shows up within a few days.']);
  });

  it('first-attempt refusal → one failed line', async () => {
    const { store, pp, deps, base } = setup();
    pp.rejectRefund();
    await requestRefund(deps, base);
    expect(lines(store)).toEqual(["We couldn't complete the $29 refund through PayPal. The store will follow up here."]);
  });

  it('lost answer → one processing line; a retry that stays unknown adds nothing; the final answer adds one', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, base);
    expect(lines(store)).toEqual(["Your $29 refund is being processed. We'll confirm here once PayPal answers."]);
    pp.failRefund();
    await reconcileAction(deps, { ...store.actions[0] });
    expect(lines(store)).toHaveLength(1);
    await reconcileAction(deps, { ...store.actions[0] });
    expect(lines(store)).toHaveLength(2);
    expect(lines(store)[1]).toBe('Refund of $29 sent to PayPal. It usually shows up within a few days.');
  });

  it('no line is written for a row without a conversation', async () => {
    const { store, deps, base } = setup();
    await requestRefund(deps, { ...base, conversationId: null as unknown as string });
    expect(store.responses).toHaveLength(0);
  });

  // step-5 review: the sentence is the database's once-per-(row, status) write, not a best-effort insert
  it('a sentence the database could not take is written on the next contact (reconcile, repeat request), once', async () => {
    const { store, deps, base } = setup();
    const real = store.announceAction;
    store.announceAction = async () => {
      throw new Error('temporary response insert failure');
    };
    expect((await requestRefund(deps, base)).status).toBe('executed');
    expect(store.responses).toHaveLength(0);
    store.announceAction = real;
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('noop');
    expect((await requestRefund(deps, base)).status).toBe('already_open');
    expect(lines(store)).toEqual(['Refund of $29 sent to PayPal. It usually shows up within a few days.']);
  });

  it('a stale executing snapshot cannot announce "processing" twice', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, base);
    const stale = { ...store.actions[0], status: 'executing' as const, paypal_ref: null };
    pp.failRefund();
    await reconcileAction(deps, stale);
    expect(lines(store).filter((l) => l.includes('being processed'))).toHaveLength(1);
  });

  it('a delayed "processing" cannot land after the completion line', async () => {
    const { store, pp, deps, base } = setup();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.announceAction;
    store.announceAction = async (id, status, body) => {
      if (status === 'unknown') {
        started();
        await hold;
      }
      return real(id, status, body);
    };
    pp.failRefund();
    const first = requestRefund(deps, base);
    await entered; // the first caller settled `unknown` and is about to speak
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('executed');
    release();
    await first;
    expect(store.actions[0].status).toBe('executed');
    // the database refuses a sentence for a status the row has left; the last word is the completion
    expect(lines(store).at(-1)).toBe('Refund of $29 sent to PayPal. It usually shows up within a few days.');
    expect(lines(store).filter((l) => l.includes('being processed'))).toHaveLength(0);
  });
});

describe('requestRefund — a lost answer is never "failed"', () => {
  it('5xx from PayPal (nothing refunded): row unknown, reservation kept, no second action', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(store.actions[0].status).toBe('unknown');
    expect(store.actions[0].error).toBe('INTERNAL_SERVER_ERROR');
    expect(pp.refunds).toHaveLength(0);

    const again = await requestRefund(deps, base);
    expect(again.status).toBe('already_open');
    if (again.status !== 'already_open') return;
    expect(again.action.id).toBe(store.actions[0].id);
    expect(again.action.status).toBe('unknown');
    expect(store.actions).toHaveLength(1);
    expect(pp.refundCalls()).toHaveLength(1);
  });

  it('PayPal refunded but the response was lost: row unknown (not failed), one refund at PayPal', async () => {
    const { store, pp, deps, base } = setup();
    pp.refundThenFail();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(pp.refunds).toHaveLength(1);
    expect(store.actions[0].status).toBe('unknown');
    // the retry key is the same row id → PayPal's idempotency cache would answer it
    expect(pp.refunds[0].requestId).toBe(store.actions[0].id);
  });

  it('connection dropped after PayPal accepted: AbortError on the way back → unknown', async () => {
    const { store, pp, deps, base } = setup();
    const original = pp.client.refundCapture.bind(pp.client);
    pp.client.refundCapture = async (id, args) => {
      await original(id, args);
      const e = new Error('aborted mid-flight');
      e.name = 'AbortError';
      throw e;
    };
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(pp.refunds).toHaveLength(1);
    expect(store.actions[0].status).toBe('unknown');
  });

  it('settle write fails after PayPal refunded: outcome executed, row stays executing (live, same id)', async () => {
    const { store, pp, deps, base } = setup();
    const originalSettle = store.settleAction;
    store.settleAction = async (id, outcome) => {
      if (outcome.status === 'executed') throw new Error('temporary DB outage');
      return originalSettle(id, outcome);
    };
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    expect(store.actions[0].status).toBe('executing');

    store.settleAction = originalSettle;
    const again = await requestRefund(deps, base);
    expect(again.status).toBe('already_open');
    expect(pp.refunds).toHaveLength(1);
  });
});

describe('requestRefund — the refund resource status is the answer, not the HTTP code', () => {
  it('PENDING: row unknown with the refund id kept for reconciliation, reservation held', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('PENDING');
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    if (r.status !== 'unknown') return;
    expect(r.refundId).toBe(pp.refunds[0].id);
    expect(store.actions[0]).toMatchObject({ status: 'unknown', paypal_ref: pp.refunds[0].id, error: null });
    const again = await requestRefund(deps, base);
    expect(again.status).toBe('already_open');
    expect(pp.refundCalls()).toHaveLength(1);
  });

  it.each(['FAILED', 'CANCELLED'])('%s: row failed (definite), slot freed, outcome failed', async (status) => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus(status);
    const r = await requestRefund(deps, base);
    expect(r).toMatchObject({ status: 'failed', reason: 'paypal_failed' });
    expect(store.actions[0]).toMatchObject({ status: 'failed', error: `REFUND_${status}` });
    const again = await requestRefund(deps, base);
    expect(again.status).toBe('executed');
    expect(store.actions).toHaveLength(2);
  });

  it('malformed success body (no id / status): row unknown, never executed', async () => {
    const { store, pp, deps, base } = setup();
    pp.malformedRefund();
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(store.actions[0]).toMatchObject({ status: 'unknown', error: 'REFUND_RESPONSE_UNRECOGNIZED' });
  });

  it('an unrecognised status is treated like a lost answer', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('SOMETHING_NEW');
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(store.actions[0].status).toBe('unknown');
  });
});

describe('requestRefund — cancellation', () => {
  it('already cancelled: refused before any row, nothing read from or sent to PayPal', async () => {
    const { store, pp, deps, base } = setup();
    const r = await requestRefund(deps, { ...base, signal: AbortSignal.abort() });
    expect(r).toEqual({ status: 'refused', reason: 'canceled' });
    expect(store.openRefundCalls).toHaveLength(0);
    expect(pp.calls).toHaveLength(0);
  });

  it('cancelled while reading facts: refused, no row', async () => {
    const { store, pp, deps, base } = setup();
    const controller = new AbortController();
    const original = pp.client.listDisputesForCapture.bind(pp.client);
    pp.client.listDisputesForCapture = async (id, opts) => {
      controller.abort();
      return original(id, opts);
    };
    const r = await requestRefund(deps, { ...base, signal: controller.signal });
    expect(r).toEqual({ status: 'refused', reason: 'canceled' });
    expect(store.openRefundCalls).toHaveLength(0);
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('cancelled between the RPC and the send: row closed as failed(canceled_before_send), no POST', async () => {
    const { store, pp, deps, base } = setup();
    const controller = new AbortController();
    const originalOpen = store.openRefund;
    store.openRefund = async (input) => {
      const r = await originalOpen(input);
      controller.abort();
      return r;
    };
    const r = await requestRefund(deps, { ...base, signal: controller.signal });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toBe('canceled');
    expect(store.actions[0].status).toBe('failed');
    expect(store.actions[0].error).toBe('canceled_before_send');
    expect(pp.refundCalls()).toHaveLength(0);
  });
});

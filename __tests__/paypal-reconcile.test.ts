// Stage 3 (3/6): how executing/unknown rows end, how an approval executes, and the daily sweep.
import { describe, expect, it } from 'vitest';
import { PayPalApiError } from '@/lib/paypal/client';
import { NOT_SENT_CAPTURE_UNREADABLE, executeApprovedAction, reconcileAction, requestRefund } from '@/lib/paypal/refund';
import { sweepStuckActions } from '@/lib/paypal/reconcile';
import { captureIdFromRefundResource, handleWebhookEvent } from '@/lib/paypal/webhook';
import { BOT, BUYER_EMAIL, CONVERSATION, fakePayPal, memoryStore } from './fixtures/paypal/fakes';

/** A PAYMENT.CAPTURE.REFUNDED event as PayPal sends it: the resource is the REFUND, the capture is its `up` link. */
function refundedEvent(id: string, refundId: string, captureId: string, host = 'api.sandbox.paypal.com') {
  return {
    id,
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource_type: 'refund',
    resource: {
      id: refundId,
      status: 'COMPLETED',
      links: [
        { rel: 'self', href: `https://${host}/v2/payments/refunds/${refundId}`, method: 'GET' },
        { rel: 'up', href: `https://${host}/v2/payments/captures/${captureId}`, method: 'GET' },
      ],
    },
  };
}

const ORDER = 'ORDER0000001';
const OWNER = '00000000-0000-4000-8000-000000000001';

function setup() {
  const store = memoryStore();
  const pp = fakePayPal();
  const captureId = pp.seedCaptured(ORDER, '29.00', 'USD', { captureTime: '2026-10-18T10:00:00Z' });
  const deps = { store, paypal: pp.client };
  const base = { botId: BOT, conversationId: CONVERSATION, captureId, reason: 'double charged', customerKey: BUYER_EMAIL };
  return { store, pp, captureId, deps, base };
}

describe('reconcileAction', () => {
  it('unknown with a refund id (PayPal said PENDING, now COMPLETED): executed, nothing re-sent', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('PENDING');
    const first = await requestRefund(deps, base);
    expect(first.status).toBe('unknown');
    const refundId = pp.refunds[0].id;
    pp.setRefundStatus(refundId, 'COMPLETED');

    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('executed');
    expect(store.actions[0]).toMatchObject({ status: 'executed', paypal_ref: refundId });
    expect(pp.refundCalls()).toHaveLength(1);
    expect(pp.refundReads()).toHaveLength(1);
  });

  it('refund still PENDING at PayPal: still_pending, row untouched', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('PENDING');
    await requestRefund(deps, base);
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('still_pending');
    expect(store.actions[0].status).toBe('unknown');
  });

  it('refund FAILED at PayPal after PENDING: row failed, slot freed', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('PENDING');
    await requestRefund(deps, base);
    pp.setRefundStatus(pp.refunds[0].id, 'FAILED');
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('failed');
    expect(store.actions[0]).toMatchObject({ status: 'failed', error: 'REFUND_FAILED' });
    expect((await requestRefund(deps, base)).status).toBe('executed');
  });

  it('unknown without a refund id (answer lost): the same PayPal-Request-Id is re-sent; PayPal answers from its cache', async () => {
    const { store, pp, deps, base } = setup();
    pp.refundThenFail(); // refunded, response lost
    const first = await requestRefund(deps, base);
    expect(first.status).toBe('unknown');
    expect(store.actions[0].paypal_ref).toBeNull();

    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1); // still one refund at PayPal
    expect(pp.refundCalls()).toHaveLength(2);
    expect(pp.refundCalls()[1].requestId).toBe(store.actions[0].id);
    expect(store.actions[0]).toMatchObject({ status: 'executed', paypal_ref: pp.refunds[0].id });
  });

  it('unknown whose POST never reached PayPal: the retry performs it exactly once', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund(); // 500 before anything happened
    await requestRefund(deps, base);
    expect(pp.refunds).toHaveLength(0);
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    expect(pp.refunds[0].requestId).toBe(store.actions[0].id);
  });

  it('executing row (crash between POST and settle): reconciled the same way', async () => {
    const { store, pp, deps, base } = setup();
    const originalSettle = store.settleAction;
    store.settleAction = async (id, outcome, from) => {
      if (outcome.status === 'executed') throw new Error('db outage');
      return originalSettle(id, outcome, from);
    };
    await requestRefund(deps, base);
    expect(store.actions[0].status).toBe('executing');
    store.settleAction = originalSettle;
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
  });

  it('PayPal unreachable during a GET: unreachable, row untouched', async () => {
    const { store, pp, deps, base } = setup();
    pp.nextRefundStatus('PENDING');
    await requestRefund(deps, base);
    const original = pp.client.getRefund.bind(pp.client);
    pp.client.getRefund = async () => {
      throw new Error('fetch failed');
    };
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('unreachable');
    expect(store.actions[0].status).toBe('unknown');
    pp.client.getRefund = original;
  });

  it('a row that is not stuck is a noop', async () => {
    const { store, deps, base } = setup();
    await requestRefund(deps, base);
    expect(store.actions[0].status).toBe('executed');
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('noop');
  });

  it('re-send is gated by the capture pre-check: unreadable capture → nothing sent', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, base);
    pp.failCaptureRead();
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('unreachable');
    expect(pp.refundCalls()).toHaveLength(1);
    expect(store.actions[0].status).toBe('unknown');
    pp.failCaptureRead(false);
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('executed');
  });

  it('a possibly-sent row on a capture that now looks unrefundable is NOT closed locally: PayPal decides', async () => {
    const { store, pp, deps, base } = setup();
    pp.refundThenFail(); // sent, answer lost → may have run
    await requestRefund(deps, base);
    pp.setCaptureStatus(ORDER, 'PENDING'); // whatever the capture says now, our POST may have run
    const r = await reconcileAction(deps, store.actions[0]);
    // the idempotent re-send is answered from PayPal's cache: the refund did run
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
  });
});

describe('reconcileAction — a retry refusal is not an answer about the original', () => {
  it('lost answer, then the replay gets 403: row stays unknown, one refund at PayPal', async () => {
    const { store, pp, deps, base } = setup();
    pp.refundThenFail();
    await requestRefund(deps, { ...base, amountCents: 500 });
    expect(store.actions[0]).toMatchObject({ status: 'unknown', send_attempts: 1 });
    expect(store.actions[0].sent_at).not.toBeNull();
    pp.client.refundCapture = async () => {
      throw new PayPalApiError({ status: 403, name: 'NOT_AUTHORIZED', message: 'Refund permission revoked' });
    };
    const r = await reconcileAction(deps, { ...store.actions[0] });
    expect(r.status).toBe('unknown');
    expect(store.actions[0]).toMatchObject({ status: 'unknown', send_attempts: 2 });
    expect(pp.refunds).toHaveLength(1);
  });

  it('a 4xx on the FIRST attempt is the answer: failed', async () => {
    const { store, pp, deps, base } = setup();
    pp.rejectRefund();
    expect((await requestRefund(deps, base)).status).toBe('failed');
    expect(store.actions[0]).toMatchObject({ status: 'failed', send_attempts: 1 });
  });

  it('markSent failing means nothing is sent', async () => {
    const { store, pp, deps, base } = setup();
    store.markSent = async () => {
      throw new Error('db outage');
    };
    const r = await requestRefund(deps, base);
    expect(r.status).toBe('unknown');
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0]).toMatchObject({ status: 'executing', sent_at: null });
  });

  it('a never-sent marker cannot survive a POST: a completed refund with a failed settle is never closed locally', async () => {
    const { store, pp, deps, base } = setup();
    store.nextDecision = 'pending';
    await requestRefund(deps, { ...base, amountCents: 500 });
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    pp.failCaptureRead();
    await executeApprovedAction(deps, decided.action);
    expect(store.actions[0]).toMatchObject({ status: 'unknown', error: NOT_SENT_CAPTURE_UNREADABLE, sent_at: null });

    // retry: capture readable, PayPal refunds, but the executed settle write fails
    pp.failCaptureRead(false);
    const originalSettle = store.settleAction;
    store.settleAction = async (id, outcome, from, opts) => {
      if (outcome.status === 'executed') throw new Error('DB unavailable after PayPal succeeded');
      return originalSettle(id, outcome, from, opts);
    };
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    // the stale informational marker is still there, but sent_at says "may have been sent"
    expect(store.actions[0]).toMatchObject({ status: 'unknown', error: NOT_SENT_CAPTURE_UNREADABLE });
    expect(store.actions[0].sent_at).not.toBeNull();
    store.settleAction = originalSettle;

    // capture now looks unrefundable: NOT closed locally; the idempotent re-send is answered from cache
    pp.setCaptureStatus(ORDER, 'PENDING');
    const r = await reconcileAction(deps, { ...store.actions[0] });
    expect(r.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    expect(store.actions[0].status).toBe('executed');
  });

  it('a stale snapshot of a never-sent row cannot close it once another caller has sent', async () => {
    const { store, pp, deps, base } = setup();
    store.nextDecision = 'pending';
    await requestRefund(deps, { ...base, amountCents: 500 });
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    pp.failCaptureRead();
    await executeApprovedAction(deps, decided.action);
    const stale = { ...store.actions[0] }; // sent_at null in this snapshot
    pp.failCaptureRead(false);
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('executed'); // somebody sends it
    pp.setCaptureStatus(ORDER, 'PENDING');
    const r = await reconcileAction(deps, stale); // stale caller thinks it was never sent
    expect(r.status).not.toBe('failed');
    expect(store.actions[0].status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
  });
});

describe('reconcileAction — the send gate', () => {
  async function neverSent() {
    const s = setup();
    s.store.nextDecision = 'pending';
    await requestRefund(s.deps, { ...s.base, amountCents: 500 });
    const decided = await s.store.decideAction({ actionId: s.store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    s.pp.failCaptureRead();
    await executeApprovedAction(s.deps, decided.action);
    s.pp.failCaptureRead(false);
    return s;
  }

  it('a stale snapshot cannot send after the row was closed failed', async () => {
    const { store, pp, deps } = await neverSent();
    const stale = { ...store.actions[0] };
    const original = pp.client.refundCapture.bind(pp.client);
    pp.client.refundCapture = async () => {
      throw new PayPalApiError({ status: 403, name: 'NOT_AUTHORIZED', message: 'Refund permission unavailable' });
    };
    expect((await reconcileAction(deps, { ...stale })).status).toBe('failed'); // first attempt, definite
    expect(store.actions[0]).toMatchObject({ status: 'failed', send_attempts: 1 });
    pp.client.refundCapture = original;

    const late = await reconcileAction(deps, stale);
    expect(late.status).toBe('failed'); // read back, nothing sent
    expect(pp.refunds).toHaveLength(0);
    expect(pp.refundCalls()).toHaveLength(0); // the restored client was never asked
    expect(store.actions[0].send_attempts).toBe(1);
  });

  it('a first-attempt rejection cannot release a concurrently accepted retry', async () => {
    const { store, pp, deps } = await neverSent();
    const gate = () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    };
    const firstStarted = gate(), secondStarted = gate(), releaseFirst = gate(), releaseSecond = gate();
    const original = pp.client.refundCapture.bind(pp.client);
    let calls = 0;
    pp.client.refundCapture = async (id, args) => {
      if (++calls === 1) {
        firstStarted.release();
        await releaseFirst.promise;
        throw new PayPalApiError({ status: 403, name: 'NOT_AUTHORIZED', message: 'First request denied' });
      }
      secondStarted.release();
      await releaseSecond.promise;
      return original(id, args);
    };
    const first = reconcileAction(deps, { ...store.actions[0] });
    await firstStarted.promise;
    const second = reconcileAction(deps, { ...store.actions[0] });
    await secondStarted.promise;
    expect(store.actions[0].send_attempts).toBe(2);

    releaseFirst.release();
    const firstOutcome = await first;
    expect(firstOutcome.status).toBe('unknown'); // its close was refused: a second attempt had started
    expect(store.actions[0].status).toBe('unknown');

    releaseSecond.release();
    const secondOutcome = await second;
    expect(secondOutcome.status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    expect(store.actions[0].status).toBe('executed');
  });

  it('never-sent + capture DECLINED + the failed write errors: nothing is sent, row untouched', async () => {
    const { store, pp, deps } = await neverSent();
    pp.setCaptureStatus(ORDER, 'DECLINED');
    const originalSettle = store.settleAction;
    store.settleAction = async (id, outcome, from, opts) => {
      if (outcome.status === 'failed') throw new Error('DB unavailable');
      return originalSettle(id, outcome, from, opts);
    };
    const r = await reconcileAction(deps, { ...store.actions[0] });
    expect(r.status).toBe('unreachable');
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0]).toMatchObject({ status: 'unknown', sent_at: null, send_attempts: 0 });
    store.settleAction = originalSettle;
    // the next sweep closes it properly
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('failed');
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('never-sent + capture DECLINED + the guard refuses because the row moved: no send without persisted sent_at', async () => {
    const { store, pp, deps } = await neverSent();
    pp.setCaptureStatus(ORDER, 'DECLINED');
    const stale = { ...store.actions[0] };
    store.actions[0].status = 'rejected'; // an operator rejected it meanwhile; sent_at still null
    const r = await reconcileAction(deps, stale);
    expect(r.status).not.toBe('failed');
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0].status).toBe('rejected');
  });

  it('when the first-attempt failure lands first, a later attempt is refused at the gate', async () => {
    const { store, pp, deps } = await neverSent();
    pp.rejectRefund();
    expect((await reconcileAction(deps, { ...store.actions[0] })).status).toBe('failed');
    const late = await reconcileAction(deps, { ...store.actions[0], status: 'unknown' });
    expect(late.status).toBe('failed');
    expect(pp.refundCalls()).toHaveLength(1);
    expect(store.actions[0].status).toBe('failed');
  });
});

describe('reconcileAction — concurrent replays', () => {
  it('409 PREVIOUS_REQUEST_IN_PROGRESS keeps the reservation; the request that finishes settles executed', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, { ...base, amountCents: 500 });
    const snapshot = { ...store.actions[0] };

    // first replay: PayPal performs it but answers late; second replay meanwhile gets 409
    const original = pp.client.refundCapture.bind(pp.client);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    pp.client.refundCapture = async (id, args) => {
      if (++calls === 1) {
        await gate;
        return original(id, args);
      }
      pp.conflictRefund();
      return original(id, args);
    };
    const first = reconcileAction(deps, { ...snapshot });
    const second = await reconcileAction(deps, { ...snapshot });
    expect(second.status).toBe('unknown'); // not failed
    expect(store.actions[0].status).toBe('unknown');
    release();
    const done = await first;
    expect(done.status).toBe('executed');
    expect(store.actions[0].status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
    // a later request for the same capture finds the live executed action
    expect((await requestRefund(deps, base)).status).toBe('already_open');
  });

  it('when the success settles first, a late 409 caller reads the row back and reports executed', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, base);
    const snapshot = { ...store.actions[0] };
    const first = await reconcileAction(deps, { ...snapshot });
    expect(first.status).toBe('executed');
    pp.conflictRefund();
    const late = await reconcileAction(deps, { ...snapshot, status: 'unknown' });
    expect(late.status).toBe('executed');
    expect(store.actions[0].status).toBe('executed');
    expect(pp.refunds).toHaveLength(1);
  });
});

describe('executeApprovedAction', () => {
  async function pendingAction(opts: { amount?: number } = {}) {
    const s = setup();
    s.store.nextDecision = 'pending';
    const r = await requestRefund(s.deps, { ...s.base, amountCents: opts.amount });
    expect(r.status).toBe('pending');
    return s;
  }

  it('approve → executing → one PayPal refund keyed by the action id → executed', async () => {
    const { store, pp, deps } = await pendingAction({ amount: 500 });
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    expect(decided).toMatchObject({ updated: true, action: { status: 'executing', origin: 'approval', decided_by: OWNER } });

    const r = await executeApprovedAction(deps, decided.action);
    expect(r.status).toBe('executed');
    expect(pp.refundCalls()).toHaveLength(1);
    expect(pp.refundCalls()[0].requestId).toBe(store.actions[0].id);
    expect(pp.refundCalls()[0].body).toEqual({ amount: { value: '5.00', currency_code: 'USD' } });
    expect(store.actions[0].status).toBe('executed');
  });

  it('a second approve is a no-op and executing a pending/rejected row is refused', async () => {
    const { store, pp, deps } = await pendingAction();
    const id = store.actions[0].id;
    expect(await executeApprovedAction(deps, store.actions[0])).toMatchObject({ status: 'not_executable' });
    await store.decideAction({ actionId: id, botId: BOT, decision: 'approve', userId: OWNER });
    const again = await store.decideAction({ actionId: id, botId: BOT, decision: 'approve', userId: OWNER });
    expect(again.updated).toBe(false);
    const rejected = await store.decideAction({ actionId: id, botId: BOT, decision: 'reject', userId: OWNER });
    expect(rejected.updated).toBe(false);
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('reject frees the slot without touching PayPal', async () => {
    const { store, pp, deps, base } = await pendingAction();
    const r = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'reject', userId: OWNER });
    expect(r).toMatchObject({ updated: true, action: { status: 'rejected' } });
    expect(await executeApprovedAction(deps, r.action)).toMatchObject({ status: 'not_executable' });
    store.nextDecision = 'auto';
    expect((await requestRefund(deps, base)).status).toBe('executed');
    expect(pp.refundCalls()).toHaveLength(1);
  });

  it('capture no longer refundable when the operator approves: row failed, nothing sent', async () => {
    const { store, pp, deps } = await pendingAction();
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    pp.setCaptureStatus(ORDER, 'DECLINED');
    const r = await executeApprovedAction(deps, decided.action);
    expect(r.status).toBe('capture_not_refundable');
    expect(store.actions[0]).toMatchObject({ status: 'failed', error: 'CAPTURE_NOT_REFUNDABLE' });
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('capture cannot be re-read: not sent, row marked unknown + never-sent; the reaper repeats the check before sending', async () => {
    const { store, pp, deps } = await pendingAction();
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    pp.failCaptureRead();
    const r = await executeApprovedAction(deps, decided.action);
    expect(r.status).toBe('unknown');
    expect(store.actions[0]).toMatchObject({ status: 'unknown', error: NOT_SENT_CAPTURE_UNREADABLE, paypal_ref: null });
    expect(pp.refundCalls()).toHaveLength(0);

    // capture still unreadable: the reaper sends nothing either
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('unreachable');
    expect(pp.refundCalls()).toHaveLength(0);

    // capture readable but no longer refundable: never sent → closed as failed, nothing sent
    pp.failCaptureRead(false);
    pp.setCaptureStatus(ORDER, 'DECLINED');
    expect((await reconcileAction(deps, store.actions[0])).status).toBe('failed');
    expect(store.actions[0]).toMatchObject({ status: 'failed', error: 'CAPTURE_NOT_REFUNDABLE' });
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('capture unreadable at approval, readable later: the reaper sends it once', async () => {
    const { store, pp, deps } = await pendingAction({ amount: 500 });
    const decided = await store.decideAction({ actionId: store.actions[0].id, botId: BOT, decision: 'approve', userId: OWNER });
    pp.failCaptureRead();
    await executeApprovedAction(deps, decided.action);
    pp.failCaptureRead(false);
    const r = await reconcileAction(deps, store.actions[0]);
    expect(r.status).toBe('executed');
    expect(pp.refundCalls()).toHaveLength(1);
    expect(pp.refundCalls()[0].requestId).toBe(store.actions[0].id);
    expect(store.actions[0].status).toBe('executed');
  });
});

describe('sweepStuckActions', () => {
  it('expires old pending rows, reconciles stuck rows older than the threshold, skips young and foreign ones', async () => {
    const { store, pp, deps, base, captureId } = setup();
    // 1. a lost answer, old enough
    pp.refundThenFail();
    await requestRefund(deps, base);
    store.actions[0].updated_at = new Date(Date.now() - 60 * 60_000).toISOString();
    // 2. a pending approval from 8 days ago
    store.nextDecision = 'pending';
    const other = pp.seedCaptured('ORDER0000002', '10.00');
    await requestRefund(deps, { ...base, captureId: other, customerKey: 'x@y.z' });
    store.actions[1].created_at = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    // 3. a young unknown row (in flight elsewhere): untouched
    store.nextDecision = 'auto';
    const third = pp.seedCaptured('ORDER0000003', '5.00');
    pp.failRefund();
    await requestRefund(deps, { ...base, captureId: third, customerKey: 'a@b.c' });
    expect(store.actions[2].status).toBe('unknown');
    // 4. a stuck row of a bot without PayPal
    store.actions.push({ ...store.actions[0], id: 'other-bot-action', bot_id: 'bot-without-paypal', target_id: 'CAPX', status: 'unknown', paypal_ref: null });

    const result = await sweepStuckActions({
      store,
      paypalFor: async (botId) => (botId === BOT ? pp.client : null),
    });
    // announced: 1 = the copied foreign-bot row's `unknown` had never been spoken; the sweep writes it
    expect(result).toEqual({ expired: 1, announced: 1, scanned: 2, executed: 1, failed: 0, stillPending: 0, unreachable: 0, skipped: 1, errors: 0, deferred: 0 });
    expect(store.actions[0]).toMatchObject({ status: 'executed', target_id: captureId, reconcile_attempts: 1 });
    expect(store.actions[1].status).toBe('expired');
    expect(store.actions[2]).toMatchObject({ status: 'unknown', reconcile_attempts: 0 });
    expect(store.actions[3]).toMatchObject({ status: 'unknown', reconcile_attempts: 1 }); // skipped rows rotate too
    expect(pp.refunds).toHaveLength(1);
  });

  it('writes the sentences an earlier failure left out of conversations, oldest first, and never twice', async () => {
    const { store, pp, deps, base } = setup();
    const real = store.announceAction;
    store.announceAction = async () => {
      throw new Error('db hiccup');
    };
    await requestRefund(deps, base); // executed, visitor told nothing
    store.nextDecision = 'pending';
    const other = pp.seedCaptured('ORDER0000002', '10.00');
    await requestRefund(deps, { ...base, captureId: other, customerKey: 'x@y.z' }); // pending, visitor told nothing
    store.announceAction = real;
    expect(store.responses).toHaveLength(0);

    const sweepDeps = { store, paypalFor: async () => pp.client };
    const result = await sweepStuckActions(sweepDeps);
    expect(result).toMatchObject({ announced: 2, scanned: 0, errors: 0 });
    expect(store.responses.map((r) => r.body)).toEqual([
      'Refund of $29 sent to PayPal. It usually shows up within a few days.',
      "Your refund request for $10 is waiting for the store's approval. You'll see the result here.",
    ]);
    expect((await sweepStuckActions(sweepDeps)).announced).toBe(0);
    expect(store.responses).toHaveLength(2);
  });

  it('a row behind 50 still-pending stragglers is reached on the next sweep (fair rotation)', async () => {
    const { store, pp, deps, base } = setup();
    for (let i = 0; i < 51; i++) {
      const captureId = pp.seedCaptured(`ORDER${String(i + 2).padStart(7, '0')}`);
      pp.nextRefundStatus('PENDING');
      await requestRefund(deps, { ...base, captureId, customerKey: `u${i}@x.y` });
      store.actions[i].updated_at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    }
    pp.setRefundStatus(pp.refunds[50].id, 'COMPLETED');
    const sweepDeps = { store, paypalFor: async () => pp.client, now: () => new Date('2026-10-21T00:00:00Z') };

    const first = await sweepStuckActions(sweepDeps);
    expect(first.scanned).toBe(50);
    expect(first.stillPending).toBe(50);
    expect(store.actions[50].status).toBe('unknown');

    const second = await sweepStuckActions(sweepDeps);
    // never-attempted rows go first: the 51st is reached now, whatever the 50 stragglers do
    expect(second.executed).toBe(1);
    expect(store.actions[50]).toMatchObject({ status: 'executed', reconcile_attempts: 1 });
    expect(store.actions[0].reconcile_attempts).toBeGreaterThanOrEqual(1);
  });

  it('a disconnected bot cannot block other bots: its rows are stamped and skipped', async () => {
    const { store, pp, deps, base } = setup();
    for (let i = 0; i < 50; i++) {
      store.actions.push({
        ...(await (async () => {
          const captureId = pp.seedCaptured(`FOREIGN${String(i).padStart(4, '0')}`);
          pp.failRefund();
          await requestRefund(deps, { ...base, captureId, customerKey: `f${i}@x.y` });
          const row = store.actions.pop()!;
          return { ...row, bot_id: 'bot-without-paypal', updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() };
        })()),
      });
    }
    const mine = pp.seedCaptured('ORDER0000099');
    pp.refundThenFail();
    await requestRefund(deps, { ...base, captureId: mine, customerKey: 'me@x.y' });
    store.actions[50].updated_at = '2026-10-02T00:00:00.000Z';

    const sweepDeps = { store, paypalFor: async (botId: string) => (botId === BOT ? pp.client : null), now: () => new Date('2026-10-21T00:00:00Z') };
    const first = await sweepStuckActions(sweepDeps);
    expect(first.skipped).toBe(50);
    const second = await sweepStuckActions(sweepDeps);
    expect(second.executed).toBe(1);
    expect(store.actions[50].status).toBe('executed');
  });

  it('stops at the time budget and reports the rest as deferred', async () => {
    const { store, pp, deps, base } = setup();
    for (let i = 0; i < 3; i++) {
      const captureId = pp.seedCaptured(`ORDER${String(i + 2).padStart(7, '0')}`);
      pp.refundThenFail();
      await requestRefund(deps, { ...base, captureId, customerKey: `b${i}@x.y` });
      store.actions[i].updated_at = '2026-10-01T00:00:00.000Z';
    }
    const result = await sweepStuckActions(
      { store, paypalFor: async () => pp.client, now: () => new Date('2026-10-21T00:00:00Z') },
      { budgetMs: -1 },
    );
    expect(result.scanned).toBe(0);
    expect(result.deferred).toBe(3);
  });

  it('keeps going when one row throws', async () => {
    const { store, pp, deps, base } = setup();
    pp.failRefund();
    await requestRefund(deps, base);
    store.actions[0].updated_at = new Date(Date.now() - 60 * 60_000).toISOString();
    const result = await sweepStuckActions({
      store,
      paypalFor: async () => {
        throw new Error('bot lookup failed');
      },
    });
    expect(result.errors).toBe(1);
    expect(result.scanned).toBe(1);
  });
});

describe('webhook PAYMENT.CAPTURE.REFUNDED', () => {
  it('finds the capture through the refund resource\'s up link and reconciles the stuck action', async () => {
    const { store, pp, deps, base, captureId } = setup();
    pp.refundThenFail(); // refunded, answer lost: our row has no refund id
    await requestRefund(deps, base);
    expect(store.actions[0]).toMatchObject({ status: 'unknown', paypal_ref: null });
    const refundId = pp.refunds[0].id;

    const outcome = await handleWebhookEvent(deps, BOT, refundedEvent('WH-R', refundId, captureId));
    expect(outcome).toEqual({ kind: 'reconciled', outcome: 'executed' });
    expect(store.actions[0]).toMatchObject({ status: 'executed', paypal_ref: refundId });
    expect(pp.refunds).toHaveLength(1);

    // nothing stuck any more → recorded; unknown capture → recorded
    expect(await handleWebhookEvent(deps, BOT, refundedEvent('WH-R2', refundId, captureId))).toEqual({ kind: 'recorded' });
    expect(await handleWebhookEvent(deps, BOT, refundedEvent('WH-R3', 'REF-x', 'CAP-unknown'))).toEqual({ kind: 'recorded' });
  });

  it('with a known refund id the webhook leads to a GET, not a re-POST', async () => {
    const { store, pp, deps, base, captureId } = setup();
    pp.nextRefundStatus('PENDING');
    await requestRefund(deps, base);
    const refundId = pp.refunds[0].id;
    pp.setRefundStatus(refundId, 'COMPLETED');
    expect(await handleWebhookEvent(deps, BOT, refundedEvent('WH-P', refundId, captureId))).toEqual({ kind: 'reconciled', outcome: 'executed' });
    expect(store.actions[0]).toMatchObject({ status: 'executed', paypal_ref: refundId });
    expect(pp.refundCalls()).toHaveLength(1);
    expect(pp.refundReads()).toHaveLength(1);
  });

  it('captureIdFromRefundResource accepts only PayPal API hosts and the captures path', () => {
    expect(captureIdFromRefundResource(refundedEvent('x', 'R', 'CAP1').resource)).toBe('CAP1');
    expect(captureIdFromRefundResource(refundedEvent('x', 'R', 'CAP1', 'api-m.paypal.com').resource)).toBe('CAP1');
    expect(captureIdFromRefundResource(refundedEvent('x', 'R', 'CAP1', 'evil.example.com').resource)).toBeNull();
    expect(captureIdFromRefundResource(refundedEvent('x', 'R', 'CAP1', 'api.paypal.com.evil.test').resource)).toBeNull();
    expect(captureIdFromRefundResource({ id: 'R', links: [{ rel: 'up', href: 'http://api.paypal.com/v2/payments/captures/CAP1' }] })).toBeNull();
    expect(captureIdFromRefundResource({ id: 'R', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/refunds/CAP1' }] })).toBeNull();
    expect(captureIdFromRefundResource({ id: 'CAPX' })).toBeNull();
    expect(captureIdFromRefundResource(null)).toBeNull();
  });
});

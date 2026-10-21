// Stage 3 task 4: the operator's approve / reject route and the inbox detail's payment actions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requestRefund } from '@/lib/paypal/refund';
import { BOT, BUYER_EMAIL, CONVERSATION, fakePayPal, memoryStore, type MemoryStore } from './fixtures/paypal/fakes';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_CONVERSATION = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  auth: vi.fn<() => Promise<unknown>>(async () => ({ ok: true, userId: '00000000-0000-4000-8000-000000000001', botIds: ['11111111-1111-4111-8111-111111111111'], role: 'owner' })),
  owner: vi.fn<(id: string) => Promise<unknown>>(async (id) => ({ id, bot_id: '11111111-1111-4111-8111-111111111111', source: 'web', external_user_id: 'v1' })),
  store: null as MemoryStore | null,
  paypalBot: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@/lib/auth/ownership', () => ({ resolveAccessibleBots: h.auth }));
vi.mock('@/lib/bot/conversations', () => ({
  getConversationOwner: h.owner,
  getTimeline: vi.fn(async () => []),
  getConversationOrigin: vi.fn(async () => null),
  getMessageContexts: vi.fn(async () => ({})),
  markConversationRead: vi.fn(async () => {}),
}));
vi.mock('@/lib/paypal/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/paypal/store')>();
  return { ...actual, supabasePaymentsStore: () => h.store };
});
vi.mock('@/lib/paypal/bot', () => ({ resolvePayPalBot: h.paypalBot }));
vi.mock('@/lib/widget/shots', () => ({ signShotsForMessages: vi.fn(async () => ({})) }));
vi.mock('@/lib/bot/channel-registration', () => ({ getChannelDeskUrl: vi.fn(async () => null) }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'open' }, error: null }) }) }) }),
  }),
}));

import { POST } from '@/app/api/inbox/[conversationId]/payment-actions/[actionId]/route';
import { GET } from '@/app/api/inbox/[conversationId]/route';
import { interpretDecisionResponse, type PaymentActionView } from '@/lib/paypal/action-view';

const ORDER = 'ORDER0000001';

async function setupPending(amount = 500) {
  const store = memoryStore();
  const pp = fakePayPal();
  const captureId = pp.seedCaptured(ORDER, '29.00');
  store.nextDecision = 'pending';
  const r = await requestRefund({ store, paypal: pp.client }, { botId: BOT, conversationId: CONVERSATION, captureId, amountCents: amount, reason: 'too slow', customerKey: BUYER_EMAIL });
  expect(r.status).toBe('pending');
  h.store = store;
  h.paypalBot.mockResolvedValue({ ok: true, bot: { id: BOT, client: pp.client } });
  return { store, pp, actionId: store.actions[0].id };
}

function decide(conversationId: string, actionId: string, body: unknown) {
  const req = new NextRequest(`http://localhost/api/inbox/${conversationId}/payment-actions/${actionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ conversationId, actionId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ ok: true, userId: OWNER, botIds: [BOT], role: 'owner' });
  h.owner.mockImplementation(async (id) => ({ id, bot_id: BOT, source: 'web', external_user_id: 'v1' }));
});

describe('POST /api/inbox/[conversationId]/payment-actions/[actionId]', () => {
  it('approve: one PayPal refund keyed by the row id, row executed, badge cleared', async () => {
    const { store, pp, actionId } = await setupPending();
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision).toBe('approve');
    expect(json.outcome).toMatchObject({ status: 'executed' });
    expect(json.action).toMatchObject({ id: actionId, status: 'executed', decidable: false, amount: '$5' });
    expect(json.escalationCleared).toBe(true);
    expect(pp.refundCalls()).toHaveLength(1);
    expect(pp.refundCalls()[0].requestId).toBe(actionId);
    expect(store.actions[0]).toMatchObject({ status: 'executed', decided_by: OWNER });
    expect(store.attention[CONVERSATION]).toMatchObject({ escalated: false });
    // the visitor read "waiting" when the row opened, and now "approved and sent" — both server-fixed lines
    expect(store.responses.map((r) => r.body)).toEqual([
      "Your refund request for $5 is waiting for the store's approval. You'll see the result here.",
      'Your refund of $5 was approved and sent to PayPal. It usually shows up within a few days.',
    ]);
  });

  it('a pending refund raised the badge when it was opened (RPC), before any mail', async () => {
    const { store } = await setupPending();
    expect(store.attention[CONVERSATION]).toMatchObject({ escalated: true });
  });

  it('two pending refunds: deciding one leaves the badge up; deciding the last lowers it', async () => {
    const { store, pp, actionId } = await setupPending();
    const second = pp.seedCaptured('ORDER0000002', '10.00');
    const r = await requestRefund({ store, paypal: pp.client }, { botId: BOT, conversationId: CONVERSATION, captureId: second, amountCents: 300, reason: 'also', customerKey: 'z@z.z' });
    expect(r.status).toBe('pending');
    const secondId = store.actions[1].id;

    const first = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect((await first.json()).escalationCleared).toBe(false);
    expect(store.attention[CONVERSATION].escalated).toBe(true);

    const last = await decide(CONVERSATION, secondId, { decision: 'approve' });
    expect((await last.json()).escalationCleared).toBe(true);
    expect(store.attention[CONVERSATION].escalated).toBe(false);
  });

  it('an older pending refund beyond any display window still keeps the badge up', async () => {
    const { store, pp, actionId } = await setupPending();
    // 60 newer pending rows for other captures: the decided row and the old one are not in the newest 50
    for (let i = 0; i < 60; i++) {
      const cap = pp.seedCaptured(`ORDER${String(i + 10).padStart(7, '0')}`, '1.00');
      await requestRefund({ store, paypal: pp.client }, { botId: BOT, conversationId: CONVERSATION, captureId: cap, amountCents: 100, reason: 'n', customerKey: `u${i}@x.y` });
    }
    expect(store.actions.filter((a) => a.status === 'pending')).toHaveLength(61);
    const res = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect((await res.json()).escalationCleared).toBe(false);
    expect(store.attention[CONVERSATION].escalated).toBe(true);
  });

  it('a visitor who asked for a human keeps the badge', async () => {
    const { store, actionId } = await setupPending();
    store.attention[CONVERSATION].handoff = true;
    const res = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect((await res.json()).escalationCleared).toBe(false);
    expect(store.attention[CONVERSATION].escalated).toBe(true);
  });

  it('a failing clear leaves the badge up and still answers the decision', async () => {
    const { store, actionId } = await setupPending();
    store.clearRefundAttention = async () => {
      throw new Error('db down');
    };
    const res = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect(res.status).toBe(200);
    expect((await res.json()).escalationCleared).toBe(false);
  });

  it('reject: row rejected, nothing sent, badge cleared', async () => {
    const { store, pp, actionId } = await setupPending();
    const res = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: 'reject', outcome: { status: 'rejected' }, action: { status: 'rejected' } });
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0].status).toBe('rejected');
    expect(store.attention[CONVERSATION].escalated).toBe(false);
    expect(store.responses.map((r) => r.body)).toEqual([
      "Your refund request for $5 is waiting for the store's approval. You'll see the result here.",
      "The store reviewed your refund request for $5 and didn't approve it.",
    ]);
  });

  it('a second decision (double click, two operators) answers 409 with the row as it is', async () => {
    const { pp, actionId } = await setupPending();
    expect((await decide(CONVERSATION, actionId, { decision: 'approve' })).status).toBe(200);
    const again = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ action: { status: 'executed' } });
    const reject = await decide(CONVERSATION, actionId, { decision: 'reject' });
    expect(reject.status).toBe(409);
    expect(pp.refundCalls()).toHaveLength(1);
  });

  it('PayPal refuses the approved refund: 200 with failed outcome, row failed', async () => {
    const { store, pp, actionId } = await setupPending();
    pp.rejectRefund();
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: { status: 'failed' }, action: { status: 'failed' } });
    expect(store.actions[0].status).toBe('failed');
  });

  it('capture no longer refundable at approval time: nothing sent, row failed', async () => {
    const { pp, actionId } = await setupPending();
    pp.setCaptureStatus(ORDER, 'DECLINED');
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(await res.json()).toMatchObject({ outcome: { status: 'capture_not_refundable' }, action: { status: 'failed', error: 'CAPTURE_NOT_REFUNDABLE' } });
    expect(pp.refundCalls()).toHaveLength(0);
  });

  it('bot without PayPal: decision recorded, nothing sent, 502 carries the saved row and an explanation', async () => {
    const { store, pp, actionId } = await setupPending();
    h.paypalBot.mockResolvedValue({ ok: false, reason: 'not_connected' });
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toMatchObject({ outcome: { status: 'unknown', reason: 'paypal_not_connected' }, action: { status: 'executing', decidable: false } });
    expect(typeof json.error).toBe('string');
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.actions[0].status).toBe('executing');

    // and the inbox handler applies that row and shows a notice, offering no second decision
    const effect = interpretDecisionResponse(502, json);
    expect(effect.action).toMatchObject({ id: actionId, status: 'executing', decidable: false });
    expect(effect.cardError).toBeNull();
    expect(effect.notice).toContain('PayPal');
  });

  it('refuses: not signed in (401), not this bot (403), unknown conversation (404), another conversation\'s row (404), bad body (400)', async () => {
    const { store, pp, actionId } = await setupPending();
    h.auth.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await decide(CONVERSATION, actionId, { decision: 'approve' })).status).toBe(401);
    h.auth.mockResolvedValueOnce({ ok: false, status: 403, error: 'no' });
    expect((await decide(CONVERSATION, actionId, { decision: 'approve' })).status).toBe(403);
    h.owner.mockResolvedValueOnce(null);
    expect((await decide(CONVERSATION, actionId, { decision: 'approve' })).status).toBe(404);
    h.owner.mockImplementationOnce(async (id) => ({ id, bot_id: BOT, source: 'web', external_user_id: 'v2' }));
    expect((await decide(OTHER_CONVERSATION, actionId, { decision: 'approve' })).status).toBe(404);
    expect((await decide(CONVERSATION, actionId, { decision: 'maybe' })).status).toBe(400);
    expect((await decide(CONVERSATION, actionId, 'not json')).status).toBe(400);
    expect(pp.refundCalls()).toHaveLength(0);
    expect(store.attention[CONVERSATION].escalated).toBe(true);
  });

  it('an approver (bot_members) may decide: the route uses the accessible-bots check', async () => {
    const { actionId, pp } = await setupPending();
    h.auth.mockResolvedValue({ ok: true, userId: '00000000-0000-4000-8000-00000000a99e', botIds: [BOT] });
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(pp.refundCalls()).toHaveLength(1);
  });
});

describe('interpretDecisionResponse (the inbox handler without React)', () => {
  const row = (over: Partial<PaymentActionView>): PaymentActionView => ({
    id: 'a1', kind: 'refund', status: 'pending', origin: 'approval', amountCents: 500, currency: 'USD', amount: '$5', reason: null,
    captureId: 'C', checks: [], paypalRef: null, error: null, createdAt: '2026-10-21T00:00:00Z', decidedAt: null, decidable: true, ...over,
  });

  it('200: applies the row, clears the badge only when told', () => {
    const ok = interpretDecisionResponse(200, { action: row({ status: 'executed', decidable: false }), escalationCleared: true });
    expect(ok).toMatchObject({ action: { status: 'executed' }, escalationCleared: true, cardError: null, notice: null });
    expect(interpretDecisionResponse(200, { action: row({ status: 'rejected' }), escalationCleared: false }).escalationCleared).toBe(false);
  });

  it('409: applies the current row and reports it on the card', () => {
    const e = interpretDecisionResponse(409, { action: row({ status: 'executed', decidable: false }), error: 'already' });
    expect(e.action?.status).toBe('executed');
    expect(e.cardError).toMatch(/already decided/);
  });

  it('502 with a row: the row wins (no second decision), the explanation is a notice', () => {
    const e = interpretDecisionResponse(502, { action: row({ status: 'executing', decidable: false }), error: 'Approval saved, but …' });
    expect(e.action?.decidable).toBe(false);
    expect(e.cardError).toBeNull();
    expect(e.notice).toBe('Approval saved, but …');
  });

  it('no row: nothing was recorded, the card shows the error', () => {
    expect(interpretDecisionResponse(500, { error: 'boom' })).toMatchObject({ action: null, cardError: 'boom', notice: null });
    expect(interpretDecisionResponse(404, 'not json')).toMatchObject({ action: null, cardError: 'The decision failed (404).' });
  });
});

describe('GET /api/inbox/[conversationId] — paymentActions', () => {
  it('lists the conversation\'s refund requests as cards, newest first, with failed checks', async () => {
    const { store, actionId } = await setupPending();
    store.actions[0].guardrail = { amount_within_max: false, within_days: true, customer_known: true };
    const res = await GET(new Request('http://localhost/api/inbox/x'), { params: Promise.resolve({ conversationId: CONVERSATION }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paymentActions).toHaveLength(1);
    expect(json.paymentActions[0]).toMatchObject({
      id: actionId,
      status: 'pending',
      decidable: true,
      amount: '$5',
      reason: 'too slow',
      checks: [
        { key: 'amount_within_max', label: 'Amount within auto limit', passed: false },
        { key: 'within_days', label: 'Paid recently enough', passed: true },
        { key: 'customer_known', label: 'Customer identified', passed: true },
      ],
    });
  });

  it('tells the screen the caller\'s role; an approver still decides but reads role=approver (6/6)', async () => {
    const { actionId } = await setupPending();
    const asOwner = await GET(new Request('http://localhost/api/inbox/x'), { params: Promise.resolve({ conversationId: CONVERSATION }) });
    expect((await asOwner.json()).role).toBe('owner');

    h.auth.mockResolvedValue({ ok: true, userId: 'judge-1', botIds: [BOT], role: 'approver' });
    const asApprover = await GET(new Request('http://localhost/api/inbox/x'), { params: Promise.resolve({ conversationId: CONVERSATION }) });
    expect((await asApprover.json()).role).toBe('approver');
    const res = await decide(CONVERSATION, actionId, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toMatchObject({ status: 'executed' });
  });

  it('an empty or failing lookup still returns the conversation', async () => {
    h.store = memoryStore();
    const res = await GET(new Request('http://localhost/api/inbox/x'), { params: Promise.resolve({ conversationId: CONVERSATION }) });
    expect((await res.json()).paymentActions).toEqual([]);
    h.store = { ...memoryStore(), listActionsForConversation: async () => { throw new Error('db down'); } } as MemoryStore;
    const res2 = await GET(new Request('http://localhost/api/inbox/x'), { params: Promise.resolve({ conversationId: CONVERSATION }) });
    expect(res2.status).toBe(200);
    expect((await res2.json()).paymentActions).toEqual([]);
  });
});

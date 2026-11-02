// GET /api/inbox/[conversationId]: the precedent line is display only — a failed lookup never fails the
// conversation, and only a pending refund card gets one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentActionRow } from '@/lib/paypal/store';

const BOT = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';

type HistoryResult = { data: unknown; error: { message: string } | null };

const h = vi.hoisted(() => ({
  actions: [] as unknown[],
  /** What the payment_actions history query resolves to; a function that throws simulates a crash. */
  history: (() => ({ data: [], error: null })) as () => HistoryResult,
  historyCalls: 0,
}));

vi.mock('@/lib/auth/ownership', () => ({
  resolveAccessibleBots: vi.fn(async () => ({ ok: true, userId: 'u1', botIds: ['11111111-1111-4111-8111-111111111111'], role: 'owner' })),
}));
vi.mock('@/lib/bot/conversations', () => ({
  getConversationOwner: vi.fn(async (id: string) => ({ id, bot_id: '11111111-1111-4111-8111-111111111111', source: 'web', external_user_id: 'v1' })),
  getTimeline: vi.fn(async () => []),
  getConversationOrigin: vi.fn(async () => null),
  getMessageContexts: vi.fn(async () => ({})),
  markConversationRead: vi.fn(async () => {}),
}));
vi.mock('@/lib/paypal/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/paypal/store')>();
  return { ...actual, supabasePaymentsStore: () => ({ listActionsForConversation: async () => h.actions }) };
});
vi.mock('@/lib/widget/shots', () => ({ signShotsForMessages: vi.fn(async () => ({})) }));
vi.mock('@/lib/bot/channel-registration', () => ({ getChannelDeskUrl: vi.fn(async () => null) }));
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === 'conversations') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'open' }, error: null }) }) }) };
      }
      // payment_actions history: select → eq → eq → in → order → limit (awaited)
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: async () => {
          h.historyCalls += 1;
          return h.history();
        },
      };
      return chain;
    },
  }),
}));

import { GET } from '@/app/api/inbox/[conversationId]/route';

let n = 0;
const action = (o: Partial<PaymentActionRow> = {}): PaymentActionRow => {
  n += 1;
  return {
    id: `act-${n}`,
    bot_id: BOT,
    conversation_id: CONV,
    kind: 'refund',
    target_id: `CAP${n}`,
    amount_cents: 7900,
    currency: 'USD',
    customer_key: null,
    origin: 'approval',
    status: 'pending',
    reason: 'team got smaller',
    guardrail: { amount_within_max: false, no_dispute: true },
    paypal_ref: null,
    error: null,
    decided_by: null,
    decided_at: null,
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    reconcile_attempts: 0,
    reconcile_attempted_at: null,
    sent_at: null,
    send_attempts: 0,
    ...o,
  };
};
const past = (o: Partial<PaymentActionRow> = {}) =>
  action({ conversation_id: 'conv-past', status: 'executed', created_at: '2026-10-20T00:00:00.000Z', ...o });

const get = () =>
  GET(new Request(`http://localhost/api/inbox/${CONV}`), { params: Promise.resolve({ conversationId: CONV }) });

beforeEach(() => {
  h.actions = [];
  h.history = () => ({ data: [], error: null });
  h.historyCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/inbox/[conversationId] — precedents', () => {
  it('a pending refund gets a precedent from the decided history', async () => {
    const pending = action();
    h.actions = [pending];
    h.history = () => ({ data: [past(), past({ status: 'rejected' })], error: null });
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.precedents)).toEqual([pending.id]);
    expect(json.precedents[pending.id]).toMatchObject({ basis: 'check', total: 2, refunded: 1, rejected: 1, sample: 0 });
  });

  it('only pending refund actions get one — decided refunds and dispute actions do not, and nothing is looked up', async () => {
    h.actions = [action({ status: 'executed' }), action({ status: 'rejected' }), action({ kind: 'accept_dispute' })];
    h.history = () => ({ data: [past()], error: null });
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.precedents).toEqual({});
    expect(json.paymentActions).toHaveLength(3);
    expect(h.historyCalls).toBe(0);
  });

  it('a mixed list: only the pending refund is keyed', async () => {
    const pending = action();
    h.actions = [action({ status: 'executed', created_at: '2026-10-25T00:00:00.000Z' }), pending, action({ kind: 'accept_dispute' })];
    h.history = () => ({ data: [past()], error: null });
    const json = await (await get()).json();
    expect(Object.keys(json.precedents)).toEqual([pending.id]);
  });

  it('lookup returns an error → 200, precedents {}', async () => {
    h.actions = [action()];
    h.history = () => ({ data: null, error: { message: 'relation does not exist' } });
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.precedents).toEqual({});
    expect(json.paymentActions).toHaveLength(1);
  });

  it('lookup throws → 200, precedents {}', async () => {
    h.actions = [action()];
    h.history = () => {
      throw new Error('network down');
    };
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.precedents).toEqual({});
    expect(json.paymentActions).toHaveLength(1);
  });
});

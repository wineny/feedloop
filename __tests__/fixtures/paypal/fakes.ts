// Test doubles for the PayPal checkout/capture/webhook tests:
//  - memoryStore(): PaymentsStore over plain arrays, with the same conditional-update semantics.
//  - fakePayPal(): a PayPalClient whose fetch is a tiny in-memory PayPal (orders, captures, idempotency).
//  - signer(): a test RSA key that signs webhook transmissions the way PayPal does.

import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { PayPalClient } from '@/lib/paypal/client';
import { isAnnouncedStatus } from '@/lib/paypal/store';
import type {
  NewOrderRow,
  OpenRefundInput,
  OpenRefundResult,
  OrderRow,
  PaymentActionRow,
  PaymentsStore,
  ProductRow,
  VerificationRow,
  WebhookInsertResult,
} from '@/lib/paypal/store';

export const BOT = '11111111-1111-4111-8111-111111111111';
export const OTHER_BOT = '22222222-2222-4222-8222-222222222222';
export const PRO = '33333333-3333-4333-8333-333333333333';
export const RETIRED = '44444444-4444-4444-8444-444444444444';
export const OTHER_BOT_PRODUCT = '55555555-5555-4555-8555-555555555555';
export const CONVERSATION = '66666666-6666-4666-8666-666666666666';

export function products(): ProductRow[] {
  return [
    { id: PRO, bot_id: BOT, sku: 'pro', name: 'Pro', description: null, amount_cents: 2900, currency: 'USD', active: true, sort_order: 2 },
    { id: RETIRED, bot_id: BOT, sku: 'old', name: 'Old', description: null, amount_cents: 500, currency: 'USD', active: false, sort_order: 9 },
    { id: OTHER_BOT_PRODUCT, bot_id: OTHER_BOT, sku: 'pro', name: 'Pro', description: null, amount_cents: 100, currency: 'USD', active: true, sort_order: 1 },
  ];
}

export interface MemoryStore extends PaymentsStore {
  orders: OrderRow[];
  events: { event_id: string; event_type: string; processed_at: string | null; error: string | null }[];
  responses: { botId: string; conversationId: string; body: string }[];
  /** `${actionId}:${status}` once that status was announced — the payment_announcements primary key. */
  announcements: Set<string>;
  verifications: VerificationRow[];
  actions: (PaymentActionRow & { payload?: unknown; result?: unknown })[];
  /**
   * The guardrail decision the fake RPC returns for a NEW row. The real decision lives in SQL
   * (supabase/tests/guardrail_refund.sql); here tests script it. Duplicate detection (one live
   * action per capture) is emulated for real, since the refund code depends on it.
   */
  nextDecision: 'auto' | 'pending';
  openRefundCalls: OpenRefundInput[];
  /** conversations.escalated_at / handoff_requested_at, as far as the refund code touches them. */
  attention: Record<string, { escalated: boolean; handoff: boolean }>;
}

const LIVE_ACTION = new Set(['pending', 'executing', 'unknown', 'executed']);

export function memoryStore(initial: { products?: ProductRow[]; orders?: OrderRow[] } = {}): MemoryStore {
  const productRows = initial.products ?? products();
  const store: MemoryStore = {
    orders: [...(initial.orders ?? [])],
    events: [],
    responses: [],
    announcements: new Set(),
    verifications: [],
    actions: [],
    nextDecision: 'auto',
    openRefundCalls: [],
    attention: {},
    async listActiveProducts(botId) {
      return productRows.filter((p) => p.bot_id === botId && p.active).sort((a, b) => a.sort_order - b.sort_order);
    },
    async getProduct(botId, productId) {
      return productRows.find((p) => p.bot_id === botId && p.id === productId) ?? null;
    },
    async countOpenOrdersSince(botId) {
      return store.orders.filter((o) => o.bot_id === botId && o.status === 'created').length;
    },
    async insertOrder(row: NewOrderRow) {
      if (store.orders.some((o) => o.order_id === row.order_id)) throw new Error('duplicate order');
      store.orders.push({
        ...row,
        capture_id: null,
        payer_email: null,
        payer_id: null,
        created_at: new Date().toISOString(),
        captured_at: null,
      });
    },
    async getOrder(orderId) {
      const o = store.orders.find((r) => r.order_id === orderId);
      return o ? { ...o } : null;
    },
    async updateOrder(orderId, botId, fromStatuses, patch) {
      const o = store.orders.find((r) => r.order_id === orderId && r.bot_id === botId && fromStatuses.includes(r.status));
      if (!o) return null;
      Object.assign(o, patch);
      return { ...o };
    },
    async insertWebhookEvent(row): Promise<WebhookInsertResult> {
      const seen = store.events.find((e) => e.event_id === row.event_id);
      if (seen) return { inserted: false, processed: seen.processed_at !== null };
      store.events.push({ event_id: row.event_id, event_type: row.event_type, processed_at: null, error: null });
      return { inserted: true };
    },
    async finishWebhookEvent(eventId, error) {
      const e = store.events.find((r) => r.event_id === eventId);
      if (!e) return;
      if (error === null) {
        e.processed_at = new Date().toISOString();
        e.error = null;
      } else {
        e.error = error;
      }
    },
    async insertPaymentResponse(input) {
      store.responses.push(input);
    },
    // Mirrors payment_action_announce: the row's CURRENT status must match, once per (row, status).
    async announceAction(actionId, status, body) {
      const a = store.actions.find((r) => r.id === actionId);
      if (!a || !a.conversation_id || a.status !== status) return false;
      const key = `${actionId}:${status}`;
      if (store.announcements.has(key)) return false;
      store.announcements.add(key);
      store.responses.push({ botId: a.bot_id, conversationId: a.conversation_id, body });
      return true;
    },
    async listUnannouncedActions(limit) {
      return store.actions
        .filter(
          (a) =>
            a.kind === 'refund' &&
            a.conversation_id !== null &&
            isAnnouncedStatus(a.status) &&
            !store.announcements.has(`${a.id}:${a.status}`),
        )
        .sort((x, y) => x.updated_at.localeCompare(y.updated_at))
        .slice(0, limit)
        .map((a) => ({ ...a }));
    },
    async upsertVerification(row) {
      const i = store.verifications.findIndex((v) => v.conversation_id === row.conversation_id && v.order_id === row.order_id);
      const next: VerificationRow = { ...row, verified_at: new Date().toISOString() };
      if (i >= 0) store.verifications[i] = next;
      else store.verifications.push(next);
    },
    async latestVerification(conversationId) {
      const mine = store.verifications.filter((v) => v.conversation_id === conversationId);
      return mine.length ? { ...mine[mine.length - 1] } : null;
    },
    async openRefund(input): Promise<OpenRefundResult> {
      store.openRefundCalls.push(input);
      if (input.amountCents > input.captureTotalCents) throw new Error(`refund amount ${input.amountCents} exceeds the capture total ${input.captureTotalCents}`);
      const existing = store.actions.find(
        (a) => a.bot_id === input.botId && a.kind === 'refund' && a.target_id === input.captureId && LIVE_ACTION.has(a.status),
      );
      if (existing) return { created: false, auto: existing.origin === 'auto', action: { ...existing } };
      // Mirrors the v2 SQL: an unknown customer never auto-passes, whatever the script says.
      const customerKey = input.customerKey?.trim().toLowerCase() || null;
      const auto = store.nextDecision === 'auto' && customerKey !== null;
      const now = new Date().toISOString();
      const action: PaymentActionRow = {
        id: randomUUID(),
        bot_id: input.botId,
        conversation_id: input.conversationId,
        kind: 'refund',
        target_id: input.captureId,
        amount_cents: input.amountCents,
        currency: input.currency.toUpperCase(),
        customer_key: customerKey,
        origin: auto ? 'auto' : 'approval',
        status: auto ? 'executing' : 'pending',
        reason: input.reason,
        guardrail: { scripted: auto, customer_known: customerKey !== null },
        paypal_ref: null,
        error: null,
        decided_by: null,
        decided_at: null,
        created_at: now,
        updated_at: now,
        reconcile_attempts: 0,
        reconcile_attempted_at: null,
        sent_at: null,
        send_attempts: 0,
      };
      store.actions.push(action);
      // like the SQL: a pending refund raises the conversation's badge in the same step
      if (!auto && input.conversationId) {
        const a = store.attention[input.conversationId] ?? { escalated: false, handoff: false };
        store.attention[input.conversationId] = { ...a, escalated: true };
      }
      return { created: true, auto, action: { ...action }, checks: { scripted: auto, customer_known: customerKey !== null } };
    },
    async clearRefundAttention(conversationId, botId) {
      const a = store.attention[conversationId];
      if (!a || !a.escalated || a.handoff) return false;
      const pending = store.actions.some((x) => x.conversation_id === conversationId && x.bot_id === botId && x.status === 'pending');
      if (pending) return false;
      a.escalated = false;
      return true;
    },
    async markSent(actionId) {
      const a = store.actions.find((r) => r.id === actionId);
      if (!a) throw new Error(`action ${actionId} not found`);
      if (a.status !== 'executing' && a.status !== 'unknown') return { allowed: false, first: false, status: a.status };
      const first = a.sent_at === null;
      a.sent_at = a.sent_at ?? new Date().toISOString();
      a.send_attempts += 1;
      return { allowed: true, first, status: a.status };
    },
    async settleAction(actionId, outcome, from = ['executing'], opts = {}) {
      const a = store.actions.find(
        (r) =>
          r.id === actionId &&
          from.includes(r.status) &&
          (!opts.onlyIfNeverSent || r.sent_at === null) &&
          (!opts.onlyIfFirstAttempt || r.send_attempts === 1),
      );
      if (!a) return false;
      a.status = outcome.status;
      a.payload = outcome.payload;
      a.updated_at = new Date().toISOString();
      if (outcome.status === 'executed') {
        a.paypal_ref = outcome.paypalRef;
        a.result = outcome.result;
      } else {
        a.error = outcome.error;
        a.result = outcome.result ?? null;
        if (outcome.paypalRef) a.paypal_ref = outcome.paypalRef;
      }
      return true;
    },
    async latestRefundAction(botId, captureId) {
      const mine = store.actions.filter((a) => a.bot_id === botId && a.kind === 'refund' && a.target_id === captureId);
      return mine.length ? { ...mine[mine.length - 1] } : null;
    },
    async getAction(actionId, botId) {
      const a = store.actions.find((r) => r.id === actionId && r.bot_id === botId);
      return a ? { ...a } : null;
    },
    async listActionsForConversation(conversationId) {
      return store.actions
        .filter((a) => a.conversation_id === conversationId)
        .sort((x, y) => y.created_at.localeCompare(x.created_at))
        .map((a) => ({ ...a }));
    },
    async listStuckActions({ olderThan, notAttemptedSince, limit }) {
      return store.actions
        .filter(
          (a) =>
            (a.status === 'executing' || a.status === 'unknown') &&
            a.updated_at < olderThan &&
            (a.reconcile_attempted_at === null || a.reconcile_attempted_at < notAttemptedSince),
        )
        .sort((x, y) => {
          // never attempted first, then least recently attempted, then oldest change
          if (x.reconcile_attempted_at === null && y.reconcile_attempted_at !== null) return -1;
          if (x.reconcile_attempted_at !== null && y.reconcile_attempted_at === null) return 1;
          const byAttempt = (x.reconcile_attempted_at ?? '').localeCompare(y.reconcile_attempted_at ?? '');
          return byAttempt !== 0 ? byAttempt : x.updated_at.localeCompare(y.updated_at);
        })
        .slice(0, limit)
        .map((a) => ({ ...a }));
    },
    async markReconcileAttempt(actionId) {
      const a = store.actions.find((r) => r.id === actionId);
      if (!a) return;
      a.reconcile_attempts += 1;
      a.reconcile_attempted_at = new Date().toISOString();
    },
    async expirePendingActions({ olderThan }) {
      let n = 0;
      for (const a of store.actions) {
        if (a.status === 'pending' && a.created_at < olderThan) {
          a.status = 'expired';
          a.updated_at = new Date().toISOString();
          n += 1;
        }
      }
      return n;
    },
    async decideAction({ actionId, botId, decision, userId }) {
      const a = store.actions.find((r) => r.id === actionId && r.bot_id === botId);
      if (!a) throw new Error(`action ${actionId} not found for bot ${botId}`);
      if (a.status !== 'pending') return { updated: false, action: { ...a } };
      a.status = decision === 'approve' ? 'executing' : 'rejected';
      a.decided_by = userId;
      a.decided_at = new Date().toISOString();
      a.updated_at = a.decided_at;
      return { updated: true, action: { ...a } };
    },
  };
  return store;
}

export function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    order_id: 'ORDER0000001',
    bot_id: BOT,
    conversation_id: null,
    product_id: PRO,
    quantity: 1,
    amount_cents: 2900,
    currency: 'USD',
    status: 'created',
    capture_id: null,
    payer_email: null,
    payer_id: null,
    approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER0000001',
    created_at: '2026-10-19T00:00:00.000Z',
    captured_at: null,
    ...overrides,
  };
}

// ── fake PayPal ──────────────────────────────────────────────────────────────

interface FakeOrder {
  id: string;
  value: string;
  currency: string;
  approved: boolean;
  captureId: string | null;
  captureStatus: string;
  captureRequestId: string | null;
  captureTime?: string;
  payerEmail?: string;
}

interface FakeRefund {
  id: string;
  captureId: string;
  requestId: string | null;
  value: string;
  currency: string;
  /** What GET /v2/payments/refunds/{id} reports now. */
  status: string;
}

export type Call = { method: string; path: string; requestId: string | null; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function unprocessable(issue: string) {
  return json({ name: 'UNPROCESSABLE_ENTITY', message: issue, details: [{ issue }] }, 422);
}

export const BUYER_EMAIL = 'buyer@example.com';

export function fakePayPal(opts: { approveHost?: string; failCreate?: boolean } = {}) {
  const flags = {
    captureThenFail: false,
    nextCaptureStatus: 'COMPLETED',
    failRefund: false,
    rejectRefund: false,
    refundThenFail: false,
    conflictRefund: false,
    nextRefundStatus: 'COMPLETED',
    malformedRefund: false,
    failDisputes: false,
    failCaptureRead: false,
    captureReadDelayMs: 0,
  };
  const orders = new Map<string, FakeOrder>();
  const refunds: FakeRefund[] = [];
  const disputes: { dispute_id: string; captureId: string; status: string }[] = [];
  const calls: Call[] = [];
  let seq = 0;
  let refundSeq = 0;

  const orderBody = (o: FakeOrder) => ({
    id: o.id,
    status: o.captureId ? 'COMPLETED' : o.approved ? 'APPROVED' : 'CREATED',
    payer: o.approved ? { email_address: o.payerEmail ?? BUYER_EMAIL, payer_id: 'PAYER123' } : undefined,
    purchase_units: [
      {
        payments: o.captureId
          ? { captures: [{ id: o.captureId, status: o.captureStatus, amount: { value: o.value, currency_code: o.currency } }] }
          : undefined,
      },
    ],
  });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
    if (url.pathname === '/v1/oauth2/token') return json({ access_token: 't', expires_in: 3600, scope: '' });
    calls.push({ method, path: url.pathname, requestId: headers['PayPal-Request-Id'] ?? null, body });

    let m: RegExpMatchArray | null;
    if (method === 'POST' && url.pathname === '/v2/checkout/orders') {
      if (opts.failCreate) return json({ name: 'INTERNAL_SERVER_ERROR', message: 'boom' }, 500);
      const id = `FAKEORDER${String(++seq).padStart(4, '0')}`;
      const amount = body.purchase_units[0].amount;
      orders.set(id, {
        id,
        value: amount.value,
        currency: amount.currency_code,
        approved: false,
        captureId: null,
        captureStatus: 'COMPLETED',
        captureRequestId: null,
      });
      const host = opts.approveHost ?? 'www.sandbox.paypal.com';
      return json({ id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://${host}/checkoutnow?token=${id}` }] }, 201);
    }
    if ((m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/)) && method === 'POST') {
      const o = orders.get(m[1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no order' }, 404);
      if (!o.approved) return unprocessable('ORDER_NOT_APPROVED');
      if (o.captureId) {
        // PayPal answers a repeated Request-Id from its cache; a new one gets ORDER_ALREADY_CAPTURED.
        return o.captureRequestId === headers['PayPal-Request-Id'] ? json(orderBody(o), 201) : unprocessable('ORDER_ALREADY_CAPTURED');
      }
      o.captureId = `CAP${o.id}`;
      o.captureStatus = flags.nextCaptureStatus;
      o.captureRequestId = headers['PayPal-Request-Id'] ?? null;
      if (flags.captureThenFail) {
        // PayPal captured, but this caller only sees an error (e.g. a racing duplicate request).
        flags.captureThenFail = false;
        return json({ name: 'INTERNAL_SERVER_ERROR', message: 'try again' }, 500);
      }
      return json(orderBody(o), 201);
    }
    if ((m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === 'GET') {
      const o = orders.get(m[1]);
      return o ? json(orderBody(o)) : json({ name: 'RESOURCE_NOT_FOUND', message: 'no order' }, 404);
    }
    if ((m = url.pathname.match(/^\/v2\/payments\/captures\/([^/]+)$/)) && method === 'GET') {
      if (flags.failCaptureRead) return json({ name: 'INTERNAL_SERVER_ERROR', message: 'boom' }, 500);
      // A slow read that ignores the caller's signal, like a real server that answers late.
      if (flags.captureReadDelayMs > 0) await new Promise((r) => setTimeout(r, flags.captureReadDelayMs));
      const o = [...orders.values()].find((x) => x.captureId === m![1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no capture' }, 404);
      return json({
        id: o.captureId,
        status: o.captureStatus,
        amount: { value: o.value, currency_code: o.currency },
        create_time: o.captureTime ?? '2026-10-19T00:00:00Z',
        supplementary_data: { related_ids: { order_id: o.id } },
      });
    }
    if ((m = url.pathname.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/)) && method === 'POST') {
      const o = [...orders.values()].find((x) => x.captureId === m![1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no capture' }, 404);
      const requestId = headers['PayPal-Request-Id'] ?? null;
      const prior = requestId ? refunds.find((r) => r.requestId === requestId) : undefined;
      if (prior) return json({ id: prior.id, status: prior.status, amount: { value: prior.value, currency_code: prior.currency } }, 201);
      if (flags.failRefund) {
        flags.failRefund = false;
        return json({ name: 'INTERNAL_SERVER_ERROR', message: 'refund boom' }, 500);
      }
      if (flags.rejectRefund) {
        flags.rejectRefund = false;
        return unprocessable('REFUND_NOT_ALLOWED');
      }
      if (flags.conflictRefund) {
        // PayPal: a request with this PayPal-Request-Id is still being processed.
        flags.conflictRefund = false;
        return json({ name: 'RESOURCE_CONFLICT', message: 'Previous request in progress', details: [{ issue: 'PREVIOUS_REQUEST_IN_PROGRESS' }] }, 409);
      }
      if (!body?.amount?.value) return unprocessable('AMOUNT_REQUIRED_BY_THIS_FAKE');
      const status = flags.nextRefundStatus;
      flags.nextRefundStatus = 'COMPLETED';
      const refund: FakeRefund = {
        id: `REF${String(++refundSeq).padStart(4, '0')}`,
        captureId: o.captureId!,
        requestId,
        value: body.amount.value,
        currency: body.amount.currency_code,
        status,
      };
      if (status === 'COMPLETED' || status === 'PENDING') {
        refunds.push(refund);
        o.captureStatus = refund.value === o.value ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      }
      if (flags.refundThenFail) {
        // PayPal refunded, but this caller only sees a 500 (lost response).
        flags.refundThenFail = false;
        return json({ name: 'INTERNAL_SERVER_ERROR', message: 'gateway dropped the answer' }, 500);
      }
      if (flags.malformedRefund) {
        flags.malformedRefund = false;
        return json({ links: [] }, 201);
      }
      return json({ id: refund.id, status, amount: { value: refund.value, currency_code: refund.currency } }, 201);
    }
    if ((m = url.pathname.match(/^\/v2\/payments\/refunds\/([^/]+)$/)) && method === 'GET') {
      const r = refunds.find((x) => x.id === m![1]);
      if (!r) return json({ name: 'RESOURCE_NOT_FOUND', message: 'no refund' }, 404);
      return json({ id: r.id, status: r.status, amount: { value: r.value, currency_code: r.currency } });
    }
    if (url.pathname === '/v1/customer/disputes' && method === 'GET') {
      if (flags.failDisputes) return json({ name: 'INTERNAL_SERVER_ERROR', message: 'disputes boom' }, 500);
      const tx = url.searchParams.get('disputed_transaction_id');
      return json({ items: disputes.filter((d) => d.captureId === tx).map(({ dispute_id, status }) => ({ dispute_id, status })) });
    }
    return json({ name: 'NOT_FOUND', message: `${method} ${url.pathname}` }, 404);
  };

  const client = new PayPalClient({ clientId: 'cid', clientSecret: 'secret', fetch: fetchImpl as typeof fetch });

  return {
    client,
    calls,
    orders,
    /** Seeds an order PayPal knows about (as if created earlier). */
    addOrder(id: string, value = '29.00', currency = 'USD') {
      orders.set(id, { id, value, currency, approved: false, captureId: null, captureStatus: 'COMPLETED', captureRequestId: null });
    },
    /** The buyer approved on paypal.com. */
    approve(id: string) {
      const o = orders.get(id);
      if (o) o.approved = true;
    },
    captureCalls: () => calls.filter((c) => c.path.endsWith('/capture')),
    /** The next capture succeeds at PayPal but answers this caller with a 500. */
    captureThenFail() {
      flags.captureThenFail = true;
    },
    /** Status of the next capture (e.g. PENDING for a held payment). */
    nextCaptureStatus(status: string) {
      flags.nextCaptureStatus = status;
    },
    /** PayPal changes an existing capture's status (e.g. PENDING → DENIED). */
    setCaptureStatus(orderId: string, status: string) {
      const o = orders.get(orderId);
      if (o) o.captureStatus = status;
    },
    /** An order PayPal already captured (payer known), as the refund tests need it. */
    seedCaptured(id: string, value = '29.00', currency = 'USD', extra: { captureTime?: string; payerEmail?: string } = {}) {
      orders.set(id, {
        id,
        value,
        currency,
        approved: true,
        captureId: `CAP${id}`,
        captureStatus: 'COMPLETED',
        captureRequestId: id,
        captureTime: extra.captureTime,
        payerEmail: extra.payerEmail,
      });
      return `CAP${id}`;
    },
    refundCalls: () => calls.filter((c) => c.path.endsWith('/refund')),
    refunds,
    /** The next refund call answers 500 (PayPal did not refund). */
    failRefund() {
      flags.failRefund = true;
    },
    /** The next refund call answers 422 (PayPal definitely refused). */
    rejectRefund() {
      flags.rejectRefund = true;
    },
    /** The next refund call answers 409 PREVIOUS_REQUEST_IN_PROGRESS (another request with that id is running). */
    conflictRefund() {
      flags.conflictRefund = true;
    },
    /** The next refund succeeds at PayPal but the caller only sees a 500. */
    refundThenFail() {
      flags.refundThenFail = true;
    },
    /** The next refund resource comes back with this status (PENDING | FAILED | CANCELLED | …). */
    nextRefundStatus(status: string) {
      flags.nextRefundStatus = status;
    },
    /** The next refund answers 201 with a body that has no id and no status. */
    malformedRefund() {
      flags.malformedRefund = true;
    },
    /** PayPal finishes (or fails) a refund it had reported PENDING. */
    setRefundStatus(refundId: string, status: string) {
      const r = refunds.find((x) => x.id === refundId);
      if (r) r.status = status;
    },
    refundReads: () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v2/payments/refunds/')),
    /** Capture reads take this long and ignore the caller's signal. */
    delayCaptureRead(ms: number) {
      flags.captureReadDelayMs = ms;
    },
    /** Every disputes read answers 500 until cleared. */
    failDisputes(on = true) {
      flags.failDisputes = on;
    },
    /** Every capture read answers 500 until cleared. */
    failCaptureRead(on = true) {
      flags.failCaptureRead = on;
    },
    addDispute(captureId: string, status = 'OPEN') {
      disputes.push({ dispute_id: `PP-D-${disputes.length + 1}`, captureId, status });
    },
  };
}

// ── webhook signing ──────────────────────────────────────────────────────────

export const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test-0001';

export function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicPem,
    /** Headers PayPal would send for `raw`, signed for `webhookId`. */
    headers(raw: string | Buffer, webhookId: string, overrides: Record<string, string> = {}) {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      const transmissionId = 'b2c4e8f0-1343-11ef-ac58-e32457403f67';
      const transmissionTime = '2026-10-19T05:19:23Z';
      const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(bytes) >>> 0}`;
      const sig = createSign('SHA256').update(message).sign(privateKey).toString('base64');
      return {
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': transmissionTime,
        'paypal-transmission-sig': sig,
        'paypal-cert-url': CERT_URL,
        'paypal-auth-algo': 'SHA256withRSA',
        ...overrides,
      };
    },
  };
}

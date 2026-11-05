// The payment ledger on the dashboard (stage 5, item 3): refunds (`payment_actions`) and purchases
// (`paypal_orders`) in one list, newest first. Pure — the route, the screen and the tests share it.
// No Node imports: the client page imports this too.
//
// What a row carries is exactly what the execution-record view shows. Nothing else leaves the server:
// no buyer email (`customer_key`, `payer_email`), no approve URL, no raw PayPal response — the request
// body and the result are reduced to the amount sent and PayPal's status word.

import { isSampleRef } from '@/lib/demo/sample-marker';
import { interpretDecisionResponse, type DecisionResponseEffect, type PaymentActionView } from './action-view';
import type { OrderStatus, PaymentActionStatus } from './store';

export type LedgerType = 'refund' | 'purchase' | 'dispute';

/**
 * Rows per table and in the merged list (the route). The dashboard shows the newest money moves, not an
 * archive. Whether a table was cut is read from `count: 'exact'` (count > rows), not from the row count —
 * PostgREST's own cap (1000) would hide behind a larger limit otherwise. Same rule as the dashboard numbers.
 */
export const LEDGER_LIMIT = 200;

/** One payment_actions row as the ledger reads it. `payload`/`result` are whatever was stored — read defensively. */
export interface LedgerActionSource {
  id: string;
  kind: 'refund' | 'accept_dispute';
  origin: 'auto' | 'approval';
  status: PaymentActionStatus;
  amount_cents: number | null;
  currency: string | null;
  target_id: string;
  conversation_id: string | null;
  paypal_ref: string | null;
  reason: string | null;
  guardrail: Record<string, boolean> | null;
  error: string | null;
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
  payload: unknown;
  result: unknown;
}

/** One paypal_orders row (+ the product's name) as the ledger reads it. */
export interface LedgerOrderSource {
  order_id: string;
  status: OrderStatus;
  amount_cents: number;
  currency: string;
  quantity: number;
  capture_id: string | null;
  conversation_id: string | null;
  refunded_cents: number | null;
  created_at: string;
  captured_at: string | null;
  refunded_at: string | null;
  product_name: string | null;
}

/** Who decided a pending refund. Name only — never an email. `self` = the person looking at the ledger. */
export interface LedgerDecider {
  self: boolean;
  name: string | null;
}

/** The execution record of a refund / dispute acceptance. */
export interface LedgerActionDetail {
  kind: 'refund' | 'accept_dispute';
  /** Capture id (refund) or dispute id (accept_dispute). */
  targetId: string;
  paypalRef: string | null;
  /** What the buyer said. */
  reason: string | null;
  /** Guardrail checks that did not pass (keys) — why a refund waited for a person. */
  failedChecks: string[];
  /** What we sent to PayPal: the amount only (the request body is `{ amount: { value, currency_code } }`). */
  sent: { value: string; currency: string } | null;
  /** PayPal's status word for the refund (COMPLETED, PENDING, …), when it answered. */
  resultStatus: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: LedgerDecider | null;
  executedAt: string | null;
  /** Last change of the row — the time of a failure (there is no failed_at column). */
  updatedAt: string;
}

export interface LedgerPurchaseDetail {
  orderId: string;
  captureId: string | null;
  product: string | null;
  quantity: number;
  refundedCents: number;
  capturedAt: string | null;
  refundedAt: string | null;
}

interface LedgerRowBase {
  /** Unique across both tables (`action:<uuid>`, `order:<order id>`). */
  key: string;
  at: string;
  amountCents: number | null;
  currency: string | null;
  conversationId: string | null;
}

export interface LedgerActionRow extends LedgerRowBase {
  type: 'refund' | 'dispute';
  /** The payment_actions id — what the approval route takes. */
  id: string;
  status: PaymentActionStatus;
  origin: 'auto' | 'approval';
  /** Approve / Reject can be offered: a pending refund in a conversation (the route's path needs one). */
  decidable: boolean;
  /** Seeded sample history (`SAMPLE-` capture / refund id, scripts/seed-sample-history.ts): badged, never sent to PayPal. */
  sample?: boolean;
  detail: LedgerActionDetail;
}

export interface LedgerPurchaseRow extends LedgerRowBase {
  type: 'purchase';
  /** The PayPal order id. */
  id: string;
  status: OrderStatus;
  origin: null;
  decidable: false;
  detail: LedgerPurchaseDetail;
}

export type LedgerRow = LedgerActionRow | LedgerPurchaseRow;
export type LedgerStatus = LedgerRow['status'];

export interface LedgerResponse {
  rows: LedgerRow[];
  /** More rows exist than were returned (a table hit its cap, or the merge was cut). */
  truncated: boolean;
}

function pickSent(payload: unknown): LedgerActionDetail['sent'] {
  const amount = (payload as { amount?: { value?: unknown; currency_code?: unknown } } | null)?.amount;
  if (!amount || typeof amount.value !== 'string' || typeof amount.currency_code !== 'string') return null;
  return { value: amount.value, currency: amount.currency_code };
}

function pickResultStatus(result: unknown): string | null {
  const status = (result as { status?: unknown } | null)?.status;
  return typeof status === 'string' ? status : null;
}

export function actionToLedgerRow(
  row: LedgerActionSource,
  decider: (userId: string) => LedgerDecider | null = () => null,
): LedgerActionRow {
  const type = row.kind === 'accept_dispute' ? 'dispute' : 'refund';
  return {
    key: `action:${row.id}`,
    type,
    id: row.id,
    at: row.created_at,
    status: row.status,
    origin: row.origin,
    amountCents: row.amount_cents,
    currency: row.currency,
    conversationId: row.conversation_id,
    // Same rule as the approval route: only refunds, only pending, and the route is addressed by conversation.
    decidable: type === 'refund' && row.status === 'pending' && row.conversation_id !== null,
    sample: isSampleRef(row.target_id) || isSampleRef(row.paypal_ref),
    detail: {
      kind: row.kind,
      targetId: row.target_id,
      paypalRef: row.paypal_ref,
      reason: row.reason,
      failedChecks: Object.entries(row.guardrail ?? {})
        .filter(([, passed]) => passed !== true)
        .map(([key]) => key),
      sent: pickSent(row.payload),
      resultStatus: pickResultStatus(row.result),
      error: row.error,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by ? decider(row.decided_by) : null,
      executedAt: row.executed_at,
      updatedAt: row.updated_at,
    },
  };
}

/** "5O190127TN364715T" → "…64715T". What a non-owner sees of an order id (`orderToLedgerRow`). */
export function shortOrderId(orderId: string): string {
  return orderId.length > 6 ? `…${orderId.slice(-6)}` : orderId;
}

/**
 * `fullOrderId`: only the bot's owner sees the whole PayPal order id. Approvers (the demo bot has many judge
 * approvers) get the last 6 characters — enough to tell orders apart, not enough to look one up on a receipt.
 * The row key then carries the short id + time instead, so the full id does not leak through the key either.
 */
export function orderToLedgerRow(row: LedgerOrderSource, opts: { fullOrderId?: boolean } = {}): LedgerPurchaseRow {
  const full = opts.fullOrderId ?? true;
  const orderId = full ? row.order_id : shortOrderId(row.order_id);
  return {
    key: full ? `order:${row.order_id}` : `order:${orderId}:${row.created_at}`,
    type: 'purchase',
    id: orderId,
    at: row.created_at,
    status: row.status,
    origin: null,
    amountCents: row.amount_cents,
    currency: row.currency,
    conversationId: row.conversation_id,
    decidable: false,
    detail: {
      orderId,
      captureId: row.capture_id,
      product: row.product_name,
      quantity: row.quantity,
      refundedCents: row.refunded_cents ?? 0,
      capturedAt: row.captured_at,
      refundedAt: row.refunded_at,
    },
  };
}

/** Newest first; ties keep a stable order by key so the list does not jump between refreshes. */
export function compareLedgerRows(a: LedgerRow, b: LedgerRow): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function mergeLedger(actions: LedgerActionRow[], orders: LedgerPurchaseRow[], limit: number): { rows: LedgerRow[]; cut: boolean } {
  const all: LedgerRow[] = [...actions, ...orders].sort(compareLedgerRows);
  return { rows: all.slice(0, limit), cut: all.length > limit };
}

// ── filters (client side: the list is at most LEDGER_LIMIT rows) ─────────────────────────────

export type LedgerTypeFilter = 'all' | LedgerType;
/**
 * A status choice is «type:status», not the bare status: a refund's `failed` (“Failed”) and a purchase's
 * `failed` (“Declined”) are different things and stay separate under Type = All.
 */
export type LedgerStatusKey = `${LedgerType}:${LedgerStatus}`;
export type LedgerStatusFilter = 'all' | LedgerStatusKey;

export const LEDGER_TYPE_FILTERS: readonly LedgerTypeFilter[] = ['all', 'refund', 'purchase', 'dispute'];

export function ledgerStatusKey(row: Pick<LedgerRow, 'type' | 'status'>): LedgerStatusKey {
  return `${row.type}:${row.status}` as LedgerStatusKey;
}

export function parseLedgerStatusKey(key: LedgerStatusKey): { type: LedgerType; status: LedgerStatus } {
  const at = key.indexOf(':');
  return { type: key.slice(0, at) as LedgerType, status: key.slice(at + 1) as LedgerStatus };
}

/**
 * `keep`: rows that stay on screen whatever the status filter says — a row the operator just decided. With
 * Status = “Waiting for approval”, approving the only pending row would otherwise make it (and its result
 * message) vanish the moment it changed. The screen empties `keep` when a filter changes.
 */
export function filterLedger(
  rows: readonly LedgerRow[],
  type: LedgerTypeFilter,
  status: LedgerStatusFilter,
  keep: ReadonlySet<string> = new Set(),
): LedgerRow[] {
  return rows.filter(
    (row) => (type === 'all' || row.type === type) && (status === 'all' || ledgerStatusKey(row) === status || keep.has(row.key)),
  );
}

/**
 * The status choices for the current type filter: only those that occur, in first-seen order (= newest
 * first) — plus the active choice, even when no row has it any more (after a decision), so the select
 * never shows a value missing from its options.
 */
export function ledgerStatusOptions(rows: readonly LedgerRow[], type: LedgerTypeFilter, active: LedgerStatusFilter = 'all'): LedgerStatusKey[] {
  const seen = new Set<LedgerStatusKey>();
  for (const row of rows) if (type === 'all' || row.type === type) seen.add(ledgerStatusKey(row));
  if (active !== 'all') seen.add(active);
  return [...seen];
}

/** Type filters worth showing: All + the types that occur. Disputes are rare; an always-empty tab is noise. */
export function ledgerTypeOptions(rows: readonly LedgerRow[]): LedgerTypeFilter[] {
  const present = new Set(rows.map((row) => row.type));
  return LEDGER_TYPE_FILTERS.filter((type) => type === 'all' || present.has(type));
}

/** Replace one row in place after a decision (the server's answer is the truth), keeping order. */
export function replaceLedgerRow(rows: readonly LedgerRow[], next: LedgerRow): LedgerRow[] {
  return rows.map((row) => (row.key === next.key ? next : row));
}

/** The inbox URL that opens this conversation (`?c=` is the inbox's deep link). */
export function ledgerConversationHref(conversationId: string): string {
  return `/inbox?c=${encodeURIComponent(conversationId)}`;
}

/**
 * A ledger row after a decision, from the decision route's answer (`PaymentActionView`). The route
 * answers with the row as the server now has it — even on 409 (someone else decided first) — so the
 * ledger shows that, then reloads for the rest (who decided, PayPal's result).
 */
export function applyActionView(row: LedgerActionRow, view: Pick<PaymentActionView, 'id' | 'status' | 'paypalRef' | 'error' | 'decidedAt' | 'decidable'>): LedgerActionRow {
  if (row.id !== view.id) return row;
  return {
    ...row,
    status: view.status,
    decidable: view.decidable && row.decidable,
    detail: { ...row.detail, paypalRef: view.paypalRef, error: view.error, decidedAt: view.decidedAt },
  };
}

export type LedgerDecision = 'approve' | 'reject';

/**
 * Approve / Reject from the ledger = the inbox approval card's call, unchanged: the stage-3 decision route
 * (`POST /api/inbox/<conversation>/payment-actions/<action>` → `payment_action_decide`, one conditional
 * UPDATE; approve then sends through `executeApprovedAction`). No money logic here — the route decides who
 * may act and answers 409 with the current row when someone else decided first.
 */
export async function postLedgerDecision(
  row: Pick<LedgerActionRow, 'id' | 'conversationId'>,
  decision: LedgerDecision,
  fetchImpl: typeof fetch = fetch,
): Promise<DecisionResponseEffect & { status: number }> {
  if (!row.conversationId) {
    return { status: 0, action: null, escalationCleared: false, cardError: null, cardErrorCode: 'failed', notice: null };
  }
  const res = await fetchImpl(
    `/api/inbox/${encodeURIComponent(row.conversationId)}/payment-actions/${encodeURIComponent(row.id)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) },
  );
  const json: unknown = await res.json().catch(() => ({}));
  return { ...interpretDecisionResponse(res.status, json), status: res.status };
}

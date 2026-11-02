// "What did we do last time?" for a pending refund card (display only — never feeds approve/reject).
// Pure: the inbox route loads recent decided refunds and passes them in.
// Reason bucket is deliberately not used in v1: it needs the messages+insights join the dashboard
// route does, too heavy for the inbox route.

import { ledgerConversationHref } from './ledger';
import { formatMoney } from './money';
import { isSampleRef } from '@/lib/demo/sample-marker';
import type { PaymentActionRow } from './store';

export const PRECEDENT_MAX = 20;
export const PRECEDENT_EVIDENCE_MAX = 3;
/** Upper edges . */
export const PRECEDENT_BAND_EDGES = [2000, 5000, 10000, 25000];

export type PrecedentRow = Pick<
  PaymentActionRow,
  'id' | 'conversation_id' | 'kind' | 'origin' | 'status' | 'amount_cents' | 'currency' | 'guardrail' | 'target_id' | 'created_at'
>;

export interface PaymentPrecedent {
  basis: 'check' | 'amount';
  total: number;
  refunded: number;
  rejected: number;
  /** Refunded ones that ran without a person (origin auto). */
  auto: number;
  /** Counted rows that are seeded sample history (SAMPLE- capture), not real decisions. */
  sample: number;
  evidence: {
    actionId: string;
    conversationId: string;
    href: string;
    status: PrecedentRow['status'];
    amount: string | null;
    at: string;
    sample: boolean;
  }[];
}

export function amountBand(cents: number): number {
  const i = PRECEDENT_BAND_EDGES.findIndex((edge) => cents < edge);
  return i === -1 ? PRECEDENT_BAND_EDGES.length : i;
}

/** A check failed only when the RPC recorded `false`; null/missing means it was not evaluated. */
function failedKeys(row: Pick<PrecedentRow, 'guardrail'>): string[] {
  return Object.entries(row.guardrail ?? {}).filter(([, v]) => v === false).map(([k]) => k);
}

export function computePrecedent(current: PrecedentRow, candidates: PrecedentRow[]): PaymentPrecedent | null {
  if (current.amount_cents === null || !current.currency) return null;
  const band = amountBand(current.amount_cents);
  const pool = candidates.filter(
    (c) =>
      c.id !== current.id &&
      c.kind === 'refund' &&
      (c.status === 'executed' || c.status === 'rejected') &&
      c.amount_cents !== null &&
      c.currency === current.currency &&
      amountBand(c.amount_cents) === band &&
      Date.parse(c.created_at) < Date.parse(current.created_at),
  );

  const failed = failedKeys(current);
  const byCheck = failed.length > 0 ? pool.filter((c) => failedKeys(c).some((k) => failed.includes(k))) : [];
  const basis: PaymentPrecedent['basis'] = byCheck.length > 0 ? 'check' : 'amount';
  const used = (basis === 'check' ? byCheck : pool)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, PRECEDENT_MAX);
  if (used.length === 0) return null;

  const executed = used.filter((c) => c.status === 'executed');
  return {
    basis,
    total: used.length,
    refunded: executed.length,
    rejected: used.length - executed.length,
    auto: executed.filter((c) => c.origin === 'auto').length,
    sample: used.filter((c) => isSampleRef(c.target_id)).length,
    evidence: used
      .filter((c): c is PrecedentRow & { conversation_id: string } => c.conversation_id !== null)
      .slice(0, PRECEDENT_EVIDENCE_MAX)
      .map((c) => ({
        actionId: c.id,
        conversationId: c.conversation_id,
        href: ledgerConversationHref(c.conversation_id),
        status: c.status,
        amount: c.amount_cents !== null && c.currency ? formatMoney(c.amount_cents, c.currency) : null,
        at: c.created_at,
        sample: isSampleRef(c.target_id),
      })),
  };
}

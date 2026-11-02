import { describe, expect, it } from 'vitest';
import { amountBand, computePrecedent, PRECEDENT_MAX, type PrecedentRow } from '@/lib/paypal/precedent';
import { getDemoData } from '@/lib/demo/mock-data';
import type { LedgerActionRow, LedgerRow } from '@/lib/paypal/ledger';
import type { PaymentPrecedent } from '@/lib/paypal/precedent';

let n = 0;
const row = (o: Partial<PrecedentRow> = {}): PrecedentRow => {
  n += 1;
  return {
    id: `r${n}`,
    conversation_id: `c${n}`,
    kind: 'refund',
    origin: 'approval',
    status: 'executed',
    amount_cents: 2500,
    currency: 'USD',
    guardrail: null,
    target_id: `CAP${n}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    ...o,
  };
};
const current = (o: Partial<PrecedentRow> = {}) =>
  row({ status: 'pending', created_at: '2026-10-30T00:00:00Z', ...o });

describe('computePrecedent', () => {
  it('null without candidates or amount', () => {
    expect(computePrecedent(current(), [])).toBeNull();
    expect(computePrecedent(current({ amount_cents: null }), [row()])).toBeNull();
  });

  it('band edges: 1999 vs 2000 are different bands', () => {
    expect(computePrecedent(current({ amount_cents: 1999 }), [row({ amount_cents: 2000 })])).toBeNull();
    expect(computePrecedent(current({ amount_cents: 2000 }), [row({ amount_cents: 4999 })])?.total).toBe(1);
    expect(computePrecedent(current({ amount_cents: 25000 }), [row({ amount_cents: 99999 })])?.total).toBe(1);
  });

  it('ignores other currency, future rows, failed/expired/pending, itself', () => {
    const cur = current();
    const out = computePrecedent(cur, [
      row({ currency: 'EUR' }),
      row({ created_at: '2026-11-01T00:00:00Z' }),
      row({ status: 'failed' }),
      row({ status: 'expired' }),
      row({ status: 'pending' }),
      { ...cur },
      row({ status: 'rejected' }),
    ]);
    expect(out).toMatchObject({ total: 1, refunded: 0, rejected: 1, basis: 'amount' });
  });

  it('check basis narrows to rows sharing a failed check; falls back to amount otherwise', () => {
    const cur = current({ guardrail: { amount_within_max: false, no_dispute: true } });
    const shared = row({ guardrail: { amount_within_max: false } });
    const other = row({ guardrail: { within_days: false } });
    expect(computePrecedent(cur, [shared, other])).toMatchObject({ basis: 'check', total: 1 });
    expect(computePrecedent(cur, [other])).toMatchObject({ basis: 'amount', total: 1 });
  });

  it('counts auto, caps at 20 newest, evidence = newest 3 with a conversation', () => {
    const rows = Array.from({ length: 25 }, () => row({ origin: 'auto' }));
    const out = computePrecedent(current(), rows)!;
    expect(PRECEDENT_MAX).toBe(20);
    expect(out.total).toBe(20);
    expect(out.auto).toBe(20);
    expect(out.evidence.map((e) => e.actionId)).toEqual([rows[24].id, rows[23].id, rows[22].id]);

    const withNull = [row(), row({ conversation_id: null }), row({ target_id: 'SAMPLE-CAP-0001' })];
    const ev = computePrecedent(current(), withNull)!.evidence;
    expect(ev).toHaveLength(2);
    expect(ev[0].sample).toBe(true);
    expect(ev[0].href).toBe(`/inbox?c=${withNull[2].conversation_id}`);
    expect(ev[0].amount).toBe('$25');
  });

  it('a check counts as failed only when it is false — null (not evaluated) is not a failure', () => {
    const cur = current({ guardrail: { amount_within_max: false, no_dispute: null as unknown as boolean } });
    const nullOnly = row({ guardrail: { no_dispute: null as unknown as boolean } });
    // the candidate's null does not match the current's null, so there is no shared failed check → amount basis
    expect(computePrecedent(cur, [nullOnly])).toMatchObject({ basis: 'amount', total: 1 });
    // a current row whose only non-true value is null has no failed check at all → amount basis
    const shared = row({ guardrail: { amount_within_max: false } });
    expect(computePrecedent(current({ guardrail: { amount_within_max: null as unknown as boolean } }), [shared])).toMatchObject({ basis: 'amount' });
    expect(computePrecedent(cur, [shared, nullOnly])).toMatchObject({ basis: 'check', total: 1 });
  });

  it('counts sample rows among the used candidates (not only the evidence)', () => {
    const rows = [row(), row({ target_id: 'SAMPLE-CAP-0001' }), row({ target_id: 'SAMPLE-CAP-0002', conversation_id: null }), row({ conversation_id: null })];
    expect(computePrecedent(current(), rows)).toMatchObject({ total: 4, sample: 2 });
    expect(computePrecedent(current(), [row()])).toMatchObject({ sample: 0 });
    // a sample row outside the used set (other band) is not counted
    expect(computePrecedent(current(), [row(), row({ target_id: 'SAMPLE-CAP-0003', amount_cents: 900 })])).toMatchObject({ total: 1, sample: 0 });
  });
});

describe('demo precedent (?demo=1 inbox)', () => {
  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: computed from the ledger — same check, you approved 4 of 5, evidence in the pending row's amount band with real conversations`, () => {
      const data = getDemoData(locale);
      const ledger = (data.dashboard as { ledger: LedgerRow[] }).ledger;
      const inbox = data.inbox as {
        conversations: { id: string }[];
        timelines: Record<string, unknown[]>;
        payments: Record<string, { precedents?: Record<string, PaymentPrecedent> }>;
      };
      const pending = ledger.find((r): r is LedgerActionRow => r.type === 'refund' && r.status === 'pending')!;
      const precedent = inbox.payments[pending.conversationId!].precedents![pending.id];
      expect(precedent).toMatchObject({ basis: 'check', total: 5, refunded: 4, rejected: 1, auto: 0, sample: 0 });
      expect(precedent.evidence.length).toBeGreaterThan(0);
      for (const e of precedent.evidence) {
        const source = ledger.find((r) => r.id === e.actionId)!;
        expect(source.amountCents).not.toBeNull();
        expect(amountBand(source.amountCents!)).toBe(amountBand(pending.amountCents!));
        expect(Date.parse(source.at)).toBeLessThan(Date.parse(pending.at));
        expect(inbox.conversations.some((c) => c.id === e.conversationId)).toBe(true);
        expect(inbox.timelines[e.conversationId]?.length).toBeGreaterThan(0);
      }
    });
  }
});

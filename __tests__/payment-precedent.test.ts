import { describe, expect, it } from 'vitest';
import { computePrecedent, PRECEDENT_MAX, type PrecedentRow } from '@/lib/paypal/precedent';

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
});

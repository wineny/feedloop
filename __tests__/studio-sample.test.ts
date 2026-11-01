import { describe, expect, it } from 'vitest';
import { buildSampleStore, reasonWindows, SAMPLE_REASONS } from '@/lib/studio/sample';

const TODAY = new Date('2026-11-01T12:00:00Z');

describe('Refund Studio sample store', () => {
  it('is deterministic for the same day', () => {
    expect(buildSampleStore(TODAY)).toEqual(buildSampleStore(TODAY));
  });

  it('has 200 payments and one refunded payment per refund', () => {
    const s = buildSampleStore(TODAY);
    const refundCount = SAMPLE_REASONS.reduce((n, r) => n + r.daysAgo.length, 0);
    expect(s.payments).toHaveLength(200);
    expect(s.refunds).toHaveLength(refundCount);
    const refunded = new Set(s.payments.filter((p) => p.status === 'Refunded').map((p) => p.id));
    expect(s.refunds.every((r) => refunded.has(r.paymentId))).toBe(true);
    expect(s.refunds.every((r) => r.date >= s.from && r.date <= s.asOf)).toBe(true);
  });

  it('puts the coupon bug on top of the last 7 days (8 vs 0 before)', () => {
    const s = buildSampleStore(TODAY);
    const [top] = reasonWindows(s.refunds, s.asOf, 7);
    expect(top).toMatchObject({ reasonKey: 'coupon-bug', recent: 8, previous: 0, total: 9 });
  });

  it('refunds never come before their payment', () => {
    const s = buildSampleStore(TODAY);
    const paidOn = new Map(s.payments.map((p) => [p.id, p.date]));
    expect(s.refunds.every((r) => (paidOn.get(r.paymentId) ?? '') <= r.date)).toBe(true);
  });
});

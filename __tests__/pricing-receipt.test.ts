// The receipt page's status mapping (src/lib/pricing/receipt.ts) and its en/ko copy.
import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@/lib/paypal/store';
import { RECEIPT_TONE, isSettling, refundFacts, showsQuestions } from '@/lib/pricing/receipt';
import { translator } from './helpers/intl';

const STATUSES = Object.keys(RECEIPT_TONE) as OrderStatus[];
const REFUND_STATES: OrderStatus[] = ['partially_refunded', 'refunded', 'reversed'];
const ROW_KEYS = ['refundedAmount', 'reversedAmount', 'remaining', 'refundRecorded', 'reversalRecorded'];

function order(status: OrderStatus, refunded_cents = 0, refunded_at: string | null = null) {
  return { status, amount_cents: 2900, refunded_cents, refunded_at };
}

describe('receipt copy', () => {
  it.each(['en', 'ko'] as const)('%s: every order status has its own title and body, and the refund rows have labels', (locale) => {
    const t = translator('pricing.receipt', locale);
    for (const status of STATUSES) {
      for (const part of ['title', 'body']) {
        const key = `${status}.${part}`;
        expect(t.has(key), `${locale} ${key}`).toBe(true);
      }
    }
    for (const key of ROW_KEYS) expect(t.has(key), `${locale} ${key}`).toBe(true);
  });

  it('en: the refund states say what happened, not "Payment received"', () => {
    const t = translator('pricing.receipt');
    expect(t('refunded.title')).toBe('Payment refunded');
    expect(t('partially_refunded.title')).toBe('Partially refunded');
    expect(t('reversed.title')).toBe('Payment reversed');
    for (const status of REFUND_STATES) expect(t(`${status}.title`)).not.toBe(t('captured.title'));
  });

  it('en: the earlier states keep their copy', () => {
    const t = translator('pricing.receipt');
    expect(t('captured.title')).toBe('Payment received');
    expect(t('approved.title')).toBe('Payment processing');
    expect(t('created.title')).toBe('Waiting for PayPal');
    expect(t('expired.title')).toBe('Checkout canceled');
    expect(t('failed.title')).toBe('Payment declined');
  });
});

describe('receipt mapping', () => {
  it('tone: only captured looks paid; refunds have their own look; a reversal looks not paid', () => {
    expect(RECEIPT_TONE).toEqual({
      captured: 'ok',
      approved: 'wait',
      created: 'wait',
      expired: 'bad',
      failed: 'bad',
      partially_refunded: 'refund',
      refunded: 'refund',
      reversed: 'bad',
    });
  });

  it('refund states are settled — the page does not keep refreshing', () => {
    expect(STATUSES.filter(isSettling).sort()).toEqual(['approved', 'created']);
  });

  it('the questions box shows for a paid order and for every refund state', () => {
    expect(STATUSES.filter(showsQuestions).sort()).toEqual(['captured', 'partially_refunded', 'refunded', 'reversed']);
  });

  it('no refund rows outside the refund states', () => {
    for (const status of ['captured', 'approved', 'created', 'expired', 'failed'] as const) {
      expect(refundFacts(order(status, 900))).toBeNull();
    }
  });

  it('partial refund: refunded amount and what is still paid', () => {
    expect(refundFacts(order('partially_refunded', 950, '2026-10-22T05:00:00Z'))).toEqual({
      kind: 'refunded',
      refundedCents: 950,
      remainingCents: 1950,
      recordedAt: '2026-10-22T05:00:00Z',
    });
  });

  it('full refund: the refunded amount, no remaining row', () => {
    expect(refundFacts(order('refunded', 2900))).toMatchObject({ kind: 'refunded', refundedCents: 2900, remainingCents: null });
  });

  it('a total of 0 (unreadable) hides the amount — never "$0 refunded"', () => {
    expect(refundFacts(order('reversed', 0))).toEqual({ kind: 'reversed', refundedCents: null, remainingCents: null, recordedAt: null });
    expect(refundFacts(order('partially_refunded', 0))).toMatchObject({ refundedCents: null, remainingCents: null });
    expect(refundFacts(order('refunded', 0))).toMatchObject({ refundedCents: null });
  });

  it('reversal: labeled as reversed, no remaining row', () => {
    expect(refundFacts(order('reversed', 2900))).toMatchObject({ kind: 'reversed', refundedCents: 2900, remainingCents: null });
  });
});

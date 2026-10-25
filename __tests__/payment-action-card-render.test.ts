import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentActionCard } from '@/components/inbox/PaymentActionCard';
import type { PaymentActionView } from '@/lib/paypal/action-view';
import { renderWithIntl } from './helpers/intl';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const action: PaymentActionView = {
  id: 'a1',
  kind: 'refund',
  status: 'pending',
  origin: 'approval',
  amountCents: 2950,
  currency: 'USD',
  amount: '$29.50',
  reason: 'Item not as described',
  captureId: 'CAPTURE123',
  checks: [
    { key: 'amount_within_max', label: 'Over the auto-refund limit', passed: false },
    { key: 'no_dispute', label: 'No open dispute', passed: true },
    { key: 'brand_new_check', label: 'Server label for a key the dictionary lacks', passed: false },
  ],
  paypalRef: null,
  error: null,
  createdAt: '2026-10-21T01:02:03Z',
  decidedAt: null,
  decidable: true,
};

const render = (a: PaymentActionView, locale: 'en' | 'ko' = 'en') =>
  renderWithIntl(React.createElement(PaymentActionCard, { action: a, onDecide: async () => a }), locale);

describe('PaymentActionCard (approval card)', () => {
  it('en: shows the pending request with Approve / Reject and the failed checks', () => {
    const html = render(action);
    expect(html).toContain('Refund request · $29.50');
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Approve $29.50');
    expect(html).toContain('Reject');
    expect(html).toContain('Why this needs your approval');
    expect(html).toContain('Over the auto-refund limit');
    expect(html).not.toContain('No open dispute'); // passed checks are not listed
    expect(html).toContain('Server label for a key the dictionary lacks'); // unknown key falls back to the server label
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('en: a decided card has no buttons', () => {
    const html = render({ ...action, status: 'executed', decidable: false, paypalRef: 'REF1' });
    expect(html).toContain('Refunded');
    expect(html).not.toContain('Approve');
    expect(html).toContain('REF1');
  });

  it('ko: same card in Korean', () => {
    const html = render(action, 'ko');
    expect(html).toContain('환불 요청 · $29.50');
    expect(html).toContain('승인 대기');
    expect(html).toContain('거절');
  });
});

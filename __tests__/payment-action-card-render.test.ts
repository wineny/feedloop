import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentActionCard } from '@/components/inbox/PaymentActionCard';
import type { PaymentActionView } from '@/lib/paypal/action-view';
import type { PaymentPrecedent } from '@/lib/paypal/precedent';
import { getDemoData } from '@/lib/demo/mock-data';
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

const render = (a: PaymentActionView, locale: 'en' | 'ko' = 'en', precedent?: PaymentPrecedent | null) =>
  renderWithIntl(React.createElement(PaymentActionCard, { action: a, onDecide: async () => a, precedent }), locale);

const precedent: PaymentPrecedent = {
  basis: 'check',
  total: 5,
  refunded: 4,
  rejected: 1,
  auto: 2,
  sample: 0,
  evidence: [
    { actionId: 'p1', conversationId: 'c1', href: '/inbox?c=c1', status: 'executed', amount: '$29.50', at: '2026-10-01T00:00:00Z', sample: true },
    { actionId: 'p2', conversationId: 'c2', href: '/inbox?c=c2', status: 'rejected', amount: '$31', at: '2026-09-30T00:00:00Z', sample: false },
  ],
};

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

  it('en: precedent line and evidence links', () => {
    const html = render(action, 'en', precedent);
    expect(html).toContain('you approved 4 of 5');
    expect(html).toContain('2 of them automatically');
    expect(html).toContain('href="/inbox?c=c1"');
    expect(html).toContain('href="/inbox?c=c2"');
    expect(html).toContain('Sample');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('renders nothing about precedent without one', () => {
    expect(render(action)).not.toContain('See past decisions');
    expect(render(action, 'en', null)).not.toContain('See past decisions');
  });

  it('amount basis, no auto part', () => {
    const html = render(action, 'en', { ...precedent, basis: 'amount', auto: 0 });
    expect(html).toContain('Similar amounts: 4 of 5 refunded');
    expect(html).not.toContain('automatically');
  });

  it('ko: precedent renders in Korean', () => {
    const html = render(action, 'ko', precedent);
    expect(html).toContain('5건 중 4건을 승인했어요');
    expect(html).toContain('지난 결정 보기');
  });

  it('sample rows in the count: a muted «from sample data» part (en + ko); none when 0', () => {
    expect(render(action, 'en', precedent)).not.toContain('from sample data');
    const html = render(action, 'en', { ...precedent, sample: 3 });
    expect(html).toContain('you approved 4 of 5');
    expect(html).toContain('· 3 from sample data');
    expect(render(action, 'ko', { ...precedent, sample: 3 })).toContain('· 샘플 데이터 3건 포함');
  });

  it('a sample action shows a Sample chip in the header; a real one does not', () => {
    expect(render(action).match(/>Sample</g)).toBeNull();
    const html = render({ ...action, sample: true });
    expect(html.match(/>Sample</g)).toHaveLength(1);
    expect(html.indexOf('>Sample<')).toBeLessThan(html.indexOf('Waiting for approval'));
    expect(render({ ...action, sample: true }, 'ko')).toContain('>샘플<');
  });

  for (const locale of ['en', 'ko'] as const) {
    it(`${locale} demo inbox: the pending $79 card says the same check, 4 of 5 approved, no «automatically»`, () => {
      const inbox = getDemoData(locale).inbox as {
        payments: Record<string, { actions: PaymentActionView[]; precedents?: Record<string, PaymentPrecedent> }>;
      };
      const [, payment] = Object.entries(inbox.payments).find(([, p]) => p.actions.length > 0)!;
      const card = payment.actions[0];
      const html = render(card, locale, payment.precedents![card.id]);
      if (locale === 'en') {
        expect(html).toContain('Similar requests stopped by the same check: you approved 4 of 5');
        expect(html).not.toContain('automatically');
        expect(html).not.toContain('Similar amounts');
      } else {
        expect(html).toContain('같은 검사에서 멈춘 비슷한 요청: 5건 중 4건을 승인했어요');
      }
      expect(html).toContain('href="/inbox?c=demo-conv-8"');
      expect(html).toContain('href="/inbox?c=demo-conv-9"');
    });
  }
});

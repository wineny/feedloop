import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DashboardPayments } from '@/app/api/dashboard/route';
import { PaymentStats } from '@/components/dashboard/PaymentStats';
import { APPROVALS_HREF, autoRefundAmount, paymentsLayout } from '@/lib/dashboard/payments';
import { getDemoData } from '@/lib/demo/mock-data';
import { renderWithIntl } from './helpers/intl';

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const CONNECTED: DashboardPayments = {
  connected: true,
  connectBotId: null,
  inquiries7d: 12,
  autoRefunds7d: { count: 3, amountCents: 5900, currency: 'USD' },
  pendingApprovals: 2,
};

const UNCONNECTED_OWNER: DashboardPayments = {
  connected: false,
  connectBotId: 'bot-1',
  inquiries7d: 0,
  autoRefunds7d: { count: 0, amountCents: 0, currency: null },
  pendingApprovals: 0,
};

const renderAt = (placement: 'numbers' | 'connect', payments?: DashboardPayments | null, locale: 'en' | 'ko' = 'en') =>
  renderWithIntl(React.createElement(PaymentStats, { payments, placement }), locale);
/** 대시보드는 두 자리에 같은 컴포넌트를 세운다 — 둘을 이어 붙이면 화면에 나오는 PayPal 전부다. */
const render = (payments?: DashboardPayments | null, locale: 'en' | 'ko' = 'en') =>
  renderAt('numbers', payments, locale) + renderAt('connect', payments, locale);

describe('paymentsLayout — which PayPal row the dashboard shows', () => {
  it('connected → numbers, no connect card', () => {
    expect(paymentsLayout(CONNECTED)).toEqual({ kind: 'numbers', connectHref: null });
  });

  it('not connected + an owned bot to connect → connect card to that bot’s PayPal tab', () => {
    expect(paymentsLayout(UNCONNECTED_OWNER)).toEqual({ kind: 'connect', connectHref: '/bots/bot-1/paypal' });
  });

  it('connected + another owned bot not connected → numbers first, connect link second', () => {
    expect(paymentsLayout({ ...CONNECTED, connectBotId: 'bot-2' })).toEqual({ kind: 'numbers', connectHref: '/bots/bot-2/paypal' });
  });

  it('approver on an unconnected bot (no connectBotId) → nothing', () => {
    expect(paymentsLayout({ ...UNCONNECTED_OWNER, connectBotId: null })).toEqual({ kind: 'none' });
  });

  it('no payments block (demo data, 401 empty screen) → nothing', () => {
    expect(paymentsLayout(undefined)).toEqual({ kind: 'none' });
    expect(paymentsLayout(null)).toEqual({ kind: 'none' });
  });
});

describe('autoRefundAmount — same money format as the receipt', () => {
  it('single currency → "$59 USD"', () => {
    expect(autoRefundAmount({ count: 3, amountCents: 5900, currency: 'USD' })).toBe('$59 USD');
    expect(autoRefundAmount({ count: 1, amountCents: 2950, currency: 'USD' })).toBe('$29.50 USD');
  });

  it('zero refunds with a known currency → "$0 USD"', () => {
    expect(autoRefundAmount({ count: 0, amountCents: 0, currency: 'USD' })).toBe('$0 USD');
  });

  it('mixed currency (amount/currency null) or not counted → null, count only', () => {
    expect(autoRefundAmount({ count: 4, amountCents: null, currency: null })).toBeNull();
    expect(autoRefundAmount({ count: 0, amountCents: 0, currency: null })).toBeNull();
    expect(autoRefundAmount(null)).toBeNull();
  });
});

describe('PaymentStats render', () => {
  it('connected: three numbers with captions, approvals link to the Inbox', () => {
    const html = render(CONNECTED);
    expect(html).toContain('Payment inquiries');
    expect(html).toContain('Auto refunds');
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('>12<');
    expect(html).toContain('$59 USD');
    expect(html).toContain(`href="${APPROVALS_HREF}"`);
    expect(html).toContain('Review in Inbox');
    expect(html).not.toContain('Connect PayPal');
  });

  it('no approvals waiting → not a link', () => {
    const html = render({ ...CONNECTED, pendingApprovals: 0 });
    expect(html).not.toContain(`href="${APPROVALS_HREF}"`);
    expect(html).toContain('Nothing waiting');
  });

  it('null = couldn’t count → em dash with an accessible label, never 0', () => {
    const html = render({ ...CONNECTED, inquiries7d: null, autoRefunds7d: null, pendingApprovals: null });
    expect(html.match(/—/g)?.length).toBe(3);
    expect(html).toContain('title="Couldn&#x27;t count"');
    expect(html).toContain('<span class="sr-only">Couldn&#x27;t count</span>');
    expect(html).not.toMatch(/>0</);
    expect(html).not.toContain('Nothing waiting');
    expect(html).not.toContain(`href="${APPROVALS_HREF}"`);
  });

  it('mixed currency → count only, no amount', () => {
    const html = render({ ...CONNECTED, autoRefunds7d: { count: 4, amountCents: null, currency: null } });
    expect(html).toContain('>4<');
    expect(html).not.toContain('USD');
  });

  it('not connected → one Connect PayPal card linking to the PayPal tab, no numbers', () => {
    const html = render(UNCONNECTED_OWNER);
    expect(html).toContain('PayPal isn&#x27;t connected');
    expect(html).toContain('Connect PayPal');
    expect(html).toContain('href="/bots/bot-1/paypal"');
    expect(html).not.toContain('Payment inquiries');
  });

  it('connected + an unconnected owned bot → numbers and a secondary connect link', () => {
    const html = render({ ...CONNECTED, connectBotId: 'bot-2' });
    expect(html).toContain('Payment inquiries');
    expect(html).toContain('href="/bots/bot-2/paypal"');
    expect(html.indexOf('Payment inquiries')).toBeLessThan(html.indexOf('/bots/bot-2/paypal'));
  });

  it('approver on an unconnected bot → renders nothing', () => {
    expect(render({ ...UNCONNECTED_OWNER, connectBotId: null })).toBe('');
    expect(render(undefined)).toBe('');
  });

  it('ko renders the same structure', () => {
    const html = render(CONNECTED, 'ko');
    expect(html).toContain('결제 문의');
    expect(html).toContain('최근 7일');
    expect(render(UNCONNECTED_OWNER, 'ko')).toContain('PayPal 연결하기');
  });
});

describe('PaymentStats placement — numbers go on the first row, the connect card after the checklist', () => {
  it('connected: only the numbers placement renders', () => {
    expect(renderAt('numbers', CONNECTED)).toContain('Payment inquiries');
    expect(renderAt('connect', CONNECTED)).toBe('');
  });

  it('connected + unconnected owned bot: the small connect link stays with the numbers', () => {
    expect(renderAt('numbers', { ...CONNECTED, connectBotId: 'bot-2' })).toContain('href="/bots/bot-2/paypal"');
    expect(renderAt('connect', { ...CONNECTED, connectBotId: 'bot-2' })).toBe('');
  });

  it('not connected: only the connect placement renders', () => {
    expect(renderAt('numbers', UNCONNECTED_OWNER)).toBe('');
    expect(renderAt('connect', UNCONNECTED_OWNER)).toContain('Connect PayPal');
  });
});

describe('sample-data demo dashboard', () => {
  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: carries a connected payments block that renders the three numbers`, () => {
      const payments = (getDemoData(locale).dashboard as { payments: DashboardPayments }).payments;
      expect(payments).toEqual({
        connected: true,
        connectBotId: null,
        inquiries7d: 12,
        autoRefunds7d: { count: 3, amountCents: 4700, currency: 'USD' },
        pendingApprovals: 1,
        refundReasons: expect.any(Object),
      });
      const html = renderAt('numbers', payments, locale);
      expect(html).toContain('>12<');
      expect(html).toContain('$47 USD');
      expect(html).toContain(`href="${APPROVALS_HREF}"`);
      expect(renderAt('connect', payments, locale)).toBe('');
    });
  }
});

describe('onboarding checklist visible — the standalone connect card steps aside', () => {
  const renderConnect = (payments: DashboardPayments, checklistVisible: boolean) =>
    renderWithIntl(React.createElement(PaymentStats, { payments, placement: 'connect', checklistVisible }));

  it('not connected + checklist showing → no standalone card (the checklist’s last step says it)', () => {
    expect(paymentsLayout(UNCONNECTED_OWNER, { checklistVisible: true })).toEqual({ kind: 'none' });
    expect(renderConnect(UNCONNECTED_OWNER, true)).toBe('');
  });

  it('not connected + checklist hidden → the card is back', () => {
    expect(paymentsLayout(UNCONNECTED_OWNER, { checklistVisible: false })).toEqual({ kind: 'connect', connectHref: '/bots/bot-1/paypal' });
    expect(renderConnect(UNCONNECTED_OWNER, false)).toContain('Connect PayPal');
  });

  it('connected → numbers stay whatever the checklist does', () => {
    expect(paymentsLayout({ ...CONNECTED, connectBotId: 'bot-2' }, { checklistVisible: true })).toEqual({
      kind: 'numbers',
      connectHref: '/bots/bot-2/paypal',
    });
  });
});

describe('RefundReasons card — under the PayPal numbers', () => {
  const REASONS: NonNullable<DashboardPayments['refundReasons']> = {
    total: 3,
    buckets: { fix: 1, feature: 0, other: 0, unclassified: 2 },
    top: [
      { key: 'reason:wrong plan', label: 'I bought the wrong plan by mistake.', count: 2, bucket: 'unclassified', href: '/inbox?c=conv-b', external: false },
      { key: 'group:g-1', label: 'Receipt shows the wrong currency', count: 1, bucket: 'fix', href: 'https://github.com/example/demo/pull/128', external: true },
    ],
  };

  it('shows four buckets (zeros included), the top reasons and their links, between the numbers and the ledger', () => {
    const html = renderWithIntl(
      React.createElement(PaymentStats, { payments: { ...CONNECTED, refundReasons: REASONS }, placement: 'numbers', ledger: React.createElement('div', null, 'LEDGER') }),
    );
    expect(html).toContain('Refund reasons');
    expect(html).toContain('3 requests');
    for (const label of ['Bug / UX', 'Feature request', 'Other', 'Not classified yet', 'Goes to a fix PR', 'Goes to a spec']) expect(html).toContain(label);
    expect(html).toContain('Top reasons');
    expect(html).toContain('I bought the wrong plan by mistake.');
    expect(html).toContain('2 requests');
    expect(html).toContain('href="/inbox?c=conv-b"');
    expect(html).toContain('Open conversation');
    expect(html).toMatch(/href="https:\/\/github.com\/example\/demo\/pull\/128" target="_blank" rel="noopener noreferrer"/);
    expect(html).toContain('View fix PR');
    expect(html.indexOf('Auto refunds')).toBeLessThan(html.indexOf('Refund reasons'));
    expect(html.indexOf('Refund reasons')).toBeLessThan(html.indexOf('LEDGER'));
  });

  it('no refund requests → one muted line, no buckets', () => {
    const html = render({ ...CONNECTED, refundReasons: { total: 0, buckets: { fix: 0, feature: 0, other: 0, unclassified: 0 }, top: [] } });
    expect(html).toContain('No refund requests yet.');
    expect(html).not.toContain('Bug / UX');
  });

  it('null → «Couldn’t count», never zeros', () => {
    const html = render({ ...CONNECTED, refundReasons: null });
    expect(html).toContain('Refund reasons');
    expect(html.match(/Couldn&#x27;t count/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain('No refund requests yet.');
    expect(html).not.toContain('Bug / UX');
  });

  it('field missing (older response shape) → no card', () => {
    expect(render(CONNECTED)).not.toContain('Refund reasons');
  });

  it('ko renders the same card', () => {
    const html = render({ ...CONNECTED, refundReasons: REASONS }, 'ko');
    expect(html).toContain('환불 사유');
    expect(html).toContain('버그 / UX');
    expect(html).toContain('수정 PR 보기');
  });

  for (const locale of ['en', 'ko'] as const) {
    it(`${locale} sample data: the ledger's 5 refunds → bug → PR #128, a feature request, an «other», one unclassified`, () => {
      const dashboard = getDemoData(locale).dashboard as { payments: DashboardPayments; ledger: { type: string }[] };
      const reasons = dashboard.payments.refundReasons!;
      expect(reasons.total).toBe(dashboard.ledger.filter((r) => r.type === 'refund').length);
      expect(reasons.buckets).toEqual({ fix: 2, feature: 1, other: 1, unclassified: 1 });
      expect(reasons.top.map((i) => [i.key, i.count, i.bucket, i.href, i.external])).toEqual([
        ['group:demo-group-1', 2, 'fix', 'https://github.com/example/demo/pull/128', true],
        ['insight:demo-ins-refund-team', 1, 'other', '/inbox?c=demo-conv-6', false],
        ['insight:demo-ins-refund-env', 1, 'feature', '/inbox?c=demo-conv-7', false],
      ]);
      const html = renderAt('numbers', dashboard.payments, locale);
      expect(html).toContain('https://github.com/example/demo/pull/128');
    });

    it(`${locale} sample data: refund links match the inbox and the coupon-bug group stays 3 insights · 3 conversations`, () => {
      const data = getDemoData(locale);
      const dashboard = data.dashboard as {
        ledger: { type: string; at: string; conversationId: string | null }[];
        groups: { id: string; createdAt: string; insightCount: number; conversationCount: number }[];
        feedbacks: { createdAt: string; insight: { id: string } | null }[];
      };
      const inbox = data.inbox as { conversations: { id: string }[]; timelines: Record<string, unknown[]> };
      const inboxIds = new Set(inbox.conversations.map((c) => c.id));
      for (const row of dashboard.ledger) if (row.conversationId) expect(inboxIds.has(row.conversationId)).toBe(true);

      const group = dashboard.groups.find((g) => g.id === 'demo-group-1')!;
      expect(group).toMatchObject({ insightCount: 3, conversationCount: 3 });
      // the coupon-bug refunds (conv-4, conv-5) are newer than the first coupon report and the group itself
      const firstReport = Math.min(...dashboard.feedbacks.filter((f) => ['demo-ins-1', 'demo-ins-6', 'demo-ins-7'].includes(f.insight?.id ?? '')).map((f) => Date.parse(f.createdAt)));
      const couponRefunds = dashboard.ledger.filter((r) => r.type === 'refund' && ['demo-conv-4', 'demo-conv-5'].includes(r.conversationId ?? ''));
      expect(couponRefunds).toHaveLength(2);
      for (const r of couponRefunds) {
        expect(Date.parse(r.at)).toBeGreaterThan(firstReport);
        expect(Date.parse(r.at)).toBeGreaterThan(Date.parse(group.createdAt));
      }
    });
  }
});

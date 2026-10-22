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
      });
      const html = renderAt('numbers', payments, locale);
      expect(html).toContain('>12<');
      expect(html).toContain('$47 USD');
      expect(html).toContain(`href="${APPROVALS_HREF}"`);
      expect(renderAt('connect', payments, locale)).toBe('');
    });
  }
});

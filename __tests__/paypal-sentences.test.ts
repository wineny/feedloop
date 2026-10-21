// Stage 3 task 5: the server-fixed sentences a visitor reads about money, and how the widget finds the link.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PAYPAL_URL_LINE,
  checkoutLine,
  refundExecutedLine,
  refundFailedLine,
  refundPendingLine,
  refundProcessingLine,
  refundRejectedLine,
} from '@/lib/paypal/sentences';

describe('payment sentences', () => {
  it('are English, carry the amount, and never Korean', () => {
    const all = [
      refundPendingLine('$29'),
      refundExecutedLine('$29', 'auto'),
      refundExecutedLine('$29', 'approval'),
      refundProcessingLine('$29'),
      refundFailedLine('$29'),
      refundRejectedLine('$29'),
    ];
    for (const s of all) {
      expect(s).toContain('$29');
      expect(s).not.toMatch(/[가-힣]/);
    }
    expect(refundExecutedLine('$29', 'approval')).toMatch(/approved/);
    expect(refundExecutedLine('$29', 'auto')).not.toMatch(/approved/);
  });

  it('checkout line ends with the approve URL on its own line; quantity shown only above 1', () => {
    const one = checkoutLine({ amount: '$29', product: 'Pro', quantity: 1, approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=X' });
    expect(one).toBe('Pay with PayPal — $29 · Pro\nhttps://www.sandbox.paypal.com/checkoutnow?token=X');
    expect(PAYPAL_URL_LINE.test(one)).toBe(true);
    const two = checkoutLine({ amount: '$58', product: 'Pro', quantity: 2, approveUrl: 'https://www.paypal.com/x' });
    expect(two.startsWith('Pay with PayPal — $58 · Pro × 2\n')).toBe(true);
    expect(PAYPAL_URL_LINE.test(refundPendingLine('$1'))).toBe(false);
  });
});

describe('widget.js — payment card', () => {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

  it('draws kind=payment as a card and only buttons a paypal.com https link', () => {
    expect(src).toContain("it.kind === 'payment'");
    expect(src).toContain('function paymentCard(');
    expect(src).toContain("h === 'paypal.com' || /\\.paypal\\.com$/.test(h)");
    expect(src).toContain("'Pay with PayPal'");
    expect(src).toContain("a.rel = 'noopener noreferrer'");
  });
});

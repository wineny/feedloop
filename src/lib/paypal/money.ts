// Pure helpers shared by server code and the pricing page's client button. No Node imports here.

/** 2900 → "29.00". Integer math, no floats — this is the value sent to PayPal. */
export function centsToValue(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${whole}.${rest}`;
}

/** 900 USD → "$9", 2950 USD → "$29.50". For display only. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** https and a paypal.com host (www.paypal.com, www.sandbox.paypal.com, …). */
export function isPayPalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}

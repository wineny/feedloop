// Pure helpers shared by server code and the pricing page's client button. No Node imports here.

/** 2900 → "29.00". Integer math, no floats — this is the value sent to PayPal. */
export function centsToValue(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${whole}.${rest}`;
}

/**
 * "29.00" → 2900, the inverse of centsToValue for values PayPal sends back. Integer math on the
 * string; null for anything that is not `digits[.digits{0,2}]` (a malformed amount must never
 * become a refund amount).
 */
export function valueToCents(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
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

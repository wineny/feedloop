// Refund Studio's sample store — a fixed, seeded dataset for the AG Studio page only.
//
// Why a separate sample: the dashboard's demo ledger has 5 refunds and 3 purchases from the last two days,
// which is too small for a refund rate, a daily trend or a "last 7 days vs the 7 before" comparison.
// This one covers 90 days of a small store (Starter $9 · Pro $29 · Agency $79, same as the demo shop) and is
// always labelled "Sample store data" on screen (ny decision 2026-11-01). Nothing here is measured.
//
// Same output on every call for the same day: refunds are listed by hand, purchases come from a seeded PRNG.
// Dates are relative to today so "last 7 days" stays recent. Pure — no Node imports.

export type RefundBucket = 'Bug / UX' | 'Feature request' | 'Other' | 'Not classified yet';
export type FixStatus = 'PR merged' | 'PR open' | 'Spec drafted' | 'No fix needed' | 'Waiting for review';

export interface SamplePayment {
  id: string;
  date: string; // YYYY-MM-DD
  product: 'Starter' | 'Pro' | 'Agency';
  amount: number; // USD
  refundedAmount: number; // USD, 0 unless refunded
  status: 'Captured' | 'Refunded';
}

export interface SampleRefund {
  id: string;
  paymentId: string;
  date: string;
  /** Monday of the refund's week (YYYY-MM-DD), for weekly charts that should not show empty weeks. */
  weekStart: string;
  product: SamplePayment['product'];
  amount: number;
  reasonKey: string;
  reason: string;
  bucket: RefundBucket;
  fixStatus: FixStatus;
  /** Fix PR or spec. Sample addresses are github.com/example/… and are never rendered as links (isSampleUrl). */
  fixUrl: string | null;
}

export interface SampleReason {
  key: string;
  label: string;
  bucket: RefundBucket;
  fixStatus: FixStatus;
  fixUrl: string | null;
  product: SamplePayment['product'];
  /** Days ago of each refund for this reason. */
  daysAgo: number[];
}

const PRICE: Record<SamplePayment['product'], number> = { Starter: 9, Pro: 29, Agency: 79 };

/** The reasons, as the dashboard's demo bot classified them. Coupon bug refunds pile up in the last week. */
export const SAMPLE_REASONS: SampleReason[] = [
  {
    key: 'coupon-bug',
    label: 'Tapping “Get coupon” doesn’t issue a coupon',
    bucket: 'Bug / UX',
    fixStatus: 'PR merged',
    fixUrl: 'https://github.com/example/demo/pull/128',
    product: 'Starter',
    daysAgo: [0, 1, 1, 2, 3, 4, 5, 6, 20],
  },
  {
    key: 'env-sync',
    label: 'Expected Pro to sync Vercel environment variables',
    bucket: 'Feature request',
    fixStatus: 'Spec drafted',
    fixUrl: null,
    product: 'Pro',
    daysAgo: [9, 27, 45, 70],
  },
  {
    key: 'dark-mode',
    label: 'Dark mode code block theme conflict',
    bucket: 'Bug / UX',
    fixStatus: 'PR open',
    fixUrl: 'https://github.com/example/feedloop-demo/pull/129',
    product: 'Pro',
    daysAgo: [12, 33, 58],
  },
  {
    key: 'team-smaller',
    label: 'Team got smaller, no longer needs Agency',
    bucket: 'Other',
    fixStatus: 'No fix needed',
    fixUrl: null,
    product: 'Agency',
    daysAgo: [24, 66, 81],
  },
  {
    key: 'paid-twice',
    label: 'Paid twice by mistake',
    bucket: 'Other',
    fixStatus: 'No fix needed',
    fixUrl: null,
    product: 'Pro',
    daysAgo: [16, 52],
  },
  {
    key: 'unclassified',
    label: 'Not classified yet',
    bucket: 'Not classified yet',
    fixStatus: 'Waiting for review',
    fixUrl: null,
    product: 'Starter',
    daysAgo: [3, 38, 61, 77],
  },
];

export const SAMPLE_DAYS = 90;
const PURCHASE_TARGET = 200;

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dayString = (today: Date, daysAgo: number) => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysAgo));
  return d.toISOString().slice(0, 10);
};

const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export interface SampleStore {
  asOf: string;
  from: string;
  payments: SamplePayment[];
  refunds: SampleRefund[];
}

export function buildSampleStore(today: Date = new Date()): SampleStore {
  const rand = prng(20261101);
  const payments: SamplePayment[] = [];
  const refunds: SampleRefund[] = [];

  // Each refund gets its own purchase, 0–4 days before it (inside the 90-day window).
  let n = 0;
  for (const reason of SAMPLE_REASONS) {
    for (const ago of reason.daysAgo) {
      n += 1;
      const paidAgo = Math.min(SAMPLE_DAYS - 1, ago + Math.floor(rand() * 5));
      const amount = PRICE[reason.product];
      const paymentId = `PAY-${String(n).padStart(3, '0')}`;
      payments.push({ id: paymentId, date: dayString(today, paidAgo), product: reason.product, amount, refundedAmount: amount, status: 'Refunded' });
      refunds.push({
        id: `REF-${String(n).padStart(3, '0')}`,
        paymentId,
        date: dayString(today, ago),
        weekStart: mondayOf(dayString(today, ago)),
        product: reason.product,
        amount,
        reasonKey: reason.key,
        reason: reason.label,
        bucket: reason.bucket,
        fixStatus: reason.fixStatus,
        fixUrl: reason.fixUrl,
      });
    }
  }

  // The rest are plain purchases: mostly Starter, some Pro, a few Agency.
  while (payments.length < PURCHASE_TARGET) {
    n += 1;
    const r = rand();
    const product: SamplePayment['product'] = r < 0.55 ? 'Starter' : r < 0.9 ? 'Pro' : 'Agency';
    const ago = Math.floor(rand() * SAMPLE_DAYS);
    payments.push({ id: `PAY-${String(n).padStart(3, '0')}`, date: dayString(today, ago), product, amount: PRICE[product], refundedAmount: 0, status: 'Captured' });
  }

  payments.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
  refunds.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));
  return { asOf: dayString(today, 0), from: dayString(today, SAMPLE_DAYS - 1), payments, refunds };
}

/** Refund counts per reason: the last `windowDays` vs the `windowDays` before. Shared by the widget and the agent tool. */
export interface ReasonWindow {
  reasonKey: string;
  reason: string;
  bucket: RefundBucket;
  fixStatus: FixStatus;
  fixUrl: string | null;
  recent: number;
  previous: number;
  total: number;
}

export function reasonWindows(
  refunds: Pick<SampleRefund, 'date' | 'reasonKey' | 'reason' | 'bucket' | 'fixStatus' | 'fixUrl'>[],
  asOf: string,
  windowDays = 7,
): ReasonWindow[] {
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const day = 86_400_000;
  const by = new Map<string, ReasonWindow>();
  for (const r of refunds) {
    const ago = Math.round((end - Date.parse(`${r.date}T00:00:00Z`)) / day);
    const w = by.get(r.reasonKey) ?? {
      reasonKey: r.reasonKey, reason: r.reason, bucket: r.bucket, fixStatus: r.fixStatus, fixUrl: r.fixUrl,
      recent: 0, previous: 0, total: 0,
    };
    w.total += 1;
    if (ago >= 0 && ago < windowDays) w.recent += 1;
    else if (ago >= windowDays && ago < windowDays * 2) w.previous += 1;
    by.set(r.reasonKey, w);
  }
  return [...by.values()].sort((a, b) => b.recent - a.recent || b.total - a.total || a.reasonKey.localeCompare(b.reasonKey));
}

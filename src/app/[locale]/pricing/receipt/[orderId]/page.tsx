// /pricing/receipt/[orderId] — where the return route lands after capture. Reads the
// paypal_orders row only (never PayPal from here): the return route and the webhook keep it current.

import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Clock, RotateCcw, XCircle } from 'lucide-react';
import { AutoRefresh } from '@/components/pricing/AutoRefresh';
import { DemoWidget } from '@/components/pricing/DemoWidget';
import { PricingHeader } from '@/components/pricing/PricingHeader';
import { ORDER_ID_RE } from '@/lib/paypal/capture';
import { formatMoney, isPayPalUrl } from '@/lib/paypal/money';
import { RECEIPT_TONE, isSettling, refundFacts, showsQuestions } from '@/lib/pricing/receipt';
import { loadReceipt, maskEmail } from '@/lib/pricing/shop';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/[locale]/pricing/receipt/[orderId]'>): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return { title: t('receiptTitle'), robots: { index: false, follow: false } };
}

interface RowProps {
  label: string;
  value: string | null;
}

function Row({ label, value }: RowProps) {
  if (!value) return null;
  return (
    <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!ORDER_ID_RE.test(orderId)) notFound();
  const order = await loadReceipt(orderId);
  if (!order) notFound();

  const t = await getTranslations('pricing.receipt');
  const format = await getFormatter();
  const tone = RECEIPT_TONE[order.status];
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'wait' ? Clock : tone === 'refund' ? RotateCcw : XCircle;
  const iconColor =
    tone === 'ok' ? 'text-emerald-600' : tone === 'wait' ? 'text-amber-600' : tone === 'refund' ? 'text-sky-600' : 'text-muted-foreground';
  const item = order.product_name ? (order.quantity > 1 ? `${order.product_name} × ${order.quantity}` : order.product_name) : null;
  // `expired` keeps the button too: the cancel URL needs no login, so someone holding the order id
  // could mark it expired — the buyer must still be able to finish paying.
  const resumeUrl =
    (order.status === 'created' || order.status === 'expired') && isPayPalUrl(order.approve_url) ? order.approve_url : null;
  const settling = isSettling(order.status);
  const date = order.captured_at ?? order.created_at;
  const refund = refundFacts(order);
  const money = (cents: number | null) => (cents === null ? null : `${formatMoney(cents, order.currency)} ${order.currency}`);

  return (
    <div className="flex flex-col gap-10">
      <PricingHeader />

      <section className="mx-auto flex w-full max-w-[560px] flex-col gap-6 rounded-2xl border border-border bg-background p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <Icon className={cn('mt-0.5 size-7 shrink-0', iconColor)} aria-hidden />
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-foreground">{t(`${order.status}.title`)}</h1>
            <p className="text-sm leading-6 text-muted-foreground">{t(`${order.status}.body`)}</p>
          </div>
        </div>

        <dl className="flex flex-col">
          <Row label={t('item')} value={item} />
          <Row label={t('total')} value={money(order.amount_cents)} />
          {refund ? (
            <>
              <Row label={t(refund.kind === 'reversed' ? 'reversedAmount' : 'refundedAmount')} value={money(refund.refundedCents)} />
              <Row label={t('remaining')} value={money(refund.remainingCents)} />
            </>
          ) : null}
          <Row label={t('orderId')} value={order.order_id} />
          <Row label={t('transactionId')} value={order.capture_id} />
          <Row label={t('paidWith')} value={maskEmail(order.payer_email)} />
          <Row label={t('date')} value={format.dateTime(new Date(date), { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' })} />
          {refund?.recordedAt ? (
            // When Feedloop saw the change, not PayPal's refund time — so the day only, labeled "recorded".
            <Row
              label={t(refund.kind === 'reversed' ? 'reversalRecorded' : 'refundRecorded')}
              value={format.dateTime(new Date(refund.recordedAt), { dateStyle: 'medium', timeZone: 'UTC' })}
            />
          ) : null}
        </dl>

        {showsQuestions(order.status) ? (
          <p className="rounded-xl bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
            {t('questions')}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {resumeUrl ? (
            <a href={resumeUrl} className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground">
              {t('continue')}
            </a>
          ) : null}
          <Link href="/pricing" className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-semibold text-foreground">
            {t('back')}
          </Link>
        </div>
      </section>

      {settling ? <AutoRefresh /> : null}
      <DemoWidget botId={order.bot_id} />
    </div>
  );
}

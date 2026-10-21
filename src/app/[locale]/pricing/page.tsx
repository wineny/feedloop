// /pricing — the PayPal demo shop (design v2 §1). Feedloop sells its own plans as one-time
// sandbox purchases; the shop's support is the demo bot's widget in the corner.
// Products and prices come from the `products` table of the demo bot (bots.is_demo), nothing else.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Check } from 'lucide-react';
import { BuyButton } from '@/components/pricing/BuyButton';
import { DemoWidget } from '@/components/pricing/DemoWidget';
import { PricingHeader } from '@/components/pricing/PricingHeader';
import { formatMoney } from '@/lib/paypal/money';
import { loadDemoShop } from '@/lib/pricing/shop';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/[locale]/pricing'>): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return { title: t('pricingTitle'), description: t('pricingDescription') };
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ canceled?: string }> }) {
  const { canceled } = await searchParams;
  const t = await getTranslations('pricing');
  const shop = await loadDemoShop();

  return (
    <div className="flex flex-col gap-10">
      <PricingHeader />

      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-extrabold tracking-[-0.03em] text-foreground sm:text-4xl">{t('title')}</h1>
        <p className="max-w-[640px] text-base leading-7 text-muted-foreground">
          {t('intro')}
        </p>
      </section>

      {canceled === '1' ? (
        <p role="status" className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
          {t('canceled')}
        </p>
      ) : null}

      {!shop || shop.products.length === 0 ? (
        <p className="rounded-xl border border-border bg-background px-4 py-6 text-sm text-muted-foreground">
          {t.rich('notSetUp', { code: (chunks) => <code>{chunks}</code> })}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3 md:gap-6">
          {shop.products.map((p, i) => (
            <article
              key={p.id}
              className={cn(
                'flex flex-col gap-5 rounded-2xl border bg-background p-6',
                i === 1 ? 'border-[#F2645C] shadow-[0_8px_30px_rgba(242,100,92,0.12)]' : 'border-border',
              )}
            >
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-bold text-foreground">{p.name}</h2>
                <p className="flex items-baseline gap-1.5">
                  <span className="text-4xl font-extrabold tracking-[-0.03em] text-foreground">
                    {formatMoney(p.amount_cents, p.currency)}
                  </span>
                  <span className="text-sm text-muted-foreground">{t('oneTime')}</span>
                </p>
              </div>
              {p.description ? (
                <p className="flex gap-2 text-sm leading-6 text-muted-foreground">
                  <Check className="mt-1 size-4 shrink-0 text-[#F2645C]" aria-hidden />
                  {p.description}
                </p>
              ) : null}
              <div className="mt-auto">
                <BuyButton botId={shop.botId} productId={p.id} productName={p.name} />
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        Payments run in the PayPal sandbox during the PayPal AI Hackathon. Prices are placeholders and no real money moves.
      </p>

      {shop ? <DemoWidget botId={shop.botId} /> : null}
    </div>
  );
}

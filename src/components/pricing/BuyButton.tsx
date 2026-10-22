'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { isPayPalUrl } from '@/lib/paypal/money';

/**
 * Opens a PayPal order on the server and sends the buyer to PayPal's approval page.
 * The page never sees a price it could change: the server reads it from `products`.
 */
interface BuyButtonProps {
  botId: string;
  productId: string;
  productName: string;
}

export function BuyButton({ botId, productId, productName }: BuyButtonProps) {
  const t = useTranslations('pricing.buy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleBuy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/paypal/checkout/${botId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, quantity: 1 }),
      });
      const data = (await res.json().catch(() => ({}))) as { approve_url?: unknown; error?: string };
      if (!res.ok || !isPayPalUrl(data.approve_url)) {
        throw new Error(data.error ?? t('failed'));
      }
      window.location.assign(data.approve_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={handleBuy} disabled={busy} size="lg" className="w-full" aria-label={t('aria', { name: productName })}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {busy ? t('opening') : t('button')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

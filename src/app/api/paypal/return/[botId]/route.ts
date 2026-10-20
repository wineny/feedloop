// GET /api/paypal/return/[botId]?token=<orderId>&PayerID=… — where PayPal sends the buyer after
// approval. Captures (idempotent, see lib/paypal/capture.ts) and redirects to the receipt.
// Refreshing this URL or racing the CHECKOUT.ORDER.APPROVED webhook is safe.

import { NextRequest, NextResponse } from 'next/server';
import { checkReadRate, isUuid } from '@/lib/widget/http';
import { resolvePayPalBot } from '@/lib/paypal/bot';
import { captureCheckout, ORDER_ID_RE } from '@/lib/paypal/capture';
import { appOrigin } from '@/lib/paypal/checkout';
import { supabasePaymentsStore } from '@/lib/paypal/store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const orderId = req.nextUrl.searchParams.get('token') ?? '';
  if (!isUuid(botId) || !ORDER_ID_RE.test(orderId)) {
    return NextResponse.json({ error: 'Unknown order.' }, { status: 404 });
  }
  const limited = checkReadRate(req);
  if (limited) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const resolved = await resolvePayPalBot(botId);
  if (!resolved.ok) return NextResponse.json({ error: 'Unknown order.' }, { status: 404 });

  const result = await captureCheckout(
    { store: supabasePaymentsStore(), paypal: resolved.bot.client },
    { botId, orderId },
  );
  if (!result.ok && result.error === 'not_found') {
    return NextResponse.json({ error: 'Unknown order.' }, { status: 404 });
  }
  // Every other outcome (captured, pending, declined, PayPal hiccup) is shown by the receipt,
  // which reads the row — so a webhook that wins the race still shows up as paid.
  return NextResponse.redirect(`${appOrigin()}/pricing/receipt/${orderId}`, 303);
}

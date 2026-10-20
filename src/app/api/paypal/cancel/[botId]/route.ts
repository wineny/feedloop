// GET /api/paypal/cancel/[botId]?token=<orderId> — the buyer pressed "Cancel and return" on PayPal.
// Marks an untouched order `expired` and goes back to the pricing page. Never un-captures anything.

import { NextRequest, NextResponse } from 'next/server';
import { checkReadRate, isUuid } from '@/lib/widget/http';
import { cancelCheckout, ORDER_ID_RE } from '@/lib/paypal/capture';
import { appOrigin } from '@/lib/paypal/checkout';
import { supabasePaymentsStore } from '@/lib/paypal/store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  const orderId = req.nextUrl.searchParams.get('token') ?? '';
  const back = NextResponse.redirect(`${appOrigin()}/pricing?canceled=1`, 303);
  if (!isUuid(botId) || !ORDER_ID_RE.test(orderId)) return back;
  if (checkReadRate(req)) return back;
  try {
    await cancelCheckout(supabasePaymentsStore(), { botId, orderId });
  } catch (err) {
    console.error('[paypal] cancel mark failed', { orderId, message: (err as Error).message });
  }
  return back;
}

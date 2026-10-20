// Server-side reads for the PayPal demo shop pages. Prices come from `products` only.

import { getServiceRoleClient } from '@/lib/supabase';
import type { OrderRow, ProductRow } from '@/lib/paypal/store';

export type ShopProduct = Pick<ProductRow, 'id' | 'sku' | 'name' | 'description' | 'amount_cents' | 'currency'>;

export interface DemoShop {
  botId: string;
  products: ShopProduct[];
}

/** The one demo bot (bots.is_demo) and its active products in display order. null = not seeded. */
export async function loadDemoShop(): Promise<DemoShop | null> {
  const db = getServiceRoleClient();
  const { data: bot, error } = await db
    .from('bots')
    .select('id, status')
    .eq('is_demo', true)
    .maybeSingle();
  if (error) console.error('[pricing] demo bot lookup failed', { code: error.code, message: error.message });
  if (!bot || bot.status === 'paused') return null;

  const { data: products, error: pErr } = await db
    .from('products')
    .select('id, sku, name, description, amount_cents, currency')
    .eq('bot_id', bot.id)
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (pErr) console.error('[pricing] products lookup failed', { code: pErr.code, message: pErr.message });

  return { botId: bot.id, products: (products as ShopProduct[] | null) ?? [] };
}

export type Receipt = Pick<
  OrderRow,
  'order_id' | 'bot_id' | 'status' | 'quantity' | 'amount_cents' | 'currency' | 'capture_id' | 'payer_email' | 'approve_url' | 'created_at' | 'captured_at'
> & { product_name: string | null };

export async function loadReceipt(orderId: string): Promise<Receipt | null> {
  const { data, error } = await getServiceRoleClient()
    .from('paypal_orders')
    .select(
      'order_id, bot_id, status, quantity, amount_cents, currency, capture_id, payer_email, approve_url, created_at, captured_at, products(name)',
    )
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) console.error('[pricing] receipt lookup failed', { code: error.code, message: error.message });
  if (!data) return null;
  const { products, ...row } = data as unknown as Omit<Receipt, 'product_name'> & {
    products: { name: string } | { name: string }[] | null;
  };
  const product = Array.isArray(products) ? products[0] : products;
  return { ...row, product_name: product?.name ?? null };
}

/** "sb-ujvrd53435658@personal.example.com" → "s•••@personal.example.com". The receipt URL is shareable. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

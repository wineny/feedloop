// PayPal sandbox smoke test. Run: npx tsx scripts/paypal-smoke.ts
// Checks that credentials work and that an order can be created.
// It deliberately does NOT capture or refund; that belongs to later stages.

import * as dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';
import { paypalClientFromEnv } from '../src/lib/paypal/client';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const client = paypalClientFromEnv();
  const { scope } = await client.getAccessToken();
  console.log(`token OK, scope count: ${scope.split(' ').filter(Boolean).length}`);

  const order = await client.createOrder({
    amountValue: '1.00',
    currencyCode: 'USD',
    description: 'Feedloop smoke test',
    returnUrl: 'https://example.com/return',
    cancelUrl: 'https://example.com/cancel',
    requestId: `smoke-${randomUUID()}`,
  });
  console.log(`order id: ${order.id}`);
  console.log(`status: ${order.status}`);
  console.log(`approve url: ${order.approveUrl}`);
}

main().catch((e) => {
  const err = e as { name?: string; message?: string; status?: number; debugId?: string };
  console.error(`smoke failed: ${err.name} ${err.status ?? ''} ${err.message} ${err.debugId ?? ''}`);
  process.exit(1);
});

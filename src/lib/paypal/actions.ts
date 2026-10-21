// payment_actions reads shared by the widget route. Writes (the guardrail RPC, execution,
// approval) live in the refund code; this file stays small so the router's dependency is cheap.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/supabase';

/** Statuses that mean "something about money is still in flight for this conversation". */
export const OPEN_ACTION_STATUSES = ['pending', 'executing'] as const;

/**
 * True when this conversation has a refund waiting for approval or mid-execution. The router
 * then keeps the visitor on the payment path even for a message with no money words ("any news?").
 * Throws on a database error; the route treats that as "no open action" and logs it.
 */
export async function hasOpenPaymentAction(
  conversationId: string,
  db: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await db
    .from('payment_actions')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('status', [...OPEN_ACTION_STATUSES])
    .limit(1);
  if (error) throw new Error(`[payment_actions] open-action lookup failed: ${error.code ?? ''} ${error.message}`.trim());
  return (data?.length ?? 0) > 0;
}

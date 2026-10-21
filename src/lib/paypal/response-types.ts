// `responses.response_type` values the payment flow writes. The column is free text
// (init_schema.sql); the full value set is documented on the column comment in
// supabase/migrations/20261019_01_paypal_foundation.sql.
//
// Dependency-free on purpose: the widget route, the router and the timeline code all read these.

/**
 * A conversational reply written by the payment agent (an LLM turn that may have called tools).
 * The widget renders it as an ordinary AI bubble; the router reads it as "the previous reply
 * came from the payment agent", so a bare follow-up like "abc@example.com" stays on the payment path.
 */
export const PAYMENT_AGENT_RESPONSE_TYPE = 'payment_agent';

/**
 * A server-fixed sentence about money (refund done / waiting for approval / declined / failed)
 * plus the widget card. Never LLM text. Written by the stage-2 store and the stage-3 outcome code.
 */
export const PAYMENT_RESPONSE_TYPE = 'payment';

export function isPaymentResponseType(responseType: string | null | undefined): boolean {
  return responseType === PAYMENT_AGENT_RESPONSE_TYPE || responseType === PAYMENT_RESPONSE_TYPE;
}

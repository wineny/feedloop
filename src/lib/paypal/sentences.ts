// The sentences a visitor reads about money (design v2 §2, §5 — `response_type='payment'`).
//
// Server-fixed, English, never model output: a refund "done" is only ever announced by the code
// path that saw PayPal say COMPLETED, a "waiting" only by the path that wrote the pending row, and so
// on. The payment agent may add a short friendly sentence of its own, but the facts come from here.
//
// A checkout line carries the approve URL on its own last line. The widget turns that line into the
// "Pay with PayPal" button after checking the host (paypal.com) — the URL is server data from
// createCheckout, never text the model produced. Dependency-free: the widget route, refund code and
// tests all import it.

/** A line that is exactly one https URL — the widget renders it as the PayPal button. */
export const PAYPAL_URL_LINE = /^https:\/\/\S+$/m;

export function refundPendingLine(amount: string): string {
  return `Your refund request for ${amount} is waiting for the store's approval. You'll see the result here.`;
}

export function refundExecutedLine(amount: string, origin: 'auto' | 'approval'): string {
  return origin === 'approval'
    ? `Your refund of ${amount} was approved and sent to PayPal. It usually shows up within a few days.`
    : `Refund of ${amount} sent to PayPal. It usually shows up within a few days.`;
}

export function refundProcessingLine(amount: string): string {
  return `Your ${amount} refund is being processed. We'll confirm here once PayPal answers.`;
}

export function refundFailedLine(amount: string): string {
  return `We couldn't complete the ${amount} refund through PayPal. The store will follow up here.`;
}

export function refundRejectedLine(amount: string): string {
  return `The store reviewed your refund request for ${amount} and didn't approve it.`;
}

/** "Pay with PayPal — $29 · Pro" + the approve URL on its own line. */
export function checkoutLine(input: { amount: string; product: string; quantity: number; approveUrl: string }): string {
  const what = input.quantity > 1 ? `${input.product} × ${input.quantity}` : input.product;
  return `Pay with PayPal — ${input.amount} · ${what}\n${input.approveUrl}`;
}

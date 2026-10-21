/**
 * The PayPal demo shop (`/pricing`, `/pricing/receipt/…`) is a logged-out shop page with its
 * own header and the demo bot's widget. The global navigation and the self widget step
 * aside there — two widgets would stack in the same corner (widget.js has no double-load guard).
 */
export function isPricingPath(pathname: string | null | undefined): boolean {
  return pathname === '/pricing' || Boolean(pathname?.startsWith('/pricing/'));
}

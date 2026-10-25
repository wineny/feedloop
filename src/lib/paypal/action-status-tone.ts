// Badge colours for a payment_actions status — the inbox approval card and the dashboard ledger use the same
// ones. Tailwind classes only; no React, so the ledger does not have to import the approval card.

import type { PaymentActionStatus } from './store';

export const ACTION_STATUS_TONE: Record<PaymentActionStatus, string> = {
  pending: 'bg-brand-subtle text-brand-strong',
  executing: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
  executed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-destructive/10 text-destructive',
  rejected: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
};

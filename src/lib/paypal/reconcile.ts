// The reaper: finishes payment_actions rows a crash or a lost PayPal answer left behind, and expires
// approval requests nobody answered.
//
// Where it runs: the daily cron (piggybacked on /api/cron/check-merged — the Hobby plan has two cron
// slots and both are taken), and in pieces from the webhook (PAYMENT.CAPTURE.REFUNDED) and the visitor
// tools (a stuck row they meet). The per-row logic is refund.ts#reconcileAction; this file chooses
// which rows, in a fair order, within a time budget, and tallies.
//
// Fairness: every row the sweep looks at is stamped (reconcile_attempted_at) before it is tried, even
// when its bot has no PayPal client. The next sweep takes never-stamped rows first and then the least
// recently stamped, so fifty rows that stay PENDING at PayPal cannot hide a newer row forever.

import type { PayPalClient } from './client';
import { reconcileAction } from './refund';
import type { PaymentsStore } from './store';

/** A row is "stuck" once this long has passed since its last change. Below that it may still be in flight. */
export const STUCK_AFTER_MS = 10 * 60_000;
/** A row tried this recently is left for the next sweep (backoff for PENDING / unreachable). */
export const RETRY_AFTER_MS = 10 * 60_000;
/** Approval requests older than this expire (design §4: 24 h reminder, 7 days expired). */
export const PENDING_EXPIRES_AFTER_MS = 7 * 24 * 60 * 60_000;
export const SWEEP_LIMIT = 50;
/** Wall-clock budget for one sweep; the cron route allows 120 s and the merge check needs some. */
export const SWEEP_BUDGET_MS = 60_000;

export interface SweepDeps {
  store: PaymentsStore;
  /** The PayPal client for a bot, or null when the bot has no PayPal connection (row skipped). */
  paypalFor: (botId: string) => Promise<PayPalClient | null>;
  now?: () => Date;
}

export interface SweepResult {
  expired: number;
  scanned: number;
  executed: number;
  failed: number;
  stillPending: number;
  unreachable: number;
  skipped: number;
  /** A row that threw while being reconciled; the sweep went on with the next one. */
  errors: number;
  /** Rows selected but not tried because the time budget ran out; they keep their place for next time. */
  deferred: number;
}

export async function sweepStuckActions(
  deps: SweepDeps,
  opts: { stuckAfterMs?: number; retryAfterMs?: number; expireAfterMs?: number; limit?: number; budgetMs?: number } = {},
): Promise<SweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const result: SweepResult = {
    expired: 0, scanned: 0, executed: 0, failed: 0, stillPending: 0, unreachable: 0, skipped: 0, errors: 0, deferred: 0,
  };

  result.expired = await deps.store.expirePendingActions({
    olderThan: new Date(now.getTime() - (opts.expireAfterMs ?? PENDING_EXPIRES_AFTER_MS)).toISOString(),
  });

  const stuck = await deps.store.listStuckActions({
    olderThan: new Date(now.getTime() - (opts.stuckAfterMs ?? STUCK_AFTER_MS)).toISOString(),
    notAttemptedSince: new Date(now.getTime() - (opts.retryAfterMs ?? RETRY_AFTER_MS)).toISOString(),
    limit: opts.limit ?? SWEEP_LIMIT,
  });
  // One bot's client is built once per sweep; a bot with no PayPal is asked once.
  const clients = new Map<string, PayPalClient | null>();

  for (const action of stuck) {
    if (Date.now() - startedAt > budgetMs) {
      result.deferred = stuck.length - result.scanned;
      break;
    }
    result.scanned += 1;
    try {
      // Stamp first: a row that throws or is skipped still rotates to the back.
      await deps.store.markReconcileAttempt(action.id);
      if (!clients.has(action.bot_id)) clients.set(action.bot_id, await deps.paypalFor(action.bot_id));
      const paypal = clients.get(action.bot_id) ?? null;
      if (!paypal) {
        result.skipped += 1;
        continue;
      }
      const outcome = await reconcileAction({ store: deps.store, paypal }, action);
      if (outcome.status === 'executed') result.executed += 1;
      else if (outcome.status === 'failed') result.failed += 1;
      else if (outcome.status === 'still_pending' || outcome.status === 'unknown') result.stillPending += 1;
      else if (outcome.status === 'unreachable') result.unreachable += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errors += 1;
      console.error('[paypal] sweep: reconcile threw', { actionId: action.id, message: (err as Error).message });
    }
  }
  return result;
}

// F2 triage — a label the grouping model proposes per group. Display only: nothing here
// opens a PR, dismisses a group, or replies to anyone.

import { getServiceRoleClient } from '@/lib/supabase';

export const TRIAGE_VALUES = ['fix', 'wont_fix', 'needs_decision'] as const;
export type Triage = (typeof TRIAGE_VALUES)[number];

/** One-line reason cap, so a long model answer cannot flood the list. */
export const TRIAGE_REASON_MAX = 200;

/** Valid verdict (+ optional one-line reason) from raw model fields, or null when the verdict is not one of the three. */
export function normalizeTriage(raw: unknown, reason?: unknown): { triage: Triage; triage_reason?: string } | null {
  if (typeof raw !== 'string') return null;
  const triage = raw.trim().toLowerCase();
  if (!(TRIAGE_VALUES as readonly string[]).includes(triage)) return null;
  const line = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, TRIAGE_REASON_MAX) : '';
  return { triage: triage as Triage, ...(line ? { triage_reason: line } : {}) };
}

/**
 * Writes the verdicts after a successful commit. `receipt.groups[i]` pairs with `valid[i]`
 * (pipeline_commit_groups appends receipts in input order); if the lengths differ, nothing is written.
 * Only a group with no verdict yet is written (`triage IS NULL`): a new group gets one, but feedback joining an
 * existing group never overwrites the verdict that group already has.
 * Best effort: a failed update never throws, grouping already succeeded.
 */
export async function applyGroupTriage(
  botId: string,
  valid: { triage?: Triage; triage_reason?: string }[],
  receiptGroups: { id: string }[],
): Promise<void> {
  if (valid.length !== receiptGroups.length) return;
  const db = getServiceRoleClient();
  for (let i = 0; i < valid.length; i++) {
    const { triage, triage_reason } = valid[i];
    if (!triage) continue;
    try {
      const { error } = await db
        .from('insight_groups')
        .update({ triage, triage_reason: triage_reason ?? null })
        .eq('id', receiptGroups[i].id)
        .eq('bot_id', botId)
        .is('triage', null);
      if (error) console.warn('[grouping] triage update failed:', error.message);
    } catch (err) {
      console.warn('[grouping] triage update failed:', err instanceof Error ? err.message : err);
    }
  }
}

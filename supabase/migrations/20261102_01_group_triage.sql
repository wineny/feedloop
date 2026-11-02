-- F2 triage (label only): the grouping model proposes one verdict per group.
-- Nothing is automated from it (no PR, no dismiss, no reply) — the dashboard only shows a badge.
-- Additive and nullable: code reads these columns in a separate, error-tolerant query,
-- so shipping code before this migration just hides the badge.
ALTER TABLE insight_groups
  ADD COLUMN IF NOT EXISTS triage text CHECK (triage IN ('fix', 'wont_fix', 'needs_decision'));
ALTER TABLE insight_groups
  ADD COLUMN IF NOT EXISTS triage_reason text;

NOTIFY pgrst, 'reload schema';

-- Rollback:
--   ALTER TABLE insight_groups DROP COLUMN IF EXISTS triage_reason;
--   ALTER TABLE insight_groups DROP COLUMN IF EXISTS triage;
--   NOTIFY pgrst, 'reload schema';

-- 2026-10-22 PayPal stage 4 (2/3) — refunds and reversals show on paypal_orders, wherever they happened.
--
-- Until now an order stayed `captured` after a refund: our own refunds (refund.ts) only touched
-- payment_actions, and a seller refund in the PayPal dashboard or a reversal (PAYMENT.CAPTURE.REVERSED)
-- was only recorded in paypal_webhook_events. The application now re-reads the capture (and, for a
-- partial refund, the refund) from PayPal and hands the result to paypal_order_apply_refund below.
--
-- Status only moves forward:  captured → partially_refunded → refunded,  and `reversed` is terminal.
-- The rank check and the write are ONE conditional UPDATE, so duplicate or out-of-order events and
-- concurrent callers (webhook vs. our own refund) can never move a row back. refunded_cents only grows
-- (GREATEST), capped at the order amount.
--
-- Backward compatible (order: this migration → code deploy → data cleanup):
--  - the CHECK only widens; code deployed today never writes the new statuses;
--  - refunded_cents has a default (0) and refunded_at is nullable, so today's INSERTs keep working;
--  - today's code reads explicit column lists and ignores the new columns.
-- Data cleanup after the deploy: orders refunded before it keep `captured` until the next refund event
-- for their capture arrives. Nothing here guesses their state.

-- ── 1. columns ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE paypal_orders ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;  -- PayPal's refunded total for the capture, to date
ALTER TABLE paypal_orders ADD COLUMN IF NOT EXISTS refunded_at    TIMESTAMPTZ;                -- when we last saw that state change

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paypal_orders_refunded_cents_check') THEN
    ALTER TABLE paypal_orders ADD CONSTRAINT paypal_orders_refunded_cents_check CHECK (refunded_cents >= 0);
  END IF;
END $$;

-- ── 2. status CHECK: + partially_refunded, refunded, reversed ───────────────────────────────────
-- The original inline CHECK (20261019_01) got PostgreSQL's default name paypal_orders_status_check.
ALTER TABLE paypal_orders DROP CONSTRAINT IF EXISTS paypal_orders_status_check;
ALTER TABLE paypal_orders ADD CONSTRAINT paypal_orders_status_check
  CHECK (status IN ('created', 'approved', 'captured', 'expired', 'failed', 'partially_refunded', 'refunded', 'reversed'));

-- Guard: had the DROP above missed the original CHECK (another name), the old one would still reject the
-- new statuses silently at the first refund. Exactly one CHECK on paypal_orders may mention `status`.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint
   WHERE conrelid = 'paypal_orders'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'paypal_orders: expected exactly one status CHECK, found %', n;
  END IF;
END $$;

-- ── 3. the one write ───────────────────────────────────────────────────────────────────────────
-- Applies a refund state the CALLER read from PayPal. Only a captured-or-later row of this bot with this
-- capture id moves, and only when the new state ranks higher or the refunded total grew. Returns the
-- updated row, or no row when nothing changed (unknown order, earlier state, or already there).
CREATE OR REPLACE FUNCTION paypal_order_apply_refund(
  p_order_id       text,
  p_bot_id         uuid,
  p_capture_id     text,
  p_status         text,
  p_refunded_cents integer
) RETURNS SETOF paypal_orders
LANGUAGE sql
SET search_path = public
AS $$
  UPDATE paypal_orders o
     SET status = CASE
                    WHEN array_position(ARRAY['captured', 'partially_refunded', 'refunded', 'reversed'], p_status)
                       > array_position(ARRAY['captured', 'partially_refunded', 'refunded', 'reversed'], o.status)
                    THEN p_status
                    ELSE o.status
                  END,
         refunded_cents = GREATEST(o.refunded_cents, LEAST(GREATEST(COALESCE(p_refunded_cents, 0), 0), o.amount_cents)),
         refunded_at    = now(),
         updated_at     = now()
   WHERE o.order_id = p_order_id
     AND o.bot_id = p_bot_id
     AND o.capture_id = p_capture_id
     AND p_status IN ('partially_refunded', 'refunded', 'reversed')
     AND o.status IN ('captured', 'partially_refunded', 'refunded', 'reversed')
     AND (
           array_position(ARRAY['captured', 'partially_refunded', 'refunded', 'reversed'], p_status)
         > array_position(ARRAY['captured', 'partially_refunded', 'refunded', 'reversed'], o.status)
        OR LEAST(GREATEST(COALESCE(p_refunded_cents, 0), 0), o.amount_cents) > o.refunded_cents
     )
  RETURNING o.*;
$$;

REVOKE ALL ON FUNCTION paypal_order_apply_refund(text, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION paypal_order_apply_refund(text, uuid, text, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run by hand; not executed by the migration) ────────────────────────────────────────
-- Order matters:
--  1. Rows already in a new status go back to `captured` (the money state stays visible in PayPal and in
--     payment_actions). Code deployed before stage 4 cannot render the new statuses.
--  2. Roll the application code back to the pre-stage-4 deploy (it never calls the function below).
--  3. Then drop the function, narrow the CHECK and drop the columns.
-- UPDATE paypal_orders SET status = 'captured' WHERE status IN ('partially_refunded', 'refunded', 'reversed');
-- (roll the code back here)
-- DROP FUNCTION IF EXISTS paypal_order_apply_refund(text, uuid, text, text, integer);
-- ALTER TABLE paypal_orders DROP CONSTRAINT IF EXISTS paypal_orders_status_check;
-- ALTER TABLE paypal_orders ADD CONSTRAINT paypal_orders_status_check
--   CHECK (status IN ('created', 'approved', 'captured', 'expired', 'failed'));
-- ALTER TABLE paypal_orders DROP CONSTRAINT IF EXISTS paypal_orders_refunded_cents_check;
-- ALTER TABLE paypal_orders DROP COLUMN IF EXISTS refunded_at;
-- ALTER TABLE paypal_orders DROP COLUMN IF EXISTS refunded_cents;
-- NOTIFY pgrst, 'reload schema';

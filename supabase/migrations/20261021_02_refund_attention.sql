-- 2026-10-21 PayPal stage 3 (4/6) — the inbox badge for refunds that wait, kept consistent in the database.
--
-- "Needs a person" (conversations.escalated_at) is raised when a refund request lands in `pending` and
-- lowered when the operator decides — but only while nothing else in that conversation still waits.
-- Doing the check in application code (SELECT then UPDATE) left two holes (step-4 review): a window of
-- the newest N rows is not an existence check, and a refund opened between the SELECT and the UPDATE was
-- erased. Both writes therefore move here, under the SAME per-bot advisory lock the guardrail RPC takes,
-- so "open a pending refund + raise the badge" and "lower the badge if nothing is pending" serialise.
--
-- Additive: payment_action_open_refund keeps its 11-argument signature (v2); only the pending branch gains
-- the conversations UPDATE.

CREATE OR REPLACE FUNCTION payment_action_open_refund(
  p_bot_id              uuid,
  p_conversation_id     uuid,
  p_capture_id          text,
  p_amount_cents        integer,
  p_currency            text,
  p_captured_at         timestamptz,
  p_capture_has_refund  boolean,
  p_has_dispute         boolean,
  p_customer_key        text,
  p_reason              text,
  p_capture_total_cents integer
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  b                bots%ROWTYPE;
  v_existing       payment_actions%ROWTYPE;
  v_row            payment_actions%ROWTYPE;
  v_daily_cents    integer;
  v_customer_count integer;
  v_checks         jsonb;
  v_auto           boolean;
  v_customer_key   text;
  v_utc_day_start  timestamptz;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'refund amount must be explicit and positive (omitting it would mean a full refund on PayPal)';
  END IF;
  IF p_capture_total_cents IS NULL OR p_capture_total_cents <= 0 THEN
    RAISE EXCEPTION 'capture total required (the server reads it from PayPal before asking for a refund)';
  END IF;
  IF p_amount_cents > p_capture_total_cents THEN
    RAISE EXCEPTION 'refund amount % exceeds the capture total %', p_amount_cents, p_capture_total_cents;
  END IF;
  IF p_capture_id IS NULL OR length(p_capture_id) = 0 THEN
    RAISE EXCEPTION 'capture id required';
  END IF;

  SELECT * INTO b FROM bots WHERE id = p_bot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bot % not found', p_bot_id;
  END IF;

  v_customer_key := NULLIF(lower(btrim(p_customer_key)), '');
  v_utc_day_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  PERFORM pg_advisory_xact_lock(hashtext('payment_actions:' || p_bot_id::text));

  SELECT * INTO v_existing
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND target_id = p_capture_id
     AND status IN ('pending', 'executing', 'unknown', 'executed')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('created', false, 'auto', v_existing.origin = 'auto', 'action', to_jsonb(v_existing));
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_daily_cents
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND status IN ('executing', 'unknown', 'executed')
     AND created_at >= v_utc_day_start;

  SELECT COUNT(*) INTO v_customer_count
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND status IN ('pending', 'executing', 'unknown', 'executed')
     AND v_customer_key IS NOT NULL AND customer_key = v_customer_key
     AND created_at >= now() - interval '30 days';

  v_checks := jsonb_build_object(
    'amount_within_max', p_amount_cents <= b.refund_auto_max_cents,
    'within_days',       p_captured_at IS NOT NULL AND p_captured_at >= now() - make_interval(days => b.refund_auto_days),
    'no_prior_refund',   NOT COALESCE(p_capture_has_refund, true),
    'currency_matches',  p_currency IS NOT NULL AND upper(p_currency) = upper(b.currency),
    'daily_cap_ok',      v_daily_cents + p_amount_cents <= b.refund_daily_cap_cents,
    'customer_known',    v_customer_key IS NOT NULL,
    'customer_cap_ok',   v_customer_count < b.refund_per_customer_30d,
    'no_dispute',        NOT COALESCE(p_has_dispute, true),
    'not_propose_only',  NOT b.propose_only,
    'not_paused',        NOT b.paypal_paused
  );
  v_auto := NOT EXISTS (SELECT 1 FROM jsonb_each(v_checks) WHERE value = 'false'::jsonb);

  INSERT INTO payment_actions
    (bot_id, conversation_id, kind, target_id, amount_cents, currency, customer_key, origin, status, reason, guardrail)
  VALUES
    (p_bot_id, p_conversation_id, 'refund', p_capture_id, p_amount_cents, upper(p_currency),
     v_customer_key,
     CASE WHEN v_auto THEN 'auto' ELSE 'approval' END,
     CASE WHEN v_auto THEN 'executing' ELSE 'pending' END,
     p_reason, v_checks)
  RETURNING * INTO v_row;

  -- A refund that waits for a person raises the inbox badge in the SAME transaction, under the lock.
  -- Only escalated_at: handoff_requested_at is the visitor's own "talk to a human" and is not ours to set.
  IF NOT v_auto AND p_conversation_id IS NOT NULL THEN
    UPDATE conversations SET escalated_at = now() WHERE id = p_conversation_id AND bot_id = p_bot_id;
  END IF;

  RETURN jsonb_build_object('created', true, 'auto', v_auto, 'action', to_jsonb(v_row), 'checks', v_checks);
END
$$;

REVOKE ALL ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text, integer)
  TO service_role;

-- Lowers the badge after a decision — in one statement, under the same per-bot lock, and only when
-- (a) no refund of this conversation is still pending (a complete existence check, not a window) and
-- (b) the visitor has not asked for a human themselves (handoff_requested_at is the superset marker).
-- Returns true when the badge came down.
CREATE OR REPLACE FUNCTION conversation_clear_refund_attention(p_conversation_id uuid, p_bot_id uuid) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('payment_actions:' || p_bot_id::text));
  UPDATE conversations c
     SET escalated_at = NULL
   WHERE c.id = p_conversation_id
     AND c.bot_id = p_bot_id
     AND c.handoff_requested_at IS NULL
     AND c.escalated_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM payment_actions a
        WHERE a.conversation_id = c.id AND a.status = 'pending'
     )
  RETURNING c.id INTO v_id;
  RETURN v_id IS NOT NULL;
END
$$;

REVOKE ALL ON FUNCTION conversation_clear_refund_attention(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION conversation_clear_refund_attention(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run by hand; not executed by the migration) ────────────────────────────────────────
-- Only after 20261021_03 is rolled back. The badge then has no database writer: raise and clear it from
-- application code again. conversations.escalated_at itself is untouched by this migration and stays.
-- DROP FUNCTION IF EXISTS conversation_clear_refund_attention(uuid, uuid);
-- Then re-create payment_action_open_refund from 20261021_01 (same 11-argument signature, no
-- conversations UPDATE in the pending branch).
-- NOTIFY pgrst, 'reload schema';

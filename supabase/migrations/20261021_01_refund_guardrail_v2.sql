-- 2026-10-21 PayPal stage 3 (3/6) — guardrail RPC v2, approval transition, demo-bot sandbox check.
-- Items ny deferred from the stage-1 review (briefing, task 3):
--  1) the daily cap counts a UTC day. `date_trunc('day', now())` truncates in the SESSION time zone,
--     so the same rows fell into different "days" depending on who connected.
--  2) an unknown customer (NULL / blank customer_key) is no longer an automatic pass: the per-customer
--     cap cannot be checked, so the request waits for approval.
--  3) the requested amount must not exceed the capture total — enforced in SQL with a new argument,
--     not only in TypeScript.
--  4) the demo bot can only ever be in the sandbox: bots.is_demo ⇒ paypal_env = 'sandbox'.
--  5) payment_action_decide(): the operator's approve/reject as ONE conditional update
--     (… WHERE status = 'pending' RETURNING). Zero rows back = somebody already decided.
-- The 'unknown' status and its reservation semantics arrived with 20261020_01.

-- ── 0. reconciliation bookkeeping ─────────────────────────────────────────────────────────
-- The reaper visits executing/unknown rows. A row it visited and could not finish (PayPal still
-- PENDING, unreachable, bot without PayPal) must yield to rows it has not visited yet, or fifty old
-- stragglers would hide every newer row forever. Attempt time is the fairness cursor; the count is
-- for the operator's eyes.
ALTER TABLE payment_actions ADD COLUMN IF NOT EXISTS reconcile_attempts     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_actions ADD COLUMN IF NOT EXISTS reconcile_attempted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_payment_actions_stuck
  ON payment_actions(reconcile_attempted_at NULLS FIRST, updated_at)
  WHERE status IN ('executing', 'unknown');

-- The send gate. Called BEFORE every POST to PayPal (first attempt or retry), in one locked step:
--   allowed = the row is still sendable (executing | unknown). A row another caller has since closed
--             (failed, executed, rejected, expired) or that is not yet approved (pending) is refused —
--             the caller's snapshot is stale and nothing is sent.
--   first   = no attempt had started before this one (sent_at was NULL). A definite 4xx reply to the
--             FIRST attempt is the answer; to a retry it says nothing about the original (PayPal answers a
--             replay of a completed request from its idempotency cache, so an error is about this request).
--   Also records sent_at (once, never cleared) and send_attempts (+1). If the write fails nothing is sent.
-- The matching failure write (store.settleAction onlyIfFirstAttempt) only applies while send_attempts = 1,
-- so a first attempt whose reply arrives after a second attempt started cannot close the row.
ALTER TABLE payment_actions ADD COLUMN IF NOT EXISTS sent_at       TIMESTAMPTZ;
ALTER TABLE payment_actions ADD COLUMN IF NOT EXISTS send_attempts INTEGER NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS payment_action_mark_sent(uuid);
CREATE OR REPLACE FUNCTION payment_action_mark_sent(p_action_id uuid) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row payment_actions%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM payment_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'action % not found', p_action_id;
  END IF;
  IF v_row.status NOT IN ('executing', 'unknown') THEN
    RETURN jsonb_build_object('allowed', false, 'first', false, 'status', v_row.status);
  END IF;
  UPDATE payment_actions
     SET sent_at = COALESCE(sent_at, now()),
         send_attempts = send_attempts + 1
   WHERE id = p_action_id;
  RETURN jsonb_build_object('allowed', true, 'first', v_row.sent_at IS NULL, 'status', v_row.status);
END
$$;
REVOKE ALL ON FUNCTION payment_action_mark_sent(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_mark_sent(uuid) TO service_role;

-- One statement, no read-modify-write: attempts + 1, attempted_at = now(). updated_at is left alone —
-- it is the "stuck since" clock and must not move because somebody looked.
CREATE OR REPLACE FUNCTION payment_action_touch_reconcile(p_action_id uuid) RETURNS void
LANGUAGE sql
AS $$
  UPDATE payment_actions
     SET reconcile_attempts = reconcile_attempts + 1,
         reconcile_attempted_at = now()
   WHERE id = p_action_id;
$$;
REVOKE ALL ON FUNCTION payment_action_touch_reconcile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_touch_reconcile(uuid) TO service_role;

-- ── 4. demo bot stays in the sandbox ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bots_demo_sandbox_check') THEN
    ALTER TABLE bots ADD CONSTRAINT bots_demo_sandbox_check CHECK (NOT is_demo OR paypal_env = 'sandbox');
  END IF;
END $$;

-- ── 1–3. guardrail RPC v2 ─────────────────────────────────────────────────────────────────
-- New signature (11 args: + p_capture_total_cents). The 10-arg v1 is dropped so no caller can keep
-- using the pre-UTC, no-total version by accident.
DROP FUNCTION IF EXISTS payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text);

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

  -- NULL when blank: a blank key must neither match other rows nor pass the customer check.
  v_customer_key := NULLIF(lower(btrim(p_customer_key)), '');
  -- The start of the current UTC day, as an absolute instant — independent of the session time zone.
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

  RETURN jsonb_build_object('created', true, 'auto', v_auto, 'action', to_jsonb(v_row), 'checks', v_checks);
END
$$;

REVOKE ALL ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text, integer)
  TO service_role;

-- ── 5. the operator's decision, exactly once ──────────────────────────────────────────────
-- approve: pending → executing (origin stays 'approval'; the caller then calls PayPal with
--          PayPal-Request-Id = id, exactly like the auto path, and settles the row).
-- reject:  pending → rejected (slot freed).
-- Returns { updated: boolean, action }. updated=false carries the row as it is now, so the caller can
-- say "already approved by X" / "already rejected" instead of acting twice. Ownership (is this user the
-- bot's owner or an approver?) is the caller's check; this function only guards the transition.
CREATE OR REPLACE FUNCTION payment_action_decide(
  p_action_id uuid,
  p_bot_id    uuid,
  p_decision  text,
  p_user_id   uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row payment_actions%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject, got %', p_decision;
  END IF;

  UPDATE payment_actions
     SET status     = CASE WHEN p_decision = 'approve' THEN 'executing' ELSE 'rejected' END,
         decided_by = p_user_id,
         decided_at = now(),
         updated_at = now()
   WHERE id = p_action_id AND bot_id = p_bot_id AND status = 'pending'
   RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('updated', true, 'action', to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM payment_actions WHERE id = p_action_id AND bot_id = p_bot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'action % not found for bot %', p_action_id, p_bot_id;
  END IF;
  RETURN jsonb_build_object('updated', false, 'action', to_jsonb(v_row));
END
$$;

REVOKE ALL ON FUNCTION payment_action_decide(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_decide(uuid, uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

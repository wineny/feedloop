-- 2026-10-20 PayPal stage 3 (2/6) — the "verified payment" of a widget conversation (design v2 §2).
--
-- find_my_payment(order_id, email) only succeeds when BOTH match what the server knows about the
-- order (our paypal_orders row, or GET /v2/checkout/orders when the row has no payer yet). The match
-- is recorded here, server-side, so the later tools (get_payment_status, request_refund) act only on
-- a payment this conversation proved it owns — never on something the model, or a prompt-injected
-- visitor, merely claims. One conversation may verify several orders; one order may be verified from
-- several conversations (same buyer, two browsers), so the key is the pair.
--
-- Additive only. RLS on + zero policies = anon blocked; every app path uses service_role.

CREATE TABLE IF NOT EXISTS payment_verifications (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  order_id        TEXT NOT NULL,                       -- PayPal order id the visitor typed, upper-cased
  capture_id      TEXT,                                -- NULL until the order is captured; refunds need it
  payer_email     TEXT NOT NULL,                       -- lower-cased; becomes the guardrail's customer_key
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL,
  captured_at     TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_verifications_conv ON payment_verifications(conversation_id, verified_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_verifications_bot  ON payment_verifications(bot_id, verified_at DESC);
ALTER TABLE payment_verifications ENABLE ROW LEVEL SECURITY;

-- responses.response_type gains 'payment_agent' (stage 3, 1/6): a conversational reply written by the
-- payment agent. The widget shows it as an ordinary AI bubble; the router reads it as "the previous
-- reply came from the payment agent". 'payment' stays the server-fixed money sentence + card.
COMMENT ON COLUMN responses.response_type IS
  'mention | keyword | question | kakao | ai | operator | loop_closed | system | payment | payment_agent';

-- ── payment_actions: the 'unknown' status ─────────────────────────────────────────────────
-- We asked PayPal to move money and did not learn the answer: the request timed out or was
-- aborted mid-flight, the connection dropped, PayPal answered 5xx, or our own settle write failed
-- after a success. Marking such a row `failed` would be a lie with consequences — `failed` frees
-- the one-live-action-per-capture slot and drops out of the daily and per-customer sums, so the
-- next "refund me" would open a NEW action with a NEW PayPal-Request-Id and could refund twice.
-- `unknown` keeps the reservation: it is live for the unique index and the RPC's sums, and a retry
-- MUST reuse the row's id as PayPal-Request-Id (PayPal then answers from its idempotency cache).
-- Only reconciliation (GET the refund / the capture; task 3's reaper) moves it to executed/failed.
ALTER TABLE payment_actions DROP CONSTRAINT IF EXISTS payment_actions_status_check;
ALTER TABLE payment_actions ADD CONSTRAINT payment_actions_status_check
  CHECK (status IN ('pending', 'executing', 'unknown', 'executed', 'failed', 'rejected', 'expired'));

DROP INDEX IF EXISTS idx_payment_actions_live_target;
CREATE UNIQUE INDEX idx_payment_actions_live_target
  ON payment_actions(bot_id, kind, target_id)
  WHERE status IN ('pending', 'executing', 'unknown', 'executed');

-- Same RPC as 20261019_01 with 'unknown' added to the three live sets (existing-action check,
-- daily sum, per-customer count). Task 3 revises the decision itself (UTC day, NULL customer key,
-- amount ≤ capture total); nothing else changes here.
CREATE OR REPLACE FUNCTION payment_action_open_refund(
  p_bot_id             uuid,
  p_conversation_id    uuid,
  p_capture_id         text,
  p_amount_cents       integer,
  p_currency           text,
  p_captured_at        timestamptz,
  p_capture_has_refund boolean,
  p_has_dispute        boolean,
  p_customer_key       text,
  p_reason             text
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
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'refund amount must be explicit and positive (omitting it would mean a full refund on PayPal)';
  END IF;
  IF p_capture_id IS NULL OR length(p_capture_id) = 0 THEN
    RAISE EXCEPTION 'capture id required';
  END IF;

  SELECT * INTO b FROM bots WHERE id = p_bot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bot % not found', p_bot_id;
  END IF;

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
     AND created_at >= date_trunc('day', now());

  SELECT COUNT(*) INTO v_customer_count
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND status IN ('pending', 'executing', 'unknown', 'executed')
     AND p_customer_key IS NOT NULL AND customer_key = lower(p_customer_key)
     AND created_at >= now() - interval '30 days';

  v_checks := jsonb_build_object(
    'amount_within_max', p_amount_cents <= b.refund_auto_max_cents,
    'within_days',       p_captured_at IS NOT NULL AND p_captured_at >= now() - make_interval(days => b.refund_auto_days),
    'no_prior_refund',   NOT COALESCE(p_capture_has_refund, true),
    'currency_matches',  p_currency IS NOT NULL AND upper(p_currency) = upper(b.currency),
    'daily_cap_ok',      v_daily_cents + p_amount_cents <= b.refund_daily_cap_cents,
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
     lower(p_customer_key),
     CASE WHEN v_auto THEN 'auto' ELSE 'approval' END,
     CASE WHEN v_auto THEN 'executing' ELSE 'pending' END,
     p_reason, v_checks)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('created', true, 'auto', v_auto, 'action', to_jsonb(v_row), 'checks', v_checks);
END
$$;

REVOKE ALL ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- 2026-10-19 PayPal foundation (PayPal AI Hackathon — design v2 §3 connection, §4 guardrail, §9 demo).
--
-- Additive only: nothing the Korean production deployment relies on changes shape.
--  1) bots      — per-bot PayPal credentials (same encrypt-and-show-last4 pattern as the LLM key),
--                 refund limits the guardrail re-reads at execution time, and a demo flag.
--  2) bot_members — approvers who are not the owner. Judges press "Try the demo bot" and land here.
--  3) products / paypal_orders / payment_actions / paypal_webhook_events.
--  4) payment_action_open_refund() — the guardrail decision and the write-ahead row in ONE statement,
--     so two concurrent "refund me" messages for the same capture can never both execute.
--
-- RLS convention (20260905_01, 20260910_01): RLS on + zero policies = the public anon key is blocked
-- outright. Every app path reaches these tables through service_role, which bypasses RLS.

-- ── 1. bots: PayPal connection ────────────────────────────────────────────────────────────
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_client_id        TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_secret_encrypted TEXT;        -- AES-256-GCM (lib/utils/crypto.ts); never returned by any route
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_secret_last4     TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_env              TEXT NOT NULL DEFAULT 'sandbox';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_verified_at      TIMESTAMPTZ;  -- last successful OAuth token with these credentials
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_failed_at        TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_failed_reason    TEXT;         -- short fixed code, never PayPal's raw error text
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_scopes           TEXT[];       -- `scope` from the token response, for the settings screen
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_webhook_id       TEXT;         -- registered via POST /v1/notifications/webhooks on save
ALTER TABLE bots ADD COLUMN IF NOT EXISTS paypal_paused           BOOLEAN NOT NULL DEFAULT false; -- kill switch: nothing auto-executes while true

-- Refund guardrail limits. Defaults = design v2 §3. The RPC below reads these at decision time —
-- never from the 5-minute bot config cache — so a tightened limit applies to the very next message.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS refund_auto_max_cents   INTEGER NOT NULL DEFAULT 2000;   -- ≤ $20 auto
ALTER TABLE bots ADD COLUMN IF NOT EXISTS refund_auto_days        INTEGER NOT NULL DEFAULT 14;     -- captured within N days
ALTER TABLE bots ADD COLUMN IF NOT EXISTS refund_daily_cap_cents  INTEGER NOT NULL DEFAULT 10000;  -- per bot per UTC day
ALTER TABLE bots ADD COLUMN IF NOT EXISTS refund_per_customer_30d INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS currency                TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS propose_only            BOOLEAN NOT NULL DEFAULT false;  -- "suggest only" mode: every refund waits for approval

-- The one bot whose widget runs on Feedloop's own pricing page. At most one row may carry the flag.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS is_demo                 BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_single_demo ON bots (is_demo) WHERE is_demo;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bots_paypal_env_check') THEN
    ALTER TABLE bots ADD CONSTRAINT bots_paypal_env_check CHECK (paypal_env IN ('sandbox', 'live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bots_refund_limits_check') THEN
    ALTER TABLE bots ADD CONSTRAINT bots_refund_limits_check CHECK (
      refund_auto_max_cents >= 0 AND refund_auto_days >= 0 AND
      refund_daily_cap_cents >= 0 AND refund_per_customer_30d >= 0
    );
  END IF;
END $$;

-- ── 2. bot_members: approvers besides the owner ──────────────────────────────────────────
-- Ownership stays a single user_id on bots. Members get the operator screens (inbox, dashboard,
-- approvals) through lib/auth/ownership.ts#resolveAccessibleBots; settings routes stay owner-only.
CREATE TABLE IF NOT EXISTS bot_members (
  bot_id     UUID NOT NULL REFERENCES bots(id)  ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'approver' CHECK (role IN ('approver')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_members_user ON bot_members(user_id);
ALTER TABLE bot_members ENABLE ROW LEVEL SECURITY;

-- ── 3a. products: the price table the agent may choose from ──────────────────────────────
-- The LLM only ever picks (product_id, quantity). Amounts come from this row, never from the model.
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id       UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  sku          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  active       BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_bot ON products(bot_id, active, sort_order);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- ── 3b. paypal_orders: checkouts we created (pricing page or mid-chat) ───────────────────
-- Keyed by PayPal's order id so the return URL and the webhook update the same row.
CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id        TEXT PRIMARY KEY,
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,  -- set when bought from the widget
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created', 'approved', 'captured', 'expired', 'failed')),
  capture_id      TEXT,                                                  -- filled on capture; refunds target this
  payer_email     TEXT,                                                  -- what find_my_payment compares against
  payer_id        TEXT,
  approve_url     TEXT,                                                  -- shown as the "Pay with PayPal" card (server data, not LLM text)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paypal_orders_bot  ON paypal_orders(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paypal_orders_conv ON paypal_orders(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paypal_orders_capture ON paypal_orders(capture_id) WHERE capture_id IS NOT NULL;
ALTER TABLE paypal_orders ENABLE ROW LEVEL SECURITY;

-- ── 3c. payment_actions: every move of money, auto or approved ───────────────────────────
-- Lifecycle: pending → executing → executed | failed   (approval path)
--            executing → executed | failed              (auto path, row is born as executing)
--            pending → rejected | expired               (operator said no / 7 days passed)
-- `id` doubles as the PayPal-Request-Id of the call, so a retry after a crash is idempotent on PayPal's side.
CREATE TABLE IF NOT EXISTS payment_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('refund', 'accept_dispute')),
  target_id       TEXT NOT NULL,                       -- capture id (refund) or dispute id (accept_dispute)
  amount_cents    INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency        TEXT,
  customer_key    TEXT,                                -- payer email (lower-cased); drives the per-customer cap
  origin          TEXT NOT NULL CHECK (origin IN ('auto', 'approval')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'executing', 'executed', 'failed', 'rejected', 'expired')),
  reason          TEXT,                                -- what the customer said
  guardrail       JSONB,                               -- each check and whether it passed — the approval card shows this
  payload         JSONB,                               -- the request body we sent to PayPal
  result          JSONB,                               -- PayPal's parsed response (no secrets)
  paypal_ref      TEXT,                                -- refund id / dispute action ref
  error           TEXT,
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  executed_at     TIMESTAMPTZ,
  reminded_at     TIMESTAMPTZ,                         -- 24h nudge sent
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live action per (bot, kind, target). pending/executing/executed count as live; rejected/expired/failed
-- free the slot so a legitimate second attempt is possible after a human said no or PayPal failed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_actions_live_target
  ON payment_actions(bot_id, kind, target_id)
  WHERE status IN ('pending', 'executing', 'executed');
CREATE INDEX IF NOT EXISTS idx_payment_actions_bot_status ON payment_actions(bot_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_actions_conv       ON payment_actions(conversation_id);
ALTER TABLE payment_actions ENABLE ROW LEVEL SECURITY;

-- ── 3d. paypal_webhook_events: dedupe + audit for inbound webhooks ───────────────────────
CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id      TEXT PRIMARY KEY,                       -- PayPal event id; a redelivery hits the PK and is dropped
  bot_id        UUID REFERENCES bots(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_paypal_webhook_events_bot ON paypal_webhook_events(bot_id, received_at DESC);
ALTER TABLE paypal_webhook_events ENABLE ROW LEVEL SECURITY;

-- responses.response_type is free TEXT (init_schema.sql). 'payment' = server-fixed sentences about money
-- (refund done / waiting for approval / declined / failed). Recorded here so the next reader knows the value set.
COMMENT ON COLUMN responses.response_type IS
  'mention | keyword | question | kakao | ai | operator | loop_closed | system | payment';

-- ── 4. Guardrail RPC ─────────────────────────────────────────────────────────────────────
-- Inputs are facts the SERVER read from PayPal (GET /v2/payments/captures/{id}) — never model output.
-- Returns jsonb: { created, auto, action, checks }.
--   created=false → a live action for this capture already exists; `action` is that row. Do not call PayPal.
--   auto=true     → row was inserted as origin=auto, status=executing. Caller must now call PayPal with
--                   PayPal-Request-Id = action.id and then mark executed/failed.
--   auto=false    → row is pending; show the approval card. Nothing moves until an operator decides.
-- Per-bot advisory lock serialises the daily-cap and per-customer arithmetic; the partial unique index is
-- the second line of defence if anything ever bypasses the lock.
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
     AND status IN ('pending', 'executing', 'executed')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('created', false, 'auto', v_existing.origin = 'auto', 'action', to_jsonb(v_existing));
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_daily_cents
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND status IN ('executing', 'executed')
     AND created_at >= date_trunc('day', now());

  SELECT COUNT(*) INTO v_customer_count
    FROM payment_actions
   WHERE bot_id = p_bot_id AND kind = 'refund' AND status IN ('pending', 'executing', 'executed')
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

-- Supabase grants anon/authenticated EXECUTE on new public functions by default (20260913_26). Revoke all three.
REVOKE ALL ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_open_refund(uuid, uuid, text, integer, text, timestamptz, boolean, boolean, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

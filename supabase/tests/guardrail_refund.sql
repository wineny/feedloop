-- Guardrail RPC scenario — runs against a fresh database (scripts/schema-dry-run.sh supabase/tests/guardrail_refund.sql).
-- Every check RAISEs on mismatch, so a non-zero exit from psql means a regression.
-- Limits used: defaults from 20261019_01 (≤ $20 auto, 14 days, $100/day, 1 per customer / 30 days).

BEGIN;

INSERT INTO users (id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'owner@example.com');
INSERT INTO bots (id, user_id, bot_token_encrypted, service_name, platform)
VALUES ('00000000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-000000000001', 'kakao-no-token', 'Feedloop', 'web');

DO $$
DECLARE r jsonb;
BEGIN
  -- 1. $15, captured 3 days ago, clean → auto, row born as executing
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-1', 1500, 'USD',
         now() - interval '3 days', false, false, 'Alice@Example.com', 'double charged');
  IF NOT (r->>'created')::boolean OR NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case1 expected auto, got %', r; END IF;
  IF r->'action'->>'status' <> 'executing' OR r->'action'->>'origin' <> 'auto' THEN RAISE EXCEPTION 'case1 status/origin wrong: %', r->'action'; END IF;
  IF r->'action'->>'customer_key' <> 'alice@example.com' THEN RAISE EXCEPTION 'case1 customer_key not lower-cased: %', r->'action'->>'customer_key'; END IF;

  -- 2. same capture again (second message / retry) → not created, same row back
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-1', 1500, 'USD',
         now() - interval '3 days', false, false, 'alice@example.com', 'again');
  IF (r->>'created')::boolean THEN RAISE EXCEPTION 'case2 expected created=false, got %', r; END IF;
  IF r->'action'->>'target_id' <> 'CAP-1' THEN RAISE EXCEPTION 'case2 wrong row: %', r->'action'; END IF;

  -- 3. $25 (> max) → approval / pending, and the guardrail says which check failed
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-2', 2500, 'USD',
         now() - interval '1 day', false, false, 'bob@example.com', 'too expensive');
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case3 expected approval, got %', r; END IF;
  IF r->'action'->>'status' <> 'pending' THEN RAISE EXCEPTION 'case3 expected pending: %', r->'action'->>'status'; END IF;
  IF (r->'checks'->>'amount_within_max')::boolean THEN RAISE EXCEPTION 'case3 amount check should fail: %', r->'checks'; END IF;
  IF NOT (r->'checks'->>'within_days')::boolean THEN RAISE EXCEPTION 'case3 days check should pass: %', r->'checks'; END IF;

  -- 4. Alice again on a different capture within 30 days → per-customer cap → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-3', 500, 'USD',
         now() - interval '2 days', false, false, 'ALICE@example.com', 'second one');
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case4 expected approval (customer cap), got %', r; END IF;
  IF (r->'checks'->>'customer_cap_ok')::boolean THEN RAISE EXCEPTION 'case4 customer_cap_ok should be false: %', r->'checks'; END IF;

  -- 5. 20 days old → outside window → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-4', 500, 'USD',
         now() - interval '20 days', false, false, 'carol@example.com', 'old');
  IF (r->>'auto')::boolean OR (r->'checks'->>'within_days')::boolean THEN RAISE EXCEPTION 'case5 expected days check to fail: %', r; END IF;

  -- 6. capture already refunded once → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-5', 500, 'USD',
         now() - interval '2 days', true, false, 'dave@example.com', 'partial again');
  IF (r->>'auto')::boolean OR (r->'checks'->>'no_prior_refund')::boolean THEN RAISE EXCEPTION 'case6 expected prior-refund check to fail: %', r; END IF;

  -- 7. wrong currency → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-6', 500, 'EUR',
         now() - interval '2 days', false, false, 'erin@example.com', 'eur');
  IF (r->>'auto')::boolean OR (r->'checks'->>'currency_matches')::boolean THEN RAISE EXCEPTION 'case7 expected currency check to fail: %', r; END IF;

  -- 8. daily cap: $15 already executing today; $90 more would exceed $100 → approval. $80 fits → auto.
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-7', 9000, 'USD',
         now() - interval '2 days', false, false, 'frank@example.com', 'big');
  IF (r->>'auto')::boolean OR (r->'checks'->>'daily_cap_ok')::boolean THEN RAISE EXCEPTION 'case8a expected daily cap to fail: %', r; END IF;
  -- CAP-7 is pending (not counted toward the cap) — a $20 for another customer still fits under $100 → auto
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-8', 2000, 'USD',
         now() - interval '2 days', false, false, 'grace@example.com', 'fits');
  IF NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case8b expected auto, got %', r; END IF;

  -- 9. propose_only flips everything to approval; paypal_paused too
  UPDATE bots SET propose_only = true WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-9', 100, 'USD',
         now() - interval '1 day', false, false, 'heidi@example.com', 'tiny');
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case9 propose_only should force approval: %', r; END IF;
  UPDATE bots SET propose_only = false, paypal_paused = true WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-10', 100, 'USD',
         now() - interval '1 day', false, false, 'ivan@example.com', 'tiny');
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case9b paused should force approval: %', r; END IF;

  -- 10. amount must be explicit
  BEGIN
    PERFORM payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-11', NULL, 'USD', now(), false, false, 'x@example.com', 'no amount');
    RAISE EXCEPTION 'case10 expected an error for NULL amount';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%explicit%' THEN RAISE; END IF;
  END;

  -- 11. the partial unique index is the second line of defence: a direct second live insert fails
  BEGIN
    INSERT INTO payment_actions (bot_id, kind, target_id, amount_cents, currency, origin, status)
    VALUES ('00000000-0000-4000-8000-0000000000b0', 'refund', 'CAP-1', 100, 'USD', 'approval', 'pending');
    RAISE EXCEPTION 'case11 expected unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- …but a rejected one frees the slot
  UPDATE payment_actions SET status = 'rejected' WHERE target_id = 'CAP-2';
  INSERT INTO payment_actions (bot_id, kind, target_id, amount_cents, currency, origin, status)
  VALUES ('00000000-0000-4000-8000-0000000000b0', 'refund', 'CAP-2', 100, 'USD', 'approval', 'pending');

  -- 12. anon / authenticated cannot execute the RPC; service_role can
  IF has_function_privilege('anon', 'payment_action_open_refund(uuid,uuid,text,integer,text,timestamptz,boolean,boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case12 anon must not execute the guardrail RPC';
  END IF;
  IF NOT has_function_privilege('service_role', 'payment_action_open_refund(uuid,uuid,text,integer,text,timestamptz,boolean,boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case12 service_role must execute the guardrail RPC';
  END IF;

  RAISE NOTICE 'guardrail scenario: 12 cases OK';
END $$;

-- demo-bot uniqueness: a second is_demo row is impossible
DO $$
BEGIN
  INSERT INTO bots (user_id, bot_token_encrypted, service_name, platform, is_demo)
  VALUES ('00000000-0000-4000-8000-000000000001', 'kakao-no-token', 'Demo A', 'web', true);
  BEGIN
    INSERT INTO bots (user_id, bot_token_encrypted, service_name, platform, is_demo)
    VALUES ('00000000-0000-4000-8000-000000000001', 'kakao-no-token', 'Demo B', 'web', true);
    RAISE EXCEPTION 'second demo bot should have been rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'single demo bot: OK';
END $$;

ROLLBACK;

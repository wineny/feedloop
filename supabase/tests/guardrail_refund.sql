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
         now() - interval '3 days', false, false, 'Alice@Example.com', 'double charged', 100000);
  IF NOT (r->>'created')::boolean OR NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case1 expected auto, got %', r; END IF;
  IF r->'action'->>'status' <> 'executing' OR r->'action'->>'origin' <> 'auto' THEN RAISE EXCEPTION 'case1 status/origin wrong: %', r->'action'; END IF;
  IF r->'action'->>'customer_key' <> 'alice@example.com' THEN RAISE EXCEPTION 'case1 customer_key not lower-cased: %', r->'action'->>'customer_key'; END IF;

  -- 2. same capture again (second message / retry) → not created, same row back
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-1', 1500, 'USD',
         now() - interval '3 days', false, false, 'alice@example.com', 'again', 100000);
  IF (r->>'created')::boolean THEN RAISE EXCEPTION 'case2 expected created=false, got %', r; END IF;
  IF r->'action'->>'target_id' <> 'CAP-1' THEN RAISE EXCEPTION 'case2 wrong row: %', r->'action'; END IF;

  -- 3. $25 (> max) → approval / pending, and the guardrail says which check failed
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-2', 2500, 'USD',
         now() - interval '1 day', false, false, 'bob@example.com', 'too expensive', 100000);
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case3 expected approval, got %', r; END IF;
  IF r->'action'->>'status' <> 'pending' THEN RAISE EXCEPTION 'case3 expected pending: %', r->'action'->>'status'; END IF;
  IF (r->'checks'->>'amount_within_max')::boolean THEN RAISE EXCEPTION 'case3 amount check should fail: %', r->'checks'; END IF;
  IF NOT (r->'checks'->>'within_days')::boolean THEN RAISE EXCEPTION 'case3 days check should pass: %', r->'checks'; END IF;

  -- 4. Alice again on a different capture within 30 days → per-customer cap → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-3', 500, 'USD',
         now() - interval '2 days', false, false, 'ALICE@example.com', 'second one', 100000);
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case4 expected approval (customer cap), got %', r; END IF;
  IF (r->'checks'->>'customer_cap_ok')::boolean THEN RAISE EXCEPTION 'case4 customer_cap_ok should be false: %', r->'checks'; END IF;

  -- 5. 20 days old → outside window → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-4', 500, 'USD',
         now() - interval '20 days', false, false, 'carol@example.com', 'old', 100000);
  IF (r->>'auto')::boolean OR (r->'checks'->>'within_days')::boolean THEN RAISE EXCEPTION 'case5 expected days check to fail: %', r; END IF;

  -- 6. capture already refunded once → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-5', 500, 'USD',
         now() - interval '2 days', true, false, 'dave@example.com', 'partial again', 100000);
  IF (r->>'auto')::boolean OR (r->'checks'->>'no_prior_refund')::boolean THEN RAISE EXCEPTION 'case6 expected prior-refund check to fail: %', r; END IF;

  -- 7. wrong currency → approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-6', 500, 'EUR',
         now() - interval '2 days', false, false, 'erin@example.com', 'eur', 100000);
  IF (r->>'auto')::boolean OR (r->'checks'->>'currency_matches')::boolean THEN RAISE EXCEPTION 'case7 expected currency check to fail: %', r; END IF;

  -- 8. daily cap: $15 already executing today; $90 more would exceed $100 → approval. $80 fits → auto.
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-7', 9000, 'USD',
         now() - interval '2 days', false, false, 'frank@example.com', 'big', 100000);
  IF (r->>'auto')::boolean OR (r->'checks'->>'daily_cap_ok')::boolean THEN RAISE EXCEPTION 'case8a expected daily cap to fail: %', r; END IF;
  -- CAP-7 is pending (not counted toward the cap) — a $20 for another customer still fits under $100 → auto
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-8', 2000, 'USD',
         now() - interval '2 days', false, false, 'grace@example.com', 'fits', 100000);
  IF NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case8b expected auto, got %', r; END IF;

  -- 9. propose_only flips everything to approval; paypal_paused too
  UPDATE bots SET propose_only = true WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-9', 100, 'USD',
         now() - interval '1 day', false, false, 'heidi@example.com', 'tiny', 100000);
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case9 propose_only should force approval: %', r; END IF;
  UPDATE bots SET propose_only = false, paypal_paused = true WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-10', 100, 'USD',
         now() - interval '1 day', false, false, 'ivan@example.com', 'tiny', 100000);
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case9b paused should force approval: %', r; END IF;

  -- 10. amount must be explicit
  BEGIN
    PERFORM payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-11', NULL, 'USD', now(), false, false, 'x@example.com', 'no amount', 100000);
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
  IF has_function_privilege('anon', 'payment_action_open_refund(uuid,uuid,text,integer,text,timestamptz,boolean,boolean,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case12 anon must not execute the guardrail RPC';
  END IF;
  IF NOT has_function_privilege('service_role', 'payment_action_open_refund(uuid,uuid,text,integer,text,timestamptz,boolean,boolean,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case12 service_role must execute the guardrail RPC';
  END IF;

  -- 13. 'unknown' (PayPal asked, answer lost) keeps its reservation: it blocks a new action for the
  --     same capture, counts toward the daily cap, and the unique index refuses a direct duplicate.
  UPDATE bots SET paypal_paused = false WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-13', 1000, 'USD',
         now() - interval '1 day', false, false, 'judy@example.com', 'first try', 100000);
  IF NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case13 expected auto, got %', r; END IF;
  UPDATE payment_actions SET status = 'unknown' WHERE target_id = 'CAP-13';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-13', 1000, 'USD',
         now() - interval '1 day', false, false, 'judy@example.com', 'retry', 100000);
  IF (r->>'created')::boolean THEN RAISE EXCEPTION 'case13 unknown row must block a new action: %', r; END IF;
  IF r->'action'->>'status' <> 'unknown' THEN RAISE EXCEPTION 'case13 expected the unknown row back: %', r->'action'; END IF;
  BEGIN
    INSERT INTO payment_actions (bot_id, kind, target_id, amount_cents, currency, origin, status)
    VALUES ('00000000-0000-4000-8000-0000000000b0', 'refund', 'CAP-13', 100, 'USD', 'approval', 'pending');
    RAISE EXCEPTION 'case13 expected unique violation against the unknown row';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- daily cap: executing CAP-1 $15 + executed/auto CAP-8 $20 + unknown CAP-13 $10 = $45; $56 more would pass $100
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-14', 5600, 'USD',
         now() - interval '1 day', false, false, 'kate@example.com', 'over with unknown counted', 100000);
  IF (r->'checks'->>'daily_cap_ok')::boolean THEN RAISE EXCEPTION 'case13 unknown must count toward the daily cap: %', r->'checks'; END IF;

  -- 14. (v2) the amount may not exceed the capture total — enforced in SQL, not only in TypeScript
  BEGIN
    PERFORM payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-15', 1500, 'USD',
              now() - interval '1 day', false, false, 'leo@example.com', 'too much', 1000);
    RAISE EXCEPTION 'case14 expected an error for amount > capture total';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%exceeds the capture total%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM payment_actions WHERE target_id = 'CAP-15') THEN RAISE EXCEPTION 'case14 must not insert a row'; END IF;

  -- 15. (v2) an unknown customer is not an automatic pass: NULL and blank keys wait for approval
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-16', 500, 'USD',
         now() - interval '1 day', false, false, NULL, 'no email', 100000);
  IF (r->>'auto')::boolean OR (r->'checks'->>'customer_known')::boolean THEN RAISE EXCEPTION 'case15 NULL customer must wait for approval: %', r; END IF;
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-17', 500, 'USD',
         now() - interval '1 day', false, false, '   ', 'blank email', 100000);
  IF (r->>'auto')::boolean THEN RAISE EXCEPTION 'case15 blank customer must wait for approval: %', r; END IF;
  IF r->'action'->>'customer_key' IS NOT NULL THEN RAISE EXCEPTION 'case15 blank key must be stored as NULL: %', r->'action'; END IF;

  -- 16. (v2) the daily cap counts a UTC day, whatever the session time zone says
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'payment_action_open_refund') NOT LIKE '%AT TIME ZONE ''UTC''%' THEN
    RAISE EXCEPTION 'case16 the daily window must be computed in UTC';
  END IF;
  -- a row from the last minute of yesterday (UTC) never counts, in any session time zone
  SET LOCAL TIME ZONE 'Etc/GMT-14';
  INSERT INTO payment_actions (bot_id, kind, target_id, amount_cents, currency, origin, status, created_at)
  VALUES ('00000000-0000-4000-8000-0000000000b0', 'refund', 'CAP-YDAY', 9000, 'USD', 'auto', 'executed',
          (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 minute');
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-18', 2000, 'USD',
         now() - interval '1 day', false, false, 'mia@example.com', 'today', 100000);
  -- today so far: CAP-1 $15 (executing) + CAP-8 $20 + CAP-13 $10 (unknown) = $45; +$20 = $65 ≤ $100 → cap ok
  IF NOT (r->'checks'->>'daily_cap_ok')::boolean THEN RAISE EXCEPTION 'case16 yesterday''s row must not count toward today: %', r->'checks'; END IF;
  SET LOCAL TIME ZONE 'UTC';

  -- 17. (v2) the operator decides exactly once
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-19', 2500, 'USD',
         now() - interval '1 day', false, false, 'nina@example.com', 'big', 100000);
  IF r->'action'->>'status' <> 'pending' THEN RAISE EXCEPTION 'case17 setup expected pending: %', r->'action'; END IF;
  r := payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b0', 'approve', '00000000-0000-4000-8000-000000000001');
  IF NOT (r->>'updated')::boolean OR r->'action'->>'status' <> 'executing' OR r->'action'->>'origin' <> 'approval' THEN
    RAISE EXCEPTION 'case17 approve must move pending → executing once: %', r;
  END IF;
  IF r->'action'->>'decided_by' <> '00000000-0000-4000-8000-000000000001' OR r->'action'->>'decided_at' IS NULL THEN
    RAISE EXCEPTION 'case17 decided_by/decided_at not recorded: %', r->'action';
  END IF;
  r := payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b0', 'approve', '00000000-0000-4000-8000-000000000001');
  IF (r->>'updated')::boolean OR r->'action'->>'status' <> 'executing' THEN RAISE EXCEPTION 'case17 second approve must be a no-op: %', r; END IF;
  r := payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b0', 'reject', '00000000-0000-4000-8000-000000000001');
  IF (r->>'updated')::boolean THEN RAISE EXCEPTION 'case17 reject after approve must be a no-op: %', r; END IF;
  -- reject frees the slot
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-20', 2500, 'USD',
         now() - interval '1 day', false, false, 'omar@example.com', 'big', 100000);
  r := payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b0', 'reject', '00000000-0000-4000-8000-000000000001');
  IF NOT (r->>'updated')::boolean OR r->'action'->>'status' <> 'rejected' THEN RAISE EXCEPTION 'case17 reject must move pending → rejected: %', r; END IF;
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-20', 2500, 'USD',
         now() - interval '1 day', false, false, 'omar@example.com', 'again', 100000);
  IF NOT (r->>'created')::boolean THEN RAISE EXCEPTION 'case17 a rejected action must free the slot: %', r; END IF;
  -- wrong bot → not found; bad decision → error
  BEGIN
    PERFORM payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b1', 'approve', '00000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'case17 expected not-found for another bot';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%not found%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM payment_action_decide((r->'action'->>'id')::uuid, '00000000-0000-4000-8000-0000000000b0', 'maybe', '00000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'case17 expected an error for a bad decision';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%approve or reject%' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'payment_action_decide(uuid,uuid,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case17 anon must not execute payment_action_decide';
  END IF;

  -- 18. (v2) the old 10-argument RPC is gone
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'payment_action_open_refund' AND pronargs = 10) THEN
    RAISE EXCEPTION 'case18 the v1 (10-arg) guardrail RPC must be dropped';
  END IF;

  -- 19. (v2) the send gate: allowed only for executing/unknown; first attempt → first=true, retry → false;
  --     a closed row refuses the send; a pending (undecided) row too
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', NULL, 'CAP-21', 500, 'USD',
         now() - interval '1 day', false, false, 'paul@example.com', 'sent marker', 100000);
  r := payment_action_mark_sent((r->'action'->>'id')::uuid);
  IF NOT (r->>'allowed')::boolean OR NOT (r->>'first')::boolean THEN RAISE EXCEPTION 'case19 first mark_sent must be allowed+first: %', r; END IF;
  r := payment_action_mark_sent((SELECT id FROM payment_actions WHERE target_id = 'CAP-21'));
  IF NOT (r->>'allowed')::boolean OR (r->>'first')::boolean THEN RAISE EXCEPTION 'case19 second mark_sent must be allowed, not first: %', r; END IF;
  IF (SELECT send_attempts FROM payment_actions WHERE target_id = 'CAP-21') <> 2 THEN RAISE EXCEPTION 'case19 send_attempts must count every allowed call'; END IF;
  IF (SELECT sent_at FROM payment_actions WHERE target_id = 'CAP-21') IS NULL THEN RAISE EXCEPTION 'case19 sent_at must be set'; END IF;
  UPDATE payment_actions SET status = 'failed' WHERE target_id = 'CAP-21';
  r := payment_action_mark_sent((SELECT id FROM payment_actions WHERE target_id = 'CAP-21'));
  IF (r->>'allowed')::boolean OR r->>'status' <> 'failed' THEN RAISE EXCEPTION 'case19 a failed row must refuse the send: %', r; END IF;
  IF (SELECT send_attempts FROM payment_actions WHERE target_id = 'CAP-21') <> 2 THEN RAISE EXCEPTION 'case19 a refused send must not count'; END IF;
  r := payment_action_mark_sent((SELECT id FROM payment_actions WHERE target_id = 'CAP-16'));  -- CAP-16 is pending (case 15)
  IF (r->>'allowed')::boolean THEN RAISE EXCEPTION 'case19 a pending row must refuse the send: %', r; END IF;
  BEGIN
    PERFORM payment_action_mark_sent('00000000-0000-4000-8000-00000000dead');
    RAISE EXCEPTION 'case19 expected not-found';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%not found%' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'payment_action_mark_sent(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case19 anon must not execute payment_action_mark_sent';
  END IF;
  IF has_function_privilege('anon', 'payment_action_touch_reconcile(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case19 anon must not execute payment_action_touch_reconcile';
  END IF;

  -- 20. (4/6) the inbox badge: a pending refund raises it inside the RPC; the clear RPC lowers it only when
  --     no refund of the conversation is pending and the visitor has not asked for a human; auto rows do not raise it
  INSERT INTO conversations (id, bot_id, source, external_user_id)
  VALUES ('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b0', 'web', 'visitor-20');
  UPDATE bots SET propose_only = false, paypal_paused = false WHERE id = '00000000-0000-4000-8000-0000000000b0';
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000c0', 'CAP-30', 500, 'USD',
         now() - interval '1 day', false, false, 'quinn@example.com', 'auto one', 100000);
  IF NOT (r->>'auto')::boolean THEN RAISE EXCEPTION 'case20 setup expected auto: %', r; END IF;
  IF (SELECT escalated_at FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000c0') IS NOT NULL THEN
    RAISE EXCEPTION 'case20 an automatic refund must not raise the badge';
  END IF;
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000c0', 'CAP-31', 2500, 'USD',
         now() - interval '1 day', false, false, 'rita@example.com', 'needs a person', 100000);
  IF r->'action'->>'status' <> 'pending' THEN RAISE EXCEPTION 'case20 setup expected pending: %', r->'action'; END IF;
  IF (SELECT escalated_at FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000c0') IS NULL THEN
    RAISE EXCEPTION 'case20 a pending refund must raise the badge in the same transaction';
  END IF;
  r := payment_action_open_refund('00000000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000c0', 'CAP-32', 2500, 'USD',
         now() - interval '1 day', false, false, 'sam@example.com', 'second pending', 100000);
  -- one of two decided: still pending work → badge stays
  PERFORM payment_action_decide((SELECT id FROM payment_actions WHERE target_id = 'CAP-31'), '00000000-0000-4000-8000-0000000000b0', 'reject', '00000000-0000-4000-8000-000000000001');
  IF conversation_clear_refund_attention('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b0') THEN
    RAISE EXCEPTION 'case20 must not clear while another refund is pending';
  END IF;
  IF (SELECT escalated_at FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000c0') IS NULL THEN
    RAISE EXCEPTION 'case20 badge erased while CAP-32 is pending';
  END IF;
  -- the visitor asked for a human: not ours to lower
  UPDATE conversations SET handoff_requested_at = now() WHERE id = '00000000-0000-4000-8000-0000000000c0';
  PERFORM payment_action_decide((SELECT id FROM payment_actions WHERE target_id = 'CAP-32'), '00000000-0000-4000-8000-0000000000b0', 'reject', '00000000-0000-4000-8000-000000000001');
  IF conversation_clear_refund_attention('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b0') THEN
    RAISE EXCEPTION 'case20 must not clear while a human handoff is open';
  END IF;
  UPDATE conversations SET handoff_requested_at = NULL WHERE id = '00000000-0000-4000-8000-0000000000c0';
  -- nothing pending, no handoff → cleared, exactly once
  IF NOT conversation_clear_refund_attention('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b0') THEN
    RAISE EXCEPTION 'case20 expected the badge to clear';
  END IF;
  IF (SELECT escalated_at FROM conversations WHERE id = '00000000-0000-4000-8000-0000000000c0') IS NOT NULL THEN
    RAISE EXCEPTION 'case20 badge still up after clear';
  END IF;
  IF conversation_clear_refund_attention('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b0') THEN
    RAISE EXCEPTION 'case20 a second clear must report false';
  END IF;
  -- wrong bot → false, untouched
  UPDATE conversations SET escalated_at = now() WHERE id = '00000000-0000-4000-8000-0000000000c0';
  IF conversation_clear_refund_attention('00000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000b1') THEN
    RAISE EXCEPTION 'case20 another bot must not clear';
  END IF;
  IF has_function_privilege('anon', 'conversation_clear_refund_attention(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case20 anon must not execute conversation_clear_refund_attention';
  END IF;

  RAISE NOTICE 'guardrail scenario: 20 cases OK';
END $$;

-- (v2) the demo bot can only live in the sandbox
DO $$
BEGIN
  BEGIN
    UPDATE bots SET paypal_env = 'live' WHERE is_demo;
    IF FOUND THEN RAISE EXCEPTION 'demo bot must not be switchable to live'; END IF;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'demo bot sandbox check: OK';
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

-- 2026-10-21 PayPal stage 3 (5/6) — the sentence a visitor reads about a refund, written by the database:
-- once per (row, status), and only while the row IS in that status.
--
-- Step-5 review: writing the `payment` line as a separate best-effort INSERT after the status change left
-- three holes — a failed insert was never retried (money refunded, the visitor still reads "waiting"); a
-- stale caller could announce `unknown` twice; a delayed "being processed" could land AFTER "sent to
-- PayPal". All three close when the decision moves here, under the action's row lock:
--   payment_action_announce(action, status, body) → true when it wrote the line; false when
--     (a) the row is not in that status any more (a stale caller's sentence is dropped), or
--     (b) that status was already announced for this row (payment_announcements primary key), or
--     (c) the row has no conversation to speak into.
--   payment_actions_unannounced(limit) → rows whose current status has no line yet; the daily reaper
--     writes them. Nothing about money is retried to recover a sentence.
--
-- Rows that exist before this migration were never announced in-conversation; they are marked as announced
-- (including rows still pending/unknown at that moment) so the reaper does not address old conversations
-- retroactively. Such a backfilled row has response_id NULL: that means "suppressed", not "delivered".

CREATE TABLE IF NOT EXISTS payment_announcements (
  action_id   UUID NOT NULL REFERENCES payment_actions(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  response_id UUID REFERENCES responses(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, status)
);
ALTER TABLE payment_announcements ENABLE ROW LEVEL SECURITY;

INSERT INTO payment_announcements (action_id, status)
SELECT id, status
  FROM payment_actions
 WHERE status IN ('pending', 'unknown', 'executed', 'failed', 'rejected')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION payment_action_announce(p_action_id uuid, p_status text, p_body text) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  a             payment_actions%ROWTYPE;
  v_response_id uuid;
BEGIN
  IF p_body IS NULL OR length(btrim(p_body)) = 0 THEN
    RAISE EXCEPTION 'announcement body required';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending', 'unknown', 'executed', 'failed', 'rejected') THEN
    RAISE EXCEPTION 'status % is never announced', p_status;
  END IF;

  -- The row lock orders this against the status UPDATEs: a settle that moves the row waits for a running
  -- announce, and an announce for a status the row has already left returns false.
  SELECT * INTO a FROM payment_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR a.conversation_id IS NULL THEN
    RETURN false;
  END IF;
  IF a.status <> p_status THEN
    RETURN false;
  END IF;

  INSERT INTO payment_announcements (action_id, status) VALUES (p_action_id, p_status)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO responses (bot_id, conversation_id, response_type, response_body, delivered_at)
  VALUES (a.bot_id, a.conversation_id, 'payment', p_body, now())
  RETURNING id INTO v_response_id;
  UPDATE payment_announcements SET response_id = v_response_id
   WHERE action_id = p_action_id AND status = p_status;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION payment_action_announce(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_action_announce(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION payment_actions_unannounced(p_limit integer DEFAULT 50) RETURNS SETOF payment_actions
LANGUAGE sql
STABLE
AS $$
  SELECT a.*
    FROM payment_actions a
   WHERE a.kind = 'refund'
     AND a.conversation_id IS NOT NULL
     AND a.status IN ('pending', 'unknown', 'executed', 'failed', 'rejected')
     AND NOT EXISTS (SELECT 1 FROM payment_announcements n WHERE n.action_id = a.id AND n.status = a.status)
   ORDER BY a.updated_at ASC
   LIMIT GREATEST(COALESCE(p_limit, 50), 1);
$$;

REVOKE ALL ON FUNCTION payment_actions_unannounced(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_actions_unannounced(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run by hand; not executed by the migration) ────────────────────────────────────────
-- The `payment` lines already written to `responses` stay (they are conversation history); only the
-- once-per-(row, status) bookkeeping and the two functions go.
-- DROP FUNCTION IF EXISTS payment_actions_unannounced(integer);
-- DROP FUNCTION IF EXISTS payment_action_announce(uuid, text, text);
-- DROP TABLE IF EXISTS payment_announcements;
-- NOTIFY pgrst, 'reload schema';

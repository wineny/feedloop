-- Only an authenticated operator request can start a fresh exhausted recovery cycle.
CREATE TABLE IF NOT EXISTS classification_recovery_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE, operator_id uuid NOT NULL,
 previous_attempts integer NOT NULL, previous_error text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE classification_recovery_cycles ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION retry_exhausted_classification(p_message_id uuid,p_operator_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE m messages;
BEGIN
 SELECT msg.* INTO m FROM messages msg JOIN bots b ON b.id=msg.bot_id
 WHERE msg.id=p_message_id AND b.user_id=p_operator_id FOR UPDATE OF msg;
 IF NOT FOUND OR m.classification_state<>'exhausted' THEN RETURN false; END IF;
 INSERT INTO classification_recovery_cycles(message_id,bot_id,operator_id,previous_attempts,previous_error)
 VALUES(m.id,m.bot_id,p_operator_id,m.classification_attempts,m.classification_error);
 UPDATE messages SET classification_state='pending',classification_attempts=0,classification_next_at=now(),classification_lease=NULL,classification_error=NULL WHERE id=m.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION retry_exhausted_classification(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_exhausted_classification(uuid,uuid) TO service_role;

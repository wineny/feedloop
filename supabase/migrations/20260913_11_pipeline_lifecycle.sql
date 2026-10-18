-- Preserve historical completed rows: unknown execution proof is never validated.
ALTER TABLE auto_dev_runs
 ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'unknown',
 ADD COLUMN IF NOT EXISTS validation_evidence jsonb,
 ADD COLUMN IF NOT EXISTS publication_intent jsonb,
 ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'none',
 ADD COLUMN IF NOT EXISTS stop_reason text,
 ADD COLUMN IF NOT EXISTS lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS lease_token uuid,
 ADD COLUMN IF NOT EXISTS deployment_status text NOT NULL DEFAULT 'unknown',
 ADD COLUMN IF NOT EXISTS deployment_reason text,
 ADD COLUMN IF NOT EXISTS merge_commit_sha text,
 ADD COLUMN IF NOT EXISTS follow_up_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS follow_up_error text,
 ADD COLUMN IF NOT EXISTS generation_budget jsonb;
CREATE TABLE IF NOT EXISTS auto_dev_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES auto_dev_runs(id) ON DELETE CASCADE,
 attempt integer NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,attempt)
);
ALTER TABLE auto_dev_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attempts_owner ON auto_dev_attempts;
CREATE POLICY attempts_owner ON auto_dev_attempts FOR SELECT USING (EXISTS (SELECT 1 FROM auto_dev_runs r JOIN bots b ON b.id=r.bot_id WHERE r.id=run_id AND b.user_id=auth.uid()));
-- Advisory locks serialize even legacy duplicate targets without deleting historical records.
CREATE OR REPLACE FUNCTION create_pipeline_run(p_bot_id uuid,p_group_id uuid DEFAULT NULL,p_insight_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE g insight_groups; i insights; result uuid;
BEGIN
 IF (p_group_id IS NULL)=(p_insight_id IS NULL) THEN RAISE EXCEPTION 'exactly one target required'; END IF;
 IF p_insight_id IS NOT NULL THEN
  SELECT * INTO STRICT i FROM insights WHERE id=p_insight_id AND bot_id=p_bot_id;
  p_group_id:=i.group_id;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_bot_id::text||':'||coalesce(p_group_id,p_insight_id)::text,0));
 IF p_group_id IS NOT NULL THEN
  SELECT * INTO STRICT g FROM insight_groups WHERE id=p_group_id AND bot_id=p_bot_id FOR UPDATE;
  IF g.status<>'open' OR g.follow_up_pending THEN RAISE EXCEPTION 'group_follow_up_hold'; END IF;
  IF g.category NOT IN ('bug','ux') THEN RAISE EXCEPTION 'category_not_fixable'; END IF;
  p_insight_id:=NULL;
 ELSIF i.category NOT IN ('bug','ux') THEN RAISE EXCEPTION 'category_not_fixable'; END IF;
 SELECT id INTO result FROM auto_dev_runs WHERE bot_id=p_bot_id
 AND ((p_group_id IS NOT NULL AND (group_id=p_group_id OR (group_id IS NULL AND insight_id IN (SELECT id FROM insights WHERE group_id=p_group_id)))) OR (p_group_id IS NULL AND insight_id=p_insight_id))
 AND (status IN ('running','in_progress') OR publication_status='pending' OR (pr_url IS NOT NULL AND closed_at IS NULL))
 ORDER BY created_at LIMIT 1;
 IF result IS NOT NULL THEN
  IF p_group_id IS NOT NULL THEN UPDATE auto_dev_runs SET group_id=p_group_id WHERE id=result AND group_id IS NULL; END IF;
  RETURN result;
 END IF;
 INSERT INTO auto_dev_runs(bot_id,group_id,insight_id,status) VALUES(p_bot_id,p_group_id,p_insight_id,'running') RETURNING id INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION create_pipeline_run(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_pipeline_run(uuid,uuid,uuid) TO service_role;
ALTER TABLE responses ADD COLUMN IF NOT EXISTS email_delivery_status text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS email_attempted_at timestamptz;
UPDATE responses SET email_delivery_status='sent' WHERE email_sent_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS responses_loop_closed_once ON responses(auto_dev_run_id,conversation_id);
CREATE OR REPLACE FUNCTION claim_response_email(p_id uuid,p_bot_id uuid,p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE claimed uuid;
BEGIN
 -- A dead worker could already have sent. Never reset uncertain delivery to pending.
 UPDATE responses SET email_delivery_status='delivery_unknown',email_error='Dispatch interrupted; reconcile provider before retry'
 WHERE id=p_id AND email_delivery_status='dispatching' AND email_attempted_at<now()-interval '1 minute';
 UPDATE responses SET email_delivery_status='dispatching',email_attempted_at=now()
 WHERE id=p_id AND bot_id=p_bot_id AND conversation_id=p_conversation_id AND email_sent_at IS NULL AND email_delivery_status IN ('pending','failed') RETURNING id INTO claimed;
 RETURN claimed IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION claim_response_email(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_response_email(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION claim_pipeline_run(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result uuid;
BEGIN
 UPDATE auto_dev_runs SET status='in_progress',lease_until=now()+interval '240 seconds',lease_token=gen_random_uuid()
 WHERE id=p_id AND (status='running' OR (status='in_progress' AND lease_until<now()) OR (status='failed' AND publication_status='pending'))
 RETURNING id INTO result;
 RETURN result IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION claim_pipeline_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pipeline_run(uuid) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS auto_dev_active_group ON auto_dev_runs(group_id) WHERE group_id IS NOT NULL AND status IN ('running','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS auto_dev_active_insight ON auto_dev_runs(insight_id) WHERE group_id IS NULL AND insight_id IS NOT NULL AND status IN ('running','in_progress');
CREATE OR REPLACE FUNCTION complete_pipeline_run(p_id uuid,p_token uuid,p_result jsonb,p_duration integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r auto_dev_runs;
BEGIN
 SELECT * INTO STRICT r FROM auto_dev_runs WHERE id=p_id FOR UPDATE;
 IF r.status<>'in_progress' OR r.lease_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
 IF r.validation_status<>'validated' OR r.publication_status<>'pending'
 OR NOT coalesce(r.validation_evidence @> '{"status":"validated"}'::jsonb,false)
 OR NOT coalesce((r.validation_evidence->>'patchDigest') ~ '^[a-f0-9]{64}$',false)
 OR NOT coalesce((r.validation_evidence->>'profileDigest') ~ '^[a-f0-9]{64}$',false)
 OR NOT coalesce((r.validation_evidence->>'baseSha') ~ '^[a-f0-9]{40}$',false)
 OR r.validation_evidence->>'patchDigest' IS DISTINCT FROM r.publication_intent->>'patchDigest'
 OR r.validation_evidence->>'profileDigest' IS DISTINCT FROM r.publication_intent->>'profileDigest'
 OR r.validation_evidence->>'baseSha' IS DISTINCT FROM r.publication_intent->>'baseSha'
 OR r.validation_evidence->>'runId' IS DISTINCT FROM p_id::text
 OR p_result->>'pr_url' IS NULL THEN RAISE EXCEPTION 'publication_evidence_mismatch'; END IF;
 UPDATE auto_dev_runs SET status='completed',publication_status='published',pr_url=p_result->>'pr_url',pr_number=(p_result->>'pr_number')::integer,
 files_changed=p_result->'files_changed',duration_ms=p_duration,error_message=NULL,stop_reason=NULL WHERE id=p_id;
 IF r.group_id IS NOT NULL THEN UPDATE insight_groups SET status='pr_created' WHERE id=r.group_id AND status='open'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) TO service_role;
CREATE OR REPLACE FUNCTION record_pipeline_attempt(p_id uuid,p_token uuid,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE next_attempt integer;
BEGIN
 PERFORM id FROM auto_dev_runs WHERE id=p_id AND lease_token=p_token AND status='in_progress' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
 SELECT coalesce(max(attempt),0)+1 INTO next_attempt FROM auto_dev_attempts WHERE run_id=p_id;
 INSERT INTO auto_dev_attempts(run_id,attempt,evidence) VALUES(p_id,next_attempt,p_evidence);
 UPDATE auto_dev_runs SET validation_status=p_evidence->>'status',validation_evidence=p_evidence WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION record_pipeline_attempt(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_pipeline_attempt(uuid,uuid,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

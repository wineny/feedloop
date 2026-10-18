-- Capture the token in the same statement that acquires the lease.
BEGIN;
DROP FUNCTION claim_pipeline_run(uuid);
CREATE FUNCTION claim_pipeline_run(p_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE token uuid;
BEGIN
 UPDATE auto_dev_runs SET status='in_progress',lease_until=clock_timestamp()+interval '240 seconds',lease_token=gen_random_uuid()
 WHERE id=p_id AND (status='running' OR (status='in_progress' AND lease_until<clock_timestamp())
 OR (status IN ('failed','stopped','unverifiable') AND publication_status='pending' AND publication_intent IS NOT NULL))
 RETURNING lease_token INTO token;
 RETURN token;
END $$;
REVOKE ALL ON FUNCTION claim_pipeline_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pipeline_run(uuid) TO service_role;
CREATE OR REPLACE FUNCTION assert_pipeline_run_lease(p_id uuid,p_token uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 -- GitHub requests are capped at 30s; do not start one at the lease boundary.
 SELECT EXISTS(SELECT 1 FROM auto_dev_runs WHERE id=p_id AND lease_token=p_token AND status='in_progress' AND lease_until>clock_timestamp()+interval '30 seconds');
$$;
REVOKE ALL ON FUNCTION assert_pipeline_run_lease(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_pipeline_run_lease(uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION save_pipeline_run(p_id uuid,p_token uuid,p_values jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r auto_dev_runs;
BEGIN
 SELECT * INTO r FROM auto_dev_runs WHERE id=p_id AND lease_token=p_token AND status='in_progress' AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE k NOT IN ('status','error_message','duration_ms','stop_reason','validation_status','validation_evidence','publication_status','publication_intent','generation_budget')) THEN RAISE EXCEPTION 'invalid_run_patch'; END IF;
 r:=jsonb_populate_record(r,p_values);
 UPDATE auto_dev_runs SET status=r.status,error_message=r.error_message,duration_ms=r.duration_ms,stop_reason=r.stop_reason,
 validation_status=r.validation_status,validation_evidence=r.validation_evidence,publication_status=r.publication_status,
 publication_intent=r.publication_intent,generation_budget=r.generation_budget WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION save_pipeline_run(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_pipeline_run(uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION complete_pipeline_run(p_id uuid,p_token uuid,p_result jsonb,p_duration integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r auto_dev_runs;
BEGIN
 SELECT * INTO STRICT r FROM auto_dev_runs WHERE id=p_id FOR UPDATE;
 IF r.status<>'in_progress' OR r.lease_token IS DISTINCT FROM p_token OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
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
 PERFORM id FROM auto_dev_runs WHERE id=p_id AND lease_token=p_token AND status='in_progress' AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
 SELECT coalesce(max(attempt),0)+1 INTO next_attempt FROM auto_dev_attempts WHERE run_id=p_id;
 INSERT INTO auto_dev_attempts(run_id,attempt,evidence) VALUES(p_id,next_attempt,p_evidence);
 UPDATE auto_dev_runs SET validation_status=p_evidence->>'status',validation_evidence=p_evidence WHERE id=p_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION record_pipeline_attempt(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_pipeline_attempt(uuid,uuid,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

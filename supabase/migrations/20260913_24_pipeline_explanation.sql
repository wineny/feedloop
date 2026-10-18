-- Preserve the final-candidate explanation with the lease-bound completion transaction.
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
 files_changed=p_result->'files_changed',explanation=p_result->'explanation',duration_ms=p_duration,error_message=NULL,stop_reason=NULL WHERE id=p_id;
 IF r.group_id IS NOT NULL THEN UPDATE insight_groups SET status='pr_created' WHERE id=r.group_id AND status='open'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) TO service_role;

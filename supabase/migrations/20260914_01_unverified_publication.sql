-- 검증 프로필이 없는 실행도 발행을 «확정»할 수 있게 한다 (2026-09-14).
--
-- 왜: 검증 프로필은 제보 하나마다 사람이 손으로 쓰는 것이고 생성하는 코드가 없다.
-- 앱은 프로필이 없으면 검증 없이 PR 을 열고 validation_status='unverifiable' 로 남기는데,
-- 이 함수가 'validated' 만 받으면 PR 이 GitHub 에 «만들어진 뒤» 예외가 난다 —
-- run 은 failed, pr_url 은 NULL, 레포엔 고아 PR. 재시도해도 같은 자리에서 또 실패한다.
-- 그러면 앱 안 PR 검토·반영·머지 감지·되돌림·메일이 전부 도달하지 못한다.
--
-- 강한 경로(validation_status='validated')의 검사식은 «한 글자도» 바꾸지 않았다.
-- 아래 ELSIF 가지 하나만 새로 열었다.
CREATE OR REPLACE FUNCTION complete_pipeline_run(p_id uuid,p_token uuid,p_result jsonb,p_duration integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r auto_dev_runs;
BEGIN
 SELECT * INTO STRICT r FROM auto_dev_runs WHERE id=p_id FOR UPDATE;
 IF r.status<>'in_progress' OR r.lease_token IS DISTINCT FROM p_token OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'execution_lease_lost'; END IF;
 IF r.publication_status<>'pending' OR p_result->>'pr_url' IS NULL THEN RAISE EXCEPTION 'publication_evidence_mismatch'; END IF;
 IF r.validation_status='validated' THEN
  -- 종전 그대로 — 증거와 발행 의사가 서로를 묶어야 한다.
  IF NOT coalesce(r.validation_evidence @> '{"status":"validated"}'::jsonb,false)
  OR NOT coalesce((r.validation_evidence->>'patchDigest') ~ '^[a-f0-9]{64}$',false)
  OR NOT coalesce((r.validation_evidence->>'profileDigest') ~ '^[a-f0-9]{64}$',false)
  OR NOT coalesce((r.validation_evidence->>'baseSha') ~ '^[a-f0-9]{40}$',false)
  OR r.validation_evidence->>'patchDigest' IS DISTINCT FROM r.publication_intent->>'patchDigest'
  OR r.validation_evidence->>'profileDigest' IS DISTINCT FROM r.publication_intent->>'profileDigest'
  OR r.validation_evidence->>'baseSha' IS DISTINCT FROM r.publication_intent->>'baseSha'
  OR r.validation_evidence->>'runId' IS DISTINCT FROM p_id::text THEN RAISE EXCEPTION 'publication_evidence_mismatch'; END IF;
 ELSIF r.validation_status='unverifiable' THEN
  -- 이 제보를 겨냥한 검증 프로필이 없어 증거가 «없다».
  -- 증거를 지어낸 run 은 여기로 못 온다 — evidence 는 반드시 NULL 이어야 한다.
  -- 묶을 증거가 없으므로 발행 의사가 스스로 온전해야 하고,
  -- 프로필 자리엔 digest(null) 이 박혀 있어야 한다(앱의 UNVERIFIED_PROFILE_DIGEST 와 같은 값).
  -- 이 값은 sha256('null') 이고 프로필 객체는 늘 '{...}' 로 직렬화되므로 서로 겹칠 수 없다.
  IF r.validation_evidence IS NOT NULL
  OR r.publication_intent->>'profileDigest' IS DISTINCT FROM '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'
  OR NOT coalesce((r.publication_intent->>'patchDigest') ~ '^[a-f0-9]{64}$',false)
  OR NOT coalesce((r.publication_intent->>'baseSha') ~ '^[a-f0-9]{40}$',false)
  OR r.publication_intent->>'runId' IS DISTINCT FROM p_id::text THEN RAISE EXCEPTION 'publication_evidence_mismatch'; END IF;
 ELSE
  -- 그 밖의 상태(failed·stopped·NULL)로는 발행을 확정할 수 없다.
  RAISE EXCEPTION 'publication_evidence_mismatch';
 END IF;
 UPDATE auto_dev_runs SET status='completed',publication_status='published',pr_url=p_result->>'pr_url',pr_number=(p_result->>'pr_number')::integer,
 files_changed=p_result->'files_changed',explanation=p_result->'explanation',duration_ms=p_duration,error_message=NULL,stop_reason=NULL WHERE id=p_id;
 IF r.group_id IS NOT NULL THEN UPDATE insight_groups SET status='pr_created' WHERE id=r.group_id AND status='open'; END IF;
 RETURN true;
END $$;
-- Supabase 는 새 함수에 anon·authenticated EXECUTE 를 기본 부여한다. PUBLIC 회수만으로는 안 좁혀진다.
REVOKE ALL ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_pipeline_run(uuid,uuid,jsonb,integer) TO service_role;

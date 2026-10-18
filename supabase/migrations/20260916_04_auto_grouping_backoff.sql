-- I-10 후속 (보안 리뷰 N2·M1): 실패 재무장의 지수 백오프 + 클레임 횟수 계측.
--
-- N2: `auto_grouping_release(p_ok=false)` 가 due 를 10분 뒤로 다시 심는데, 사람이 묶음을 닫기 전엔
--     절대 성공할 수 없는 실패(`invalid_or_omitted_proposals`)가 있다. 그 봇은 하루 144회 묶기 호출을
--     무기한 태운다. 연속 실패 횟수를 세어 10분 → 20 → 40 … 최대 6시간으로 늘린다. 성공하면 0.
-- M1: 묶기 LLM 호출은 일일 예산(`bump_bot_usage`)을 안 탄다. 차단은 안 하되 «몇 번 돌았나»는 읽을 수
--     있어야 제출 뒤 실제 비용을 본다. 클레임이 곧 실행이므로 클레임 때 센다(수동·배치·자동 전부).

ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_failures integer NOT NULL DEFAULT 0;
ALTER TABLE grouping_revisions ADD COLUMN IF NOT EXISTS auto_group_claims integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION auto_grouping_claim(p_bot_id uuid, p_require_due boolean DEFAULT true, p_lock_seconds integer DEFAULT 150)
RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE token uuid := gen_random_uuid();
BEGIN
  INSERT INTO grouping_revisions(bot_id) VALUES (p_bot_id) ON CONFLICT DO NOTHING;
  UPDATE grouping_revisions
     SET auto_group_lock_until = now() + make_interval(secs => greatest(p_lock_seconds, 1)),
         auto_group_lock_token = token,
         auto_group_due_at = NULL,
         auto_group_first_requested_at = NULL,
         auto_group_waiter_until = NULL,
         auto_group_claims = auto_group_claims + 1
   WHERE bot_id = p_bot_id
     AND (auto_group_lock_until IS NULL OR auto_group_lock_until < now())
     AND (NOT p_require_due OR (auto_group_due_at IS NOT NULL AND auto_group_due_at <= now()));
  IF FOUND THEN RETURN token; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION auto_grouping_release(p_bot_id uuid, p_token uuid, p_ok boolean DEFAULT true, p_retry_seconds integer DEFAULT 600)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r grouping_revisions; retry_secs double precision;
BEGIN
  SELECT * INTO r FROM grouping_revisions WHERE bot_id = p_bot_id AND auto_group_lock_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- 실패 n회째 재시도 간격 = retry × 2^n, 최대 6시간.
  retry_secs := least(greatest(p_retry_seconds, 1) * power(2, least(r.auto_group_failures, 12)), 6 * 3600);
  UPDATE grouping_revisions
     SET auto_group_lock_until = NULL,
         auto_group_lock_token = NULL,
         auto_grouped_at = CASE WHEN p_ok THEN now() ELSE auto_grouped_at END,
         auto_group_failures = CASE WHEN p_ok THEN 0 ELSE auto_group_failures + 1 END,
         auto_group_due_at = CASE WHEN p_ok THEN auto_group_due_at
                                  ELSE coalesce(auto_group_due_at, now() + make_interval(secs => retry_secs)) END,
         auto_group_first_requested_at = CASE WHEN p_ok THEN auto_group_first_requested_at
                                              ELSE coalesce(auto_group_first_requested_at, now()) END
   WHERE bot_id = p_bot_id;
  RETURN true;
END $$;

-- 시그니처 불변(CREATE OR REPLACE) → 20260916_03 의 REVOKE/GRANT 가 그대로 유지된다.
NOTIFY pgrst, 'reload schema';

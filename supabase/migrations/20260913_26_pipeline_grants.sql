-- 파이프라인 RPC 권한 정리 — service_role 만 남긴다.
--
-- 왜 필요한가: Supabase 는 **새로 만든 함수에 anon·authenticated EXECUTE 를 기본 부여**한다.
-- `20260913_10` 은 마지막에 `REVOKE … FROM PUBLIC, anon, authenticated` 를 갖고 있어 안전했지만,
-- `_11`(create/claim/complete/record/save_pipeline_run) · `_12`(retry_exhausted_classification) ·
-- `_23`(assert_pipeline_run_lease, 재정의된 run 함수들) 은 그 줄이 없었다.
-- 프로덕션 적용 직후 실측에서 8개 함수가 anon 에 열려 있었다 — `anon` 키는 브라우저에 공개되므로
-- 누구나 실행을 가로채거나(claim/complete/save_pipeline_run) 재분류를 강제해(retry_…) 토큰을 태울 수 있었다.
--
-- ⚠️ `REVOKE … FROM PUBLIC` 만으로는 안 좁혀진다. anon·authenticated 를 **명시적으로** 회수해야 한다.
-- 서버는 service_role 로만 부르므로 회수해도 동작은 그대로다.
--
-- 이름으로 도는 이유: 같은 이름이 여러 시그니처로 재정의돼 있어(`claim_pipeline_run` 등
-- `_11` 과 `_23` 이 각각 만든 판) 인자를 손으로 적으면 하나를 빠뜨린다.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND (p.proname LIKE 'pipeline%' OR p.proname IN (
        'claim_response_email','retry_exhausted_classification','confirm_widget_resolution',
        'claim_handoff_email','save_run_verdict','create_pipeline_run','claim_pipeline_run',
        'complete_pipeline_run','record_pipeline_attempt','save_pipeline_run','assert_pipeline_run_lease'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

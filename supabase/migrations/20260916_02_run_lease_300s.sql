-- 실행 리스 240 → 300초 (2026-09-16).
--
-- 리스는 클레임 때 한 번 정해지고 «갱신되지 않는다». assert 가 30초 여유를 요구하므로 실효 210초였다.
-- 2-pass 출력 한도를 16,000 → 24,000 으로 올리자(위젯 「화면에서 선택하기」가 컴포넌트 파일을 후보에 더해
-- page.tsx 28KB + 컴포넌트 재작성) 2-pass 가 216초까지 갔고, 분석은 정답이었는데 마지막 저장에서
-- execution_lease_lost 로 통째로 버려졌다(데모 레포 실측). 라우트의 maxDuration 이 300 이라 그 위로는 어차피 못 간다.
BEGIN;
CREATE OR REPLACE FUNCTION claim_pipeline_run(p_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE token uuid;
BEGIN
 UPDATE auto_dev_runs SET status='in_progress',lease_until=clock_timestamp()+interval '300 seconds',lease_token=gen_random_uuid()
 WHERE id=p_id AND (status='running' OR (status='in_progress' AND lease_until<clock_timestamp())
 OR (status IN ('failed','stopped','unverifiable') AND publication_status='pending' AND publication_intent IS NOT NULL))
 RETURNING lease_token INTO token;
 RETURN token;
END $$;
REVOKE ALL ON FUNCTION claim_pipeline_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_pipeline_run(uuid) TO service_role;
COMMIT;

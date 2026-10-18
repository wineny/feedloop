-- B1 기존 묶음 대조 (2026-09-17) — 스냅샷이 싣는 기존 묶음을 «최근 30개» 로 자른다.
--
-- 왜: `pipeline_group_snapshot` 은 이 봇의 묶음을 «전부» 실어 줬다(상한은 500개 초과를 막는 검사뿐).
-- 그게 그대로 묶기 프롬프트에 들어간다. 묶음이 쌓일수록 입력이 커지고, 입력이 커지면 모델이
-- 목록을 대충 읽어 기존 묶음 대조 자체가 나빠진다(백로그 B1 「주의」). 30 은 JS 쪽
-- `EXISTING_GROUPS_LIMIT` 과 같은 값이다 — 한쪽만 바꾸면 즉답(F1)과 묶기가 다른 목록을 본다.
--
-- 순서: 최근 30개를 «고른 뒤» 오래된 것부터 담는다. 고를 때는 최신순이어야 최근 것이 남고,
-- 담을 때는 예전과 같은 순서(created_at, id)여야 프롬프트 모양이 안 바뀐다.
-- 시그니처·나머지 로직은 20260916_03 그대로 → 기존 GRANT 유지.

CREATE OR REPLACE FUNCTION pipeline_group_snapshot(p_bot_id uuid,p_limit integer DEFAULT 40)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE rev bigint; existing jsonb; candidates jsonb; pending integer;
BEGIN
 INSERT INTO grouping_revisions(bot_id) VALUES(p_bot_id) ON CONFLICT DO NOTHING;
 SELECT revision INTO rev FROM grouping_revisions WHERE bot_id=p_bot_id FOR UPDATE;
 IF (SELECT count(*) FROM insight_groups WHERE bot_id=p_bot_id)>500 THEN RAISE EXCEPTION 'grouping_capacity_requires_partition'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g) - 'created_at' ORDER BY g.created_at, g.id),'[]') INTO existing FROM (
   SELECT id,title,summary,category,status,created_at
     FROM insight_groups WHERE bot_id=p_bot_id
    ORDER BY created_at DESC, id DESC LIMIT 30) g;
 SELECT count(*) INTO pending FROM insights WHERE bot_id=p_bot_id AND group_id IS NULL AND category IN ('bug','ux','feature_request');
 SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') INTO candidates FROM (
   SELECT i.id, i.category, i.summary, m.conversation_id
     FROM insights i LEFT JOIN messages m ON m.id = i.message_id
    WHERE i.bot_id=p_bot_id AND i.group_id IS NULL AND i.category IN ('bug','ux','feature_request')
    ORDER BY i.created_at, i.id LIMIT least(greatest(p_limit,1),40)) i;
 RETURN jsonb_build_object('revision',rev,'existing',existing,'insights',candidates,'pending',pending);
END $$;

NOTIFY pgrst, 'reload schema';

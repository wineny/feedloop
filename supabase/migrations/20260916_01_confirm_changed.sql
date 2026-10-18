-- 되돌림 확인 RPC 가 「값이 실제로 바뀌었는지」를 알려준다.
--
-- 왜: 「아직 그대로예요」를 누르면 라우트가 운영자에게 알림을 보낸다. 그런데 이 RPC 는 멱등이라
-- 같은 값을 다시 받으면 아무것도 안 바꾸고 기존 값을 그대로 돌려줬다 — 라우트가 「바뀌었나」를
-- 알 수 없어 요청마다 발송기를 깨웠다. 메일은 발송기의 상한(대화당 1시간 1통)이 막지만,
-- 상한에 걸려 돌아 나오기까지 DB 왕복 5회와 배타 잠금 2개가 매번 돌았다.
-- 게다가 이 라우트에는 방문자 속도제한이 사실상 없다 — `visitorRateExceeded` 가 `messages` 행을
-- 세는데 확인 요청은 메시지를 만들지 않기 때문이다(IP 60회/분만 남는다).
--
-- 시그니처·반환 타입은 그대로다(jsonb 에 키 하나 추가). 구버전 앱은 이 키를 그냥 무시하므로
-- 배포 순서를 타지 않는다 — 마이그레이션을 먼저 적용해도 안전하다.
CREATE OR REPLACE FUNCTION confirm_widget_resolution(p_bot_id uuid, p_visitor_id uuid, p_response_id uuid, p_confirmation text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r responses; run auto_dev_runs; changed_at timestamptz; did_change boolean := false;
BEGIN
 IF p_confirmation IS NOT NULL AND p_confirmation NOT IN ('fixed','not_fixed') THEN RAISE EXCEPTION 'invalid_confirmation'; END IF;
 SELECT response.* INTO r FROM responses response
 JOIN conversations c ON c.id=response.conversation_id AND c.bot_id=response.bot_id
 JOIN bots b ON b.id=response.bot_id
 JOIN auto_dev_runs a ON a.id=response.auto_dev_run_id AND a.bot_id=response.bot_id
 WHERE response.id=p_response_id AND response.bot_id=p_bot_id
 AND c.source='web' AND c.external_user_id=p_visitor_id::text
 AND b.status<>'paused' AND response.response_type='loop_closed'
 AND response.delivered_at IS NOT NULL AND a.merged_at IS NOT NULL
 FOR UPDATE OF response;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p_confirmation IS NOT NULL AND r.user_confirmation IS DISTINCT FROM p_confirmation THEN
  did_change := true;
  changed_at:=clock_timestamp();
  UPDATE responses SET user_confirmation=p_confirmation,user_confirmed_at=changed_at WHERE id=r.id;
  INSERT INTO response_confirmation_history(response_id,confirmation,confirmed_at) VALUES(r.id,p_confirmation,changed_at);
  IF p_confirmation='not_fixed' THEN
   SELECT * INTO run FROM auto_dev_runs WHERE id=r.auto_dev_run_id;
   UPDATE insight_groups SET follow_up_pending=true WHERE bot_id=p_bot_id AND id=coalesce(run.group_id,(SELECT group_id FROM insights WHERE id=run.insight_id AND bot_id=p_bot_id));
   UPDATE conversations SET escalated_at=changed_at WHERE id=r.conversation_id AND bot_id=p_bot_id;
  END IF;
  r.user_confirmation:=p_confirmation; r.user_confirmed_at:=changed_at;
 END IF;
 RETURN jsonb_build_object('responseId',r.id,'confirmation',r.user_confirmation,'confirmedAt',r.user_confirmed_at,'changed',did_change);
END $$;
REVOKE ALL ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) TO service_role;

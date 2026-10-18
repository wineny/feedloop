-- 「상담원에게 전달됐어요」는 방문자가 직접 부른 경우에만 (2026-09-16, ny 결정).
--
-- 왜: conversations.escalated_at 한 칸이 두 뜻을 겸했다 — 받은편지함 「담당자 확인 필요」 배지(운영자용)와
-- 위젯 하단 「상담원에게 전달됐어요」 상태 줄(방문자용). 그런데 이 칸은 AI 가 escalate:true 만 켜도
-- 찍힌다. 「여기가 이상」 같은 버그 제보에 AI 가 평범하게 되묻는 답을 하면서도 «팀 전달 필요» 플래그를
-- 켜면, 방문자는 아무것도 안 눌렀는데 하단이 「전달됐어요」로 바뀌고 「상담원 연결」 버튼이 사라졌다.
--
-- 그래서 «방문자가 직접 부른 시각»을 따로 둔다. 위젯의 escalated 는 이 칸만 본다. escalated_at 은
-- 종전대로 넓은 뜻(AI 물러남 포함)으로 받은편지함 배지에 쓴다. 운영자 답장은 둘 다 지운다.
--
-- 찍히는 경로 세 곳: 「상담원 연결」 버튼(escalate 라우트), 대기 문구 밑 제안 칩(같은 라우트),
-- 「아직 그대로예요」(아래 RPC — 운영자가 고쳤다고 답한 뒤 방문자가 누른 명시적 요청이라 같이 찍는다).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_requested_at TIMESTAMPTZ;

-- 이미 escalated 인 대화 중 방문자가 직접 부른 흔적(handoff_at 메시지)이 있는 건 새 칸도 채워 둔다.
-- 버튼만 누른 경우(메시지 없음)는 구분할 수 없어 비워 둔다 — 배지는 남고 위젯 상태 줄만 꺼진다.
UPDATE conversations c SET handoff_requested_at = c.escalated_at
 WHERE c.escalated_at IS NOT NULL AND c.handoff_requested_at IS NULL
 AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.handoff_at IS NOT NULL);

-- 20260916_01 과 같고, not_fixed 가 handoff_requested_at 도 찍는다는 한 줄만 다르다.
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
   UPDATE conversations SET escalated_at=changed_at, handoff_requested_at=changed_at WHERE id=r.conversation_id AND bot_id=p_bot_id;
  END IF;
  r.user_confirmation:=p_confirmation; r.user_confirmed_at:=changed_at;
 END IF;
 RETURN jsonb_build_object('responseId',r.id,'confirmation',r.user_confirmation,'confirmedAt',r.user_confirmed_at,'changed',did_change);
END $$;
REVOKE ALL ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) TO service_role;

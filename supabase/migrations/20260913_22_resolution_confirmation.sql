-- Visitor statements are independent of merge/deployment evidence.
CREATE TABLE IF NOT EXISTS response_confirmation_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 response_id uuid NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
 confirmation text NOT NULL CHECK (confirmation IN ('fixed','not_fixed')),
 confirmed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE response_confirmation_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON response_confirmation_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON response_confirmation_history TO service_role;

CREATE OR REPLACE FUNCTION confirm_widget_resolution(p_bot_id uuid, p_visitor_id uuid, p_response_id uuid, p_confirmation text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r responses; run auto_dev_runs; changed_at timestamptz;
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
 RETURN jsonb_build_object('responseId',r.id,'confirmation',r.user_confirmation,'confirmedAt',r.user_confirmed_at);
END $$;
REVOKE ALL ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION confirm_widget_resolution(uuid,uuid,uuid,text) TO service_role;

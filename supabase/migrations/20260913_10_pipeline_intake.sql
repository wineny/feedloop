-- Durable intake and per-bot atomic grouping. Local migration; service-role RPCs only.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification_state text NOT NULL DEFAULT 'pending'
  CHECK (classification_state IN ('pending','processing','failed','done','exhausted'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification_next_at timestamptz NOT NULL DEFAULT (now() + interval '90 seconds');
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification_lease uuid;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification_error text;
CREATE INDEX IF NOT EXISTS messages_classification_queue ON messages (classification_next_at, detected_at, id)
  WHERE classification_state IN ('pending','failed','processing');
CREATE TABLE IF NOT EXISTS insight_message_sources (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  insight_id uuid NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE
);
ALTER TABLE insight_message_sources ENABLE ROW LEVEL SECURITY;
-- Deliberately fail on historical conflicting membership; never erase customer evidence.
INSERT INTO insight_message_sources(message_id, insight_id, bot_id)
SELECT DISTINCT x.message_id, i.id, i.bot_id FROM insights i
CROSS JOIN LATERAL unnest(array_append(i.source_message_ids, i.message_id)) x(message_id)
WHERE x.message_id IS NOT NULL
ON CONFLICT (message_id) DO UPDATE SET insight_id = CASE
  WHEN insight_message_sources.insight_id = excluded.insight_id THEN excluded.insight_id ELSE NULL END;
UPDATE messages m SET classification_state='done', classification_next_at=now()
WHERE EXISTS (SELECT 1 FROM insight_message_sources s WHERE s.message_id=m.id);

CREATE OR REPLACE FUNCTION pipeline_source_membership() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE mid uuid;
BEGIN
  FOR mid IN SELECT DISTINCT x FROM unnest(array_append(NEW.source_message_ids,NEW.message_id)) x WHERE x IS NOT NULL ORDER BY x LOOP
    IF NOT EXISTS (SELECT 1 FROM messages WHERE id=mid AND bot_id=NEW.bot_id) THEN RAISE EXCEPTION 'source_bot_mismatch'; END IF;
    INSERT INTO insight_message_sources(message_id,insight_id,bot_id) VALUES(mid,NEW.id,NEW.bot_id)
      ON CONFLICT(message_id) DO UPDATE SET insight_id = CASE WHEN insight_message_sources.insight_id=excluded.insight_id THEN excluded.insight_id ELSE NULL END;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER pipeline_sources AFTER INSERT OR UPDATE OF message_id, source_message_ids ON insights
FOR EACH ROW EXECUTE FUNCTION pipeline_source_membership();

CREATE OR REPLACE FUNCTION pipeline_settle_insight(p_bot_id uuid,p_message_id uuid,p_insight jsonb,p_extend_id uuid DEFAULT NULL,p_lease uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE m messages; iid uuid; existing_id uuid;
BEGIN
 SELECT * INTO m FROM messages WHERE id=p_message_id AND bot_id=p_bot_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'message_not_saved'; END IF;
 IF p_lease IS NOT NULL AND (m.classification_lease IS DISTINCT FROM p_lease OR m.classification_state <> 'processing') THEN RAISE EXCEPTION 'stale_classification_lease'; END IF;
 SELECT insight_id INTO existing_id FROM insight_message_sources WHERE message_id=p_message_id;
 IF existing_id IS NOT NULL THEN
   UPDATE messages SET classification_state='done',classification_lease=NULL,classification_error=NULL WHERE id=p_message_id;
   RETURN jsonb_build_object('id',existing_id,'created',false);
 END IF;
 IF p_insight IS NOT NULL AND p_insight <> 'null'::jsonb THEN
   IF p_extend_id IS NOT NULL THEN
     -- Existing implementation protects published/grouped evidence. A blocked extension becomes a new report for grouping.
     SELECT extend_insight(p_bot_id,p_extend_id,p_message_id,p_insight->>'category',p_insight->>'summary',p_insight->>'sentiment',coalesce((p_insight->>'follow_up_needed')::boolean,false)) INTO iid;
   END IF;
   IF iid IS NULL THEN
     INSERT INTO insights(bot_id,message_id,category,summary,sentiment,follow_up_needed)
     VALUES(p_bot_id,p_message_id,p_insight->>'category',p_insight->>'summary',p_insight->>'sentiment',coalesce((p_insight->>'follow_up_needed')::boolean,false)) RETURNING id INTO iid;
   END IF;
 END IF;
 UPDATE messages SET classification_state='done',classification_lease=NULL,classification_error=NULL WHERE id=p_message_id;
 RETURN jsonb_build_object('id',iid,'created',iid IS NOT NULL AND p_extend_id IS DISTINCT FROM iid);
END $$;

CREATE OR REPLACE FUNCTION pipeline_claim_message(p_bot_ids uuid[])
RETURNS SETOF messages LANGUAGE plpgsql SET search_path=public AS $$
DECLARE chosen uuid;
BEGIN
 -- Serialize the short selection transaction: only one in-flight message per conversation.
 PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-classification-claim',0));
 UPDATE messages SET classification_state='exhausted',classification_error='retry_limit',classification_lease=NULL
 WHERE bot_id=ANY(p_bot_ids) AND classification_state IN ('failed','processing') AND classification_attempts>=3 AND classification_next_at<=now();
 SELECT m.id INTO chosen FROM messages m WHERE m.bot_id=ANY(p_bot_ids)
 AND m.classification_state IN ('pending','failed','processing') AND m.classification_next_at<=now() AND m.classification_attempts<3
 AND NOT EXISTS (SELECT 1 FROM messages busy WHERE busy.conversation_id=m.conversation_id AND busy.id<>m.id
    AND busy.classification_state='processing' AND busy.classification_next_at>now())
 ORDER BY m.detected_at,m.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF chosen IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE messages SET classification_state='processing',classification_attempts=classification_attempts+1,
 classification_lease=gen_random_uuid(),classification_next_at=now()+interval '90 seconds',classification_error=NULL
 WHERE id=chosen RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION pipeline_fail_message(p_bot_id uuid,p_message_id uuid,p_lease uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 UPDATE messages SET classification_state=CASE WHEN classification_attempts>=3 THEN 'exhausted' ELSE 'failed' END,
 classification_error=left(p_reason,120),classification_next_at=now()+make_interval(secs=>30*power(2,classification_attempts)::integer),classification_lease=NULL
 WHERE id=p_message_id AND bot_id=p_bot_id AND classification_state='processing' AND classification_lease=p_lease;
 RETURN FOUND;
END $$;

ALTER TABLE insight_groups ADD COLUMN IF NOT EXISTS follow_up_pending boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS grouping_revisions(bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, revision bigint NOT NULL DEFAULT 0);
ALTER TABLE grouping_revisions ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION pipeline_group_snapshot(p_bot_id uuid,p_limit integer DEFAULT 40)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE rev bigint; existing jsonb; candidates jsonb; pending integer;
BEGIN
 INSERT INTO grouping_revisions(bot_id) VALUES(p_bot_id) ON CONFLICT DO NOTHING;
 SELECT revision INTO rev FROM grouping_revisions WHERE bot_id=p_bot_id FOR UPDATE;
 IF (SELECT count(*) FROM insight_groups WHERE bot_id=p_bot_id)>500 THEN RAISE EXCEPTION 'grouping_capacity_requires_partition'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]') INTO existing FROM (SELECT id,title,summary,category,status FROM insight_groups WHERE bot_id=p_bot_id ORDER BY created_at,id) g;
 SELECT count(*) INTO pending FROM insights WHERE bot_id=p_bot_id AND group_id IS NULL AND category IN ('bug','ux','feature_request');
 SELECT coalesce(jsonb_agg(to_jsonb(i)),'[]') INTO candidates FROM (SELECT id,category,summary FROM insights WHERE bot_id=p_bot_id AND group_id IS NULL AND category IN ('bug','ux','feature_request') ORDER BY created_at,id LIMIT least(greatest(p_limit,1),40)) i;
 RETURN jsonb_build_object('revision',rev,'existing',existing,'insights',candidates,'pending',pending);
END $$;

CREATE OR REPLACE FUNCTION pipeline_commit_groups(p_bot_id uuid,p_revision bigint,p_groups jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE rev bigint; g jsonb; gid uuid; ids uuid[]; linked integer; total integer:=0; receipts jsonb:='[]'; title_text text; target_category text;
BEGIN
 SELECT revision INTO rev FROM grouping_revisions WHERE bot_id=p_bot_id FOR UPDATE;
 IF NOT FOUND OR rev<>p_revision THEN RAISE EXCEPTION 'stale_group_snapshot'; END IF;
 IF jsonb_typeof(p_groups)<>'array' THEN RAISE EXCEPTION 'invalid_groups'; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(p_groups) LOOP
   IF g->>'category' NOT IN ('bug','ux','feature_request') OR length(trim(coalesce(g->>'title','')))=0 THEN RAISE EXCEPTION 'invalid_group'; END IF;
   SELECT array_agg(DISTINCT value::uuid) INTO ids FROM jsonb_array_elements_text(g->'insight_ids');
   IF coalesce(cardinality(ids),0)=0 THEN RAISE EXCEPTION 'empty_group'; END IF;
   -- Locks prevent a concurrent extension changing category/evidence during linking.
   PERFORM id FROM insights WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
   IF (SELECT count(*) FROM insights WHERE id=ANY(ids) AND bot_id=p_bot_id AND group_id IS NULL AND category IN ('bug','ux','feature_request')
       AND (category='feature_request')=((g->>'category')='feature_request')) <> cardinality(ids) THEN RAISE EXCEPTION 'invalid_or_stale_members'; END IF;
   gid:=NULL; target_category:=NULL;
   IF coalesce(g->>'existing_group_id','')<>'' THEN
     SELECT id,title,category INTO gid,title_text,target_category FROM insight_groups WHERE id=(g->>'existing_group_id')::uuid AND bot_id=p_bot_id FOR UPDATE;
     IF gid IS NULL OR (target_category='feature_request')<>((g->>'category')='feature_request') THEN RAISE EXCEPTION 'invalid_existing_group'; END IF;
     UPDATE insight_groups SET follow_up_pending=true WHERE id=gid AND status<>'open';
   ELSE
     INSERT INTO insight_groups(bot_id,title,summary,category) VALUES(p_bot_id,g->>'title',g->>'summary',g->>'category') RETURNING id,title INTO gid,title_text;
   END IF;
   UPDATE insights SET group_id=gid WHERE id=ANY(ids) AND bot_id=p_bot_id AND group_id IS NULL;
   GET DIAGNOSTICS linked=ROW_COUNT;
   IF linked<>cardinality(ids) THEN RAISE EXCEPTION 'partial_group_write'; END IF;
   total:=total+linked;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('id',gid,'title',title_text,'count',linked));
 END LOOP;
 UPDATE grouping_revisions SET revision=revision+1 WHERE bot_id=p_bot_id;
 RETURN jsonb_build_object('grouped',total,'groups',receipts);
END $$;

REVOKE ALL ON FUNCTION pipeline_source_membership(),pipeline_settle_insight(uuid,uuid,jsonb,uuid,uuid),pipeline_claim_message(uuid[]),pipeline_fail_message(uuid,uuid,uuid,text),pipeline_group_snapshot(uuid,integer),pipeline_commit_groups(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION pipeline_settle_insight(uuid,uuid,jsonb,uuid,uuid),pipeline_claim_message(uuid[]),pipeline_fail_message(uuid,uuid,uuid,text),pipeline_group_snapshot(uuid,integer),pipeline_commit_groups(uuid,bigint,jsonb) TO service_role;

-- Long-running local/hosted PostgREST needs the new RPC signatures immediately.
NOTIFY pgrst, 'reload schema';

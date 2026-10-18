-- Apply before deploying the code. Existing rows remain unscored/unattributed.
ALTER TABLE insights ADD COLUMN IF NOT EXISTS classified_by text;
ALTER TABLE insights ADD COLUMN IF NOT EXISTS classify_confidence real;
ALTER TABLE insight_groups ADD COLUMN IF NOT EXISTS impact_core boolean;
ALTER TABLE insight_groups ADD COLUMN IF NOT EXISTS impact_reason text;
ALTER TABLE insight_groups ADD COLUMN IF NOT EXISTS impact_scored_at timestamptz;

-- Preserve atomic source membership, lease checks, and extension behavior.
CREATE OR REPLACE FUNCTION pipeline_settle_insight(p_bot_id uuid,p_message_id uuid,p_insight jsonb,p_extend_id uuid DEFAULT NULL,p_lease uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE m messages; iid uuid; existing_id uuid; target insights; original_conversation uuid;
BEGIN
 SELECT * INTO m FROM messages WHERE id=p_message_id AND bot_id=p_bot_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'message_not_saved'; END IF;
 IF p_lease IS NOT NULL AND (m.classification_lease IS DISTINCT FROM p_lease OR m.classification_state <> 'processing') THEN RAISE EXCEPTION 'stale_classification_lease'; END IF;
 SELECT insight_id INTO existing_id FROM insight_message_sources WHERE message_id=p_message_id;
 IF existing_id IS NOT NULL THEN
   UPDATE messages SET classification_state='done',classification_lease=NULL,classification_error=NULL WHERE id=p_message_id;
   RETURN jsonb_build_object('id',existing_id,'created',false);
 END IF;
 -- Null classification with a known extension is provenance, not permission to rewrite metadata.
 IF p_extend_id IS NOT NULL AND (p_insight IS NULL OR p_insight = 'null'::jsonb) THEN
   -- Same target lock as create_pipeline_run; grouped evidence is also protected by the row lock.
   PERFORM pg_advisory_xact_lock(hashtextextended(p_bot_id::text||':'||p_extend_id::text,0));
   SELECT * INTO target FROM insights WHERE id=p_extend_id AND bot_id=p_bot_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'source_extension_unavailable'; END IF;
   SELECT conversation_id INTO original_conversation FROM messages WHERE id=target.message_id AND bot_id=p_bot_id;
   IF m.conversation_id IS NULL OR original_conversation IS DISTINCT FROM m.conversation_id
     OR target.group_id IS NOT NULL OR coalesce(cardinality(target.source_message_ids),0)>=50
     OR EXISTS(SELECT 1 FROM auto_dev_runs WHERE insight_id=p_extend_id)
   THEN RAISE EXCEPTION 'source_extension_unavailable'; END IF;
   UPDATE insights SET source_message_ids=array_append(coalesce(source_message_ids,ARRAY[]::uuid[]),p_message_id)
     WHERE id=p_extend_id RETURNING id INTO iid;
 ELSIF p_insight IS NOT NULL AND p_insight <> 'null'::jsonb THEN
   IF p_extend_id IS NOT NULL THEN
     -- Existing implementation protects published/grouped evidence. A blocked extension becomes a new report for grouping.
     SELECT extend_insight(p_bot_id,p_extend_id,p_message_id,p_insight->>'category',p_insight->>'summary',p_insight->>'sentiment',coalesce((p_insight->>'follow_up_needed')::boolean,false)) INTO iid;
   END IF;
   IF iid IS NULL THEN
     INSERT INTO insights(bot_id,message_id,category,summary,sentiment,follow_up_needed,classified_by,classify_confidence)
     VALUES(p_bot_id,p_message_id,p_insight->>'category',p_insight->>'summary',p_insight->>'sentiment',coalesce((p_insight->>'follow_up_needed')::boolean,false),p_insight->>'classified_by',(p_insight->>'classify_confidence')::real) RETURNING id INTO iid;
   END IF;
 END IF;
 UPDATE messages SET classification_state='done',classification_lease=NULL,classification_error=NULL WHERE id=p_message_id;
 RETURN jsonb_build_object('id',iid,'created',iid IS NOT NULL AND p_extend_id IS DISTINCT FROM iid);
END $$;

REVOKE EXECUTE ON FUNCTION pipeline_settle_insight(uuid,uuid,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pipeline_settle_insight(uuid,uuid,jsonb,uuid,uuid) TO service_role;

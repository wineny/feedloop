-- Advisory opinions only: never updates execution validation or publication state.
CREATE OR REPLACE FUNCTION public.save_run_verdict(p_run_id uuid,p_index integer,p_expected_item jsonb,p_verdict jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE current_explanation jsonb; current_item jsonb;
BEGIN
 SELECT explanation INTO current_explanation FROM auto_dev_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR p_index<0 THEN RETURN NULL; END IF;
 current_item:=current_explanation->'unverified'->p_index;
 IF current_item IS NULL OR (current_item-'verdict') IS DISTINCT FROM (p_expected_item-'verdict')
 OR current_item->>'verdict' IS NOT NULL THEN RETURN NULL; END IF;
 current_explanation:=jsonb_set(current_explanation,ARRAY['unverified',p_index::text,'verdict'],p_verdict,true);
 UPDATE auto_dev_runs SET explanation=current_explanation WHERE id=p_run_id;
 RETURN current_explanation;
END $$;
REVOKE ALL ON FUNCTION public.save_run_verdict(uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_run_verdict(uuid,integer,jsonb,jsonb) TO service_role;

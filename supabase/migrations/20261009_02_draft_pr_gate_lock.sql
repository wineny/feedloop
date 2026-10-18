-- Cross-process PR gate lease. Apply through the normal migration process; no run columns change.
BEGIN;
CREATE TABLE IF NOT EXISTS public.draft_pr_gate_locks (
  key text PRIMARY KEY,
  owner uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.draft_pr_gate_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.draft_pr_gate_locks FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_draft_pr_gate(p_key text, p_owner uuid, p_ttl_seconds integer DEFAULT 300)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_key IS NULL OR p_key = '' OR p_owner IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds <= 30 THEN
    RETURN false;
  END IF;
  INSERT INTO public.draft_pr_gate_locks(key, owner, expires_at)
  VALUES (p_key, p_owner, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (key) DO UPDATE
    SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
    WHERE draft_pr_gate_locks.expires_at <= clock_timestamp();
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.owns_draft_pr_gate(p_key text, p_owner uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.draft_pr_gate_locks
    WHERE key = p_key AND owner = p_owner AND expires_at >= clock_timestamp() + interval '30 seconds'
  );
$$;

CREATE OR REPLACE FUNCTION public.release_draft_pr_gate(p_key text, p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.draft_pr_gate_locks WHERE key = p_key AND owner = p_owner;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.claim_draft_pr_gate(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owns_draft_pr_gate(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_draft_pr_gate(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_draft_pr_gate(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.owns_draft_pr_gate(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_draft_pr_gate(text, uuid) TO service_role;
COMMIT;

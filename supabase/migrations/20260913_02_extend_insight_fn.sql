-- I-05 보충 턴 갱신을 «DB 함수 하나»로 좁힌다.
--
-- 왜 애플리케이션 UPDATE 로는 부족한가 — 갱신 여부를 읽고(후보 조회) 쓰기까지 최대 10초가
-- 비어 있다(LLM 호출). 그 사이에 운영자가 [지금 묶기]·[PR 만들기] 를 누를 수 있고, 같은
-- 대화의 두 요청이 동시에 같은 인사이트를 갱신할 수도 있다. 조건을 UPDATE 문 «안»에 두면
-- 판정과 쓰기가 한 문장에서 원자적으로 일어나고, 못 쓰는 경우는 0행으로 돌아온다.
--
-- 각 조건이 있는 이유:
--   bot_id      = p_bot_id     다른 테넌트의 인사이트를 id 하나로 갱신할 수 없게. 애플리케이션이
--                              service_role 로 붙으므로 RLS 가 막아 주지 않는다.
--   group_id is null           이미 묶인 제보의 근거가 사람 몰래 바뀌면 안 된다. 그 묶음으로
--                              스펙 초안이 나갔거나 PR 이 떴을 수 있다.
--   not exists (auto_dev_runs) 이 인사이트로 PR 을 이미 만들었으면 마찬가지다. 리뷰어가 본
--                              근거와 DB 의 근거가 달라지는 것이 가장 나쁘다.
--   cardinality < 50           보충 턴 배열의 상한. 무인증 위젯이라 한 대화에 수천 턴을 쏟아부어
--                              한 행을 무한정 키우는 경로를 막는다. 넘치면 새 행으로 떨어진다.
--   p_message_id = any(...)    같은 메시지를 두 번 더하지 않는다(재시도·지연 경로 대비).
--
-- 0행이면 NULL 을 돌려준다. 호출부(applyInsightWrite)는 그때 새 인사이트로 떨어져
-- **제보를 잃지 않는다** — 이 함수는 「합칠 수 있으면 합쳐라」이지 「합쳐야 한다」가 아니다.

CREATE OR REPLACE FUNCTION public.extend_insight(
  p_bot_id     uuid,
  p_id         uuid,
  p_message_id uuid,
  p_category   text,
  p_summary    text,
  p_sentiment  text,
  p_follow_up  boolean
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE insights
  SET
    category = p_category,
    summary = p_summary,
    sentiment = p_sentiment,
    follow_up_needed = p_follow_up,
    updated_at = now(),
    source_message_ids = CASE
      WHEN p_message_id IS NULL THEN source_message_ids
      WHEN p_message_id = ANY(source_message_ids) THEN source_message_ids
      ELSE array_append(source_message_ids, p_message_id)
    END
  WHERE id = p_id
    AND bot_id = p_bot_id
    AND group_id IS NULL
    AND cardinality(source_message_ids) < 50
    AND NOT EXISTS (
      SELECT 1 FROM auto_dev_runs r WHERE r.insight_id = p_id
    )
  RETURNING id;
$$;

-- ⚠️ Supabase 는 새 함수에 anon·authenticated EXECUTE 를 «기본으로» 부여한다.
-- `REVOKE ... FROM PUBLIC` 만으로는 그 둘이 안 좁혀진다 — 셋을 모두 회수해야
-- service_role 만 남는다(bump_bot_usage 때 실측한 것과 같은 함정).
REVOKE ALL ON FUNCTION public.extend_insight(uuid, uuid, uuid, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_insight(uuid, uuid, uuid, text, text, text, boolean)
  TO service_role;

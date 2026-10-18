-- 카카오 호출을 «따로» 센다.
--
-- 왜 나누나: 카카오는 계측만 하고 차단하지 않는다(4초 예산 + 오픈빌더 1:1 채널이라
-- 익명 스크립트가 때릴 수 있는 위젯 POST 와 노출 성격이 다르다).
-- 그런데 같은 카운터(ai_call_attempts)에 얹으면 «차단당하지 않는 트래픽이
-- 차단당하는 트래픽의 상한을 잠식»한다 — 카카오 대화가 활발한 날에는 위젯이
-- 아무 잘못 없이 조용히 막힌다. 세는 칸을 나눠 그 결합을 끊는다.
--
-- ai_call_attempts 와 마찬가지로 이름이 "시도"인 이유: 선증가라 실패해도 1 이 올라간다.
-- "성공한 카카오 응답 수"가 아니다 — 화면에 그렇게 쓰지 말 것.
ALTER TABLE bot_usage ADD COLUMN IF NOT EXISTS kakao_call_attempts INTEGER NOT NULL DEFAULT 0;

-- bump_bot_usage 와 같은 upsert 패턴. 날짜 경계도 같은 KST 다.
-- SECURITY DEFINER 를 붙이지 않는다 — service_role 로만 호출하므로 불필요하고 공격면만 는다.
CREATE OR REPLACE FUNCTION bump_kakao_usage(p_bot_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  INSERT INTO bot_usage (bot_id, usage_date, kakao_call_attempts)
  VALUES (p_bot_id, (now() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (bot_id, usage_date)
  DO UPDATE SET kakao_call_attempts = bot_usage.kakao_call_attempts + 1, updated_at = now()
  RETURNING kakao_call_attempts;
$$;

-- bump_bot_usage 와 같은 이유로 실행 권한을 좁힌다. 지금은 SECURITY INVOKER 라
-- bot_usage 의 RLS 가 막지만, 나중에 누군가 DEFINER 를 붙이는 순간 PUBLIC EXECUTE 가
-- 남아 있으면 그날로 구멍이 된다.
REVOKE EXECUTE ON FUNCTION bump_kakao_usage(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bump_kakao_usage(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION bump_kakao_usage(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION bump_kakao_usage(UUID) TO service_role;

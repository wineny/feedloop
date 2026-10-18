-- ── 답변 지식 (롱컨텍스트 스터핑용). 검색 인덱스 없음 — 통째로 프롬프트에 들어간다.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS knowledge_text TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS knowledge_faq JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS knowledge_updated_at TIMESTAMPTZ;

-- ── BYOK. llm_provider / llm_api_key_encrypted 는 init_schema.sql:55-56 에 이미 있다(사용처 0) — 재사용.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_key_last4 TEXT;            -- 화면 표시용. 원문은 절대 안 나간다
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_key_verified_at TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_key_failed_at TIMESTAMPTZ; -- 마지막 호출 실패 시각
ALTER TABLE bots ADD COLUMN IF NOT EXISTS daily_reply_limit INTEGER;     -- NULL = 기본값(키없음 30 / gemini 300 / 그 외 100)
-- 운영자가 고른 모델. NULL = 그 provider 의 추천 기본값(src/lib/llm/models.ts).
-- CHECK 를 걸지 않는다 — provider 가 새 모델을 내놓을 때마다 마이그레이션을 하게 된다.
-- 유효성은 첫 호출이 판정하고, 실패하면 llm_key_failed_at 경로로 운영자에게 보인다(§B-5).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS llm_model TEXT;

-- ── AI 가 못 답한 대화 표시 (§A-4). 운영자가 답장하면 NULL 로 되돌린다.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- ── 요청 출처 기록 (§B-7). 차단하지 않는다 — 사후 판별용.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin TEXT;

-- ── 일일 사용량. cooldown_state 를 건드리지 않기 위해 별도 테이블로 둔다.
--    (cooldown_state 는 텔레그램 전용이고 last_response_at 30초 간격 로직과 결합돼 있다.
--     위젯 트래픽을 거기 섞으면 텔레그램 봇이 조용히 막힌다 — 기존 동작 변경 = P4 위반)
CREATE TABLE IF NOT EXISTS bot_usage (
  bot_id            UUID    NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  usage_date        DATE    NOT NULL,
  -- 이름이 "시도"인 이유: 선증가 후판정이라 LLM 호출이 실패해도 1 이 올라간다.
  -- 이 값은 "성공한 AI 응답 수"가 아니다 — 화면에 "AI 응답 N건" 으로 표시하지 말 것.
  -- 응답 건수를 보여주려면 responses 를 세야 한다.
  ai_call_attempts  INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, usage_date)
);
-- 인덱스 추가 없음: PK (bot_id, usage_date) 가 유일한 조회 경로다.
-- 정책 없는 RLS = anon 전면 차단. 20260906_04_rls_rest.sql 관례를 따른다.
ALTER TABLE bot_usage ENABLE ROW LEVEL SECURITY;

-- 원자 증가. Supabase JS 의 upsert() 로는 "현재값 + 1" 을 표현할 수 없어 함수로 둔다.
-- SECURITY DEFINER 를 붙이지 않는다 — service_role 로만 호출하므로 불필요하고 공격면만 는다.
-- 날짜 경계는 KST. (cooldown_state 는 UTC 자정 = KST 09:00 에 리셋된다. 그 문제를 여기서 안 물려받는다)
CREATE OR REPLACE FUNCTION bump_bot_usage(p_bot_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  INSERT INTO bot_usage (bot_id, usage_date, ai_call_attempts)
  VALUES (p_bot_id, (now() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (bot_id, usage_date)
  DO UPDATE SET ai_call_attempts = bot_usage.ai_call_attempts + 1, updated_at = now()
  RETURNING ai_call_attempts;
$$;

-- 선제 조치. 지금은 SECURITY INVOKER 라 anon 이 불러도 bot_usage 의 RLS 가 막는다 —
-- 즉 현재 뚫려 있다는 뜻이 아니다. 다만 나중에 누군가 성능이나 편의를 이유로
-- SECURITY DEFINER 를 붙이는 순간, PUBLIC EXECUTE 가 남아 있으면 그날로 구멍이 된다
-- (익명이 임의 botId 로 남의 카운터를 올려 상한을 소진시킬 수 있다).
-- 실행 권한을 service_role 로 좁혀 그 사고 경로를 미리 닫는다.
-- ⚠️ FROM PUBLIC 만으로는 부족하다(2026-09-10 실측). Supabase 는 public 스키마 신규 함수에
--    anon·authenticated 에게 EXECUTE 를 «명시적으로» 준다(ALTER DEFAULT PRIVILEGES).
--    PUBLIC 만 회수하면 proacl 에 anon=X/authenticated=X 가 그대로 남는다 — 셋 다 회수해야 한다.
REVOKE EXECUTE ON FUNCTION bump_bot_usage(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bump_bot_usage(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION bump_bot_usage(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION bump_bot_usage(UUID) TO service_role;

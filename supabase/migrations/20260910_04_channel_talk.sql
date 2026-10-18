-- 채널톡(Channel.io) 웹훅 연동 (2026-09-10). 추가만.

-- 대화: 채널톡 유저챗 1개 = 대화 1개. external_user_id = chatId.
-- channel_person_id 는 장식이 아니다 — 되돌림 person 당 1건과 묶음 「몇 명」 통계가 읽는다.
-- personId 를 못 얻으면 'chat:'||chatId 폴백을 넣어 NULL 을 남기지 않는다(애플리케이션 책임).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_person_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_chat_type TEXT;      -- userChat | group
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_contact_source TEXT; -- user | veil (veil = 익명, 검증되지 않음)

-- 메시지 멱등: 채널톡이 같은 이벤트를 다시 보내도 인사이트가 두 번 생기지 않게.
-- NULL 은 서로 충돌하지 않으므로 partial 이 아니라 전체 UNIQUE 로 둔다
-- (PostgREST 의 on_conflict 는 partial index 를 추론하지 못한다).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_external
  ON messages(bot_id, source, external_message_id);

-- 웹훅 속도 제한이 200 응답 전에 (bot_id, source, detected_at) 을 센다.
-- 이 인덱스가 없으면 봇당 전량 스캔이라 응답이 느려진다(위젯은 external_user_id 로 좁혀 덜 아프다).
CREATE INDEX IF NOT EXISTS idx_msg_bot_detected ON messages(bot_id, detected_at DESC);

-- 되돌림 전송 결과. delivered_at 은 기존 컬럼을 그대로 쓴다.
ALTER TABLE responses ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE responses ADD COLUMN IF NOT EXISTS delivery_error TEXT;

-- 봇: 채널톡 자격증명·연결 상태·마지막 오류(after() 실패 계측).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_access_key_encrypted TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_access_secret_encrypted TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_webhook_token_encrypted TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_id TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_slug TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_webhook_id TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_bot_name TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_connected_at TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_last_error TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_last_error_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conv_channel_person
  ON conversations(bot_id, channel_person_id) WHERE channel_person_id IS NOT NULL;

-- ── 채널톡 분류 호출을 «따로» 센다 (18c2a65 의 bot_usage 재사용, R4 해소).
--
-- 왜 자기 칸이 필요한가: 채널톡은 무인증 웹훅이고 CS 비중이 높아 하루 수백 건이 들어올 수 있다.
-- 그걸 ai_call_attempts(위젯 즉답 상한)에 얹으면 채널톡이 활발한 날 위젯이 아무 잘못 없이
-- 조용히 막힌다 — 20260910_03 이 카카오에 대해 적어 둔 것과 같은 이유다. 세는 칸을 나눈다.
-- 이름이 "시도"인 것도 같은 이유: 선증가라 LLM 이 실패해도 1 이 올라간다.
ALTER TABLE bot_usage ADD COLUMN IF NOT EXISTS channel_call_attempts INTEGER NOT NULL DEFAULT 0;

-- bump_bot_usage · bump_kakao_usage 와 같은 upsert 패턴. 날짜 경계도 같은 KST 다.
CREATE OR REPLACE FUNCTION bump_channel_usage(p_bot_id UUID)
RETURNS INTEGER
LANGUAGE sql
AS $$
  INSERT INTO bot_usage (bot_id, usage_date, channel_call_attempts)
  VALUES (p_bot_id, (now() AT TIME ZONE 'Asia/Seoul')::date, 1)
  ON CONFLICT (bot_id, usage_date)
  DO UPDATE SET channel_call_attempts = bot_usage.channel_call_attempts + 1, updated_at = now()
  RETURNING channel_call_attempts;
$$;

REVOKE EXECUTE ON FUNCTION bump_channel_usage(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bump_channel_usage(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION bump_channel_usage(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION bump_channel_usage(UUID) TO service_role;

COMMENT ON COLUMN bots.channel_webhook_token_encrypted IS
  '웹훅 URL 마지막 세그먼트의 시크릿. 소유자 인증 GET 으로만 평문이 나가고 로그·목록 API 에는 싣지 않는다';
COMMENT ON COLUMN conversations.channel_contact_source IS
  'veil = 채널톡 익명 유저. 이름·이메일이 검증되지 않은 값임을 표시';
COMMENT ON COLUMN messages.external_message_id IS
  '채널 원본 메시지 id. 웹훅 재전송 멱등 근거. 위젯·카카오는 NULL';

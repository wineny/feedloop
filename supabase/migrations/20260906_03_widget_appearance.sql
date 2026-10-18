-- 웹 위젯 모양 + 되돌림 확인 — 설계 §4 의 잔여분
--
-- 20260906_02_web_widget.sql 이 §4 의 대화·묶음·대기열 부분을 적용했고,
-- "봇 설정 › 위젯 모양"(목업 8번)과 "되돌림 확인 2버튼" 컬럼이 빠져 있었다.
-- 위젯이 부팅 시 `GET /api/widget/[botId]/config` 로 읽는 값들이다.
-- 전부 NULL 허용이라 기존 봇은 service_name 등으로 폴백한다.

ALTER TABLE bots ADD COLUMN profile_image_url TEXT;      -- Supabase Storage public URL (bot-profiles/<botId>.<ext>)
ALTER TABLE bots ADD COLUMN display_name TEXT;           -- NULL 이면 service_name
ALTER TABLE bots ADD COLUMN status_text TEXT DEFAULT '보통 몇 분 안에 답해요';
ALTER TABLE bots ADD COLUMN greeting TEXT;               -- 첫 인사말. NULL 이면 위젯 기본 문구
ALTER TABLE bots ADD COLUMN operator_display_name TEXT;  -- 운영자 답장 이름 (예: "널널투어 팀 · 누리")

-- 되돌림(loop_closed) 카드에서 유저가 누른 버튼. 단계 4 의 /confirm 이 채운다.
ALTER TABLE responses ADD COLUMN user_confirmation TEXT; -- fixed | not_fixed | NULL
ALTER TABLE responses ADD COLUMN user_confirmed_at TIMESTAMPTZ;

-- 카카오톡 채널(오픈빌더 스킬 서버) 지원
-- 카카오 botUserKey는 문자열이라 BIGINT 컬럼(author_id/chat_id)에 못 담는다 → TEXT 컬럼 추가

ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram';
ALTER TABLE messages ADD COLUMN external_user_id TEXT;

ALTER TABLE bots ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram';

CREATE INDEX idx_msg_external_user ON messages(bot_id, external_user_id);

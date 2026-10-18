-- 응답(운영자 답장 · 되돌림)이 이메일로도 나갔는지 기록한다.
--
-- 위젯이 「…로 답장을 보내드려요」라고 약속하는데 발송 코드가 0 이었다(셀프 QA I-04, 2026-09-12).
-- 방문자가 연락처 폼에 이메일을 남겼으면 운영자 답장·되돌림 때 메일 1통을 보낸다.
-- 세 컬럼 전부 NULL 허용 — 이메일을 안 남긴 대화의 응답은 아무것도 안 찍힌다.

ALTER TABLE responses ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;      -- 발송 성공 시각
ALTER TABLE responses ADD COLUMN IF NOT EXISTS email_message_id TEXT;          -- Postmark MessageID
ALTER TABLE responses ADD COLUMN IF NOT EXISTS email_error TEXT;               -- 마지막 실패 사유(성공하면 NULL)

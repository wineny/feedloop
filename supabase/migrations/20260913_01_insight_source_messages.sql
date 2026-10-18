-- I-05 즉답 맥락 — 보충 턴이 기존 인사이트를 갱신할 때 어느 메시지가 보태졌는지 남긴다.
--
-- `message_id` 는 첫 제보 메시지 그대로(UNIQUE 유지). 보충 턴은 `source_message_ids` 에 쌓인다.
-- 배치 분류(`api/classify`)는 이 배열까지 보고 "이미 분류됨"을 판정한다 — 안 그러면
-- [분류] 버튼이 보충 턴을 새 인사이트로 만들어 조각 문제가 뒷문으로 재발한다.
-- PR 엔진은 이 메시지들의 본문을 「(보충)」 으로 덧붙여 읽는다.
--
-- 추가만 한다. 기존 행은 빈 배열·NULL 로 남고 동작이 바뀌지 않는다.
ALTER TABLE insights ADD COLUMN IF NOT EXISTS source_message_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE insights ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_ins_source_messages ON insights USING GIN (source_message_ids);

-- 2026-10-21 i18n 1.5/8 — stop storing Korean sentences as values.
--
-- Display text is chosen by the screen (per locale), so the database keeps only codes or NULL:
--   messages.author_name         '고객' / '방문자' / '카카오 사용자' / '채널톡 이용자' -> NULL
--                                (the screen shows the per-source fallback: personLabel(source))
--   bots.status_text             DEFAULT '보통 몇 분 안에 답해요' -> DEFAULT NULL; stored default text -> NULL
--                                (readers already fall back to DEFAULT_STATUS_TEXT)
--   bots.llm_key_failed_reason   Korean sentence -> LlmFailureKind code
--                                (key_rejected | model_invalid | quota | connection)
--
-- messages.author_name was NOT NULL (init_schema.sql); the app now writes NULL when no name is known.
--
-- ROLLBACK (lossy for the three NULL-ed columns — the original text is the fixed fallback, so re-filling it is safe):
--   UPDATE messages SET author_name = CASE source WHEN 'kakao' THEN '카카오 사용자' WHEN 'channel' THEN '채널톡 이용자' ELSE '방문자' END
--     WHERE author_name IS NULL;
--   ALTER TABLE messages ALTER COLUMN author_name SET NOT NULL;
--   ALTER TABLE bots ALTER COLUMN status_text SET DEFAULT '보통 몇 분 안에 답해요';
--   UPDATE bots SET status_text = '보통 몇 분 안에 답해요' WHERE status_text IS NULL;   -- optional; NULL already falls back in code
--   UPDATE bots SET llm_key_failed_reason = CASE llm_key_failed_reason
--       WHEN 'key_rejected' THEN '키가 거부됐어요' WHEN 'model_invalid' THEN '모델 이름을 확인해 주세요'
--       WHEN 'quota' THEN 'provider 한도에 걸렸어요' WHEN 'connection' THEN '연결에 실패했어요'
--       ELSE llm_key_failed_reason END;
--   (Rows written after this migration with a bare NULL author_name cannot be told apart from rows that
--    were cleaned here; the CASE above restores the same fallback for both. Code that reads the failure
--    reason accepts both the code and the old sentence, so the rollback needs no deploy ordering.)

ALTER TABLE messages ALTER COLUMN author_name DROP NOT NULL;

UPDATE messages
   SET author_name = NULL
 WHERE author_name IN ('고객', '방문자', '카카오 사용자', '채널톡 이용자');

ALTER TABLE bots ALTER COLUMN status_text SET DEFAULT NULL;

UPDATE bots
   SET status_text = NULL
 WHERE status_text = '보통 몇 분 안에 답해요';

UPDATE bots
   SET llm_key_failed_reason = CASE
     WHEN llm_key_failed_reason = '키가 거부됐어요' THEN 'key_rejected'
     WHEN llm_key_failed_reason LIKE '모델 이름을 확인해 주세요%' THEN 'model_invalid'
     WHEN llm_key_failed_reason = 'provider 한도에 걸렸어요' THEN 'quota'
     WHEN llm_key_failed_reason = '연결에 실패했어요' THEN 'connection'
   END
 WHERE llm_key_failed_reason IN ('키가 거부됐어요', 'provider 한도에 걸렸어요', '연결에 실패했어요')
    OR llm_key_failed_reason LIKE '모델 이름을 확인해 주세요%';

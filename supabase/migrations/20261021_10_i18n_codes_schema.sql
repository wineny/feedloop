-- 2026-10-21 i18n 1.5/8 — part A (schema). Apply order:  A  ->  deploy the new code  ->  B (20261021_11_i18n_codes_data.sql)
--
-- This file only loosens constraints; it does not touch any row, so the code that is
-- running now (7ba9636) keeps working: it never sees a NULL it did not already handle.
--   messages.author_name  DROP NOT NULL   (the new code writes NULL when no name is known)
--   bots.status_text      DEFAULT NULL    (the new code shows DEFAULT_STATUS_TEXT per locale)
--
-- Why this order:
--   * Running B before the deploy: 7ba9636 RecentFeedback.tsx:88 calls f.userName.slice on a value that is
--     now NULL and crashes, and the llm-key screen prints the raw code ('key_rejected') as the reason.
--   * Deploying the new code before A: it writes author_name = NULL, which NOT NULL rejects, so
--     message saving fails.
--
-- ROLLBACK of A (run only after the old code is serving again, and after rolling back B):
--   UPDATE messages SET author_name = CASE source WHEN 'kakao' THEN '카카오 사용자' WHEN 'channel' THEN '고객' ELSE '방문자' END
--     WHERE author_name IS NULL;                      -- NOT NULL cannot be restored while NULLs exist
--   ALTER TABLE messages ALTER COLUMN author_name SET NOT NULL;
--   ALTER TABLE bots ALTER COLUMN status_text SET DEFAULT '보통 몇 분 안에 답해요';
--   (Not recoverable: rows that were anonymized to '채널톡 이용자' come back as '고객', because NULL
--    cannot tell them apart.)

ALTER TABLE messages ALTER COLUMN author_name DROP NOT NULL;

ALTER TABLE bots ALTER COLUMN status_text SET DEFAULT NULL;

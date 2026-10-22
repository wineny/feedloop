-- 2026-10-21 i18n 1.5/8 — part B (data). Apply order:  A (20261021_10_i18n_codes_schema.sql) + 20261021_12_conversation_locale.sql  ->  deploy the new code  ->  B
--
-- Run this ONLY after the new code is serving. Running it earlier breaks the code that is live:
--   * 7ba9636 RecentFeedback.tsx:88 calls f.userName.slice on author_name, which is NULL after step 1 -> crash.
--   * The llm-key and github-token screens of 7ba9636 print the stored code ('key_rejected', 'token_rejected') instead of a sentence.
-- Requires part A (author_name must already accept NULL).
--
-- Display text is chosen by the screen (per locale), so the database keeps only codes or NULL:
--   messages.author_name         '고객' / '방문자' / '카카오 사용자' / '채널톡 이용자' -> NULL
--                                (the screen shows the per-source fallback: personLabel(source))
--   bots.status_text             stored default text -> NULL (readers fall back to messages/<locale>/bots.json defaults.statusText)
--   bots.llm_key_failed_reason   Korean sentence -> LlmFailureKind code
--                                (key_rejected | model_invalid | quota | connection)
--   bots.github_token_failed_reason  Korean sentence -> GithubFailureKind code
--                                (token_rejected | no_push | connection | unreadable)
--
-- ROLLBACK of B (lossy; run it before rolling back A, and with the old code serving):
--   UPDATE messages SET author_name = CASE source WHEN 'kakao' THEN '카카오 사용자' WHEN 'channel' THEN '고객' ELSE '방문자' END
--     WHERE author_name IS NULL;
--   UPDATE bots SET status_text = '보통 몇 분 안에 답해요' WHERE status_text IS NULL;
--   UPDATE bots SET llm_key_failed_reason = CASE llm_key_failed_reason
--       WHEN 'key_rejected' THEN '키가 거부됐어요' WHEN 'model_invalid' THEN '모델 이름을 확인해 주세요'
--       WHEN 'quota' THEN 'provider 한도에 걸렸어요' WHEN 'connection' THEN '연결에 실패했어요'
--       ELSE llm_key_failed_reason END;
--   UPDATE bots SET github_token_failed_reason = CASE github_token_failed_reason
--       WHEN 'token_rejected' THEN '토큰이 거부됐거나 이 저장소에 접근할 수 없어요'
--       WHEN 'no_push' THEN '이 저장소에 쓸(push) 수 없어요. 토큰의 Contents·Pull requests 가 Read and write 인지 확인해 주세요 — 브랜치 보호나 조직 정책일 수도 있어요'
--       WHEN 'connection' THEN 'GitHub 에 연결하지 못했어요'
--       WHEN 'unreadable' THEN '저장된 토큰을 읽지 못했어요. 토큰을 다시 등록해 주세요'
--       ELSE github_token_failed_reason END;
--   Cannot be restored exactly:
--     * Channel Talk rows: both the regular '고객' rows and the anonymized '채널톡 이용자' rows are NULL now,
--       so the rollback writes '고객' for all of them.
--     * model_invalid: the old text ended with ': <model id>' for some rows; that suffix is not recoverable.
--     * status_text: owners who deliberately cleared it were NULL before this migration too; the rollback
--       above fills them with the default text (a visible change for them).

UPDATE messages
   SET author_name = NULL
 WHERE author_name IN ('고객', '방문자', '카카오 사용자', '채널톡 이용자');

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

UPDATE bots
   SET github_token_failed_reason = CASE github_token_failed_reason
     WHEN '토큰이 거부됐거나 이 저장소에 접근할 수 없어요' THEN 'token_rejected'
     WHEN '이 저장소에 쓸(push) 수 없어요. 토큰의 Contents·Pull requests 가 Read and write 인지 확인해 주세요 — 브랜치 보호나 조직 정책일 수도 있어요' THEN 'no_push'
     WHEN 'GitHub 에 연결하지 못했어요' THEN 'connection'
     WHEN '저장된 토큰을 읽지 못했어요. 토큰을 다시 등록해 주세요' THEN 'unreadable'
   END
 WHERE github_token_failed_reason IN (
   '토큰이 거부됐거나 이 저장소에 접근할 수 없어요',
   '이 저장소에 쓸(push) 수 없어요. 토큰의 Contents·Pull requests 가 Read and write 인지 확인해 주세요 — 브랜치 보호나 조직 정책일 수도 있어요',
   'GitHub 에 연결하지 못했어요',
   '저장된 토큰을 읽지 못했어요. 토큰을 다시 등록해 주세요'
 );

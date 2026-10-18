-- `20260911_03` 의 부분 UNIQUE 인덱스를 일반 UNIQUE 인덱스로 바꾼다.
--
-- 왜 — 부분 인덱스(`WHERE message_id IS NOT NULL`)는 **PostgREST 의 upsert 와 맞물리지
-- 않는다.** `.upsert(rows, { onConflict: 'message_id' })` 는 술어 없이
-- `ON CONFLICT (message_id)` 를 보내는데, Postgres 는 술어가 없는 conflict target 을
-- 부분 인덱스에 매칭해 주지 않는다(42P10). 그래서 `POST /api/classify` 의 insert 가
-- **매번 통째로 실패**했다:
--
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- 화면에는 `{"classified":0, "failedBots":1}` 로만 보였다. 인덱스를 만든 날부터
-- 운영자 [분류] 버튼은 한 번도 성공한 적이 없다(2026-09-11 프로덕션 DB 로 실측).
--
-- 왜 술어를 그냥 빼도 되나 — **Postgres 의 UNIQUE 는 NULL 끼리를 충돌로 보지 않는다.**
-- `message_id IS NULL` 인 행은 일반 UNIQUE 인덱스에서도 여러 개 들어간다(트랜잭션으로
-- 확인함). 술어는 의도를 적어두려던 것이었고 제약을 더하지 않았다 — 대신 upsert 를 막았다.
--
-- 되돌리려면 이 인덱스를 지우고 `20260911_03` 의 부분 인덱스를 다시 만들면 된다.
-- 단, 그러면 분류 버튼이 다시 멎는다.

DROP INDEX IF EXISTS insights_message_id_unique;

CREATE UNIQUE INDEX IF NOT EXISTS insights_message_id_unique
  ON insights (message_id);

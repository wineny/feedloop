-- I-55 보안 리뷰 M1·L1 (2026-09-25) — 업로드 상한을 «먼저 세고 나중에 쓰는» 구조에서 «잠그고 세고 예약»으로.
--
-- 예전: 행을 센 뒤 1MB 수신 → Storage 업로드 → INSERT. 그 사이 수백 ms~수 초 동안 동시 요청 50개가 모두
-- count=0 을 보고 통과했다(서버리스 인스턴스가 늘면 인메모리 IP 상한도 못 막는다) → 「봇 하루 300장」이 상한이 아니었다.
-- 이제: 봇 단위 advisory 잠금 안에서 세고, 통과하면 그 자리에서 행을 INSERT(예약)한다. 예약 행이 곧바로
-- 계수에 잡혀 동시 요청 창이 사라진다. 업로드는 예약 «뒤»이고, 실패하면 앱이 행을 지운다.
-- 함수가 업로드 도중 죽어도 행이 남으니 정리 단계가 찾는다(행 없는 객체가 생기지 않는다 — L1 ①).
-- 반환: NULL = 예약됨, 'visitor' / 'bot' = 상한. service_role 만 실행한다.

CREATE OR REPLACE FUNCTION reserve_widget_shot(
  p_id uuid, p_bot uuid, p_visitor text, p_path text, p_mime text, p_bytes integer, p_width integer, p_height integer,
  p_visitor_limit integer, p_bot_limit integer
) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('widget_shots:' || p_bot::text));
  IF (SELECT count(*) FROM widget_shots
        WHERE bot_id = p_bot AND visitor_id = p_visitor AND created_at > now() - interval '1 minute') >= p_visitor_limit THEN
    RETURN 'visitor';
  END IF;
  IF (SELECT count(*) FROM widget_shots
        WHERE bot_id = p_bot AND created_at > now() - interval '24 hours') >= p_bot_limit THEN
    RETURN 'bot';
  END IF;
  INSERT INTO widget_shots (id, bot_id, visitor_id, storage_path, mime, bytes, width, height)
  VALUES (p_id, p_bot, p_visitor, p_path, p_mime, p_bytes, p_width, p_height);
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION reserve_widget_shot(uuid, uuid, text, text, text, integer, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_widget_shot(uuid, uuid, text, text, text, integer, integer, integer, integer, integer)
  TO service_role;

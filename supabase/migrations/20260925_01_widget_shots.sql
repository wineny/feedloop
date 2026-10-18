-- I-55 「화면에서 선택하기」 스크린샷 (2026-09-25). 기획: docs/07-위젯/화면에서-선택-스크린샷-기획-2026-09-25.md
--
-- 방문자가 요소를 짚는 순간 위젯이 뷰포트를 촬영해 비공개 버킷에 올린다. 이 표는 그 한 장의 기록이다.
-- - 업로드 시점엔 message_id 가 NULL 이다. 메시지를 보낼 때 «같은 봇·같은 방문자·아직 안 붙은» 행만 붙인다
--   (남의 shotId 를 붙여 남의 화면을 자기 제보로 끌어오는 경로 차단).
-- - bot 이 지워지면 행은 CASCADE 로 사라지지만 **Storage 객체는 안 지워진다** — 봇 삭제 라우트가 먼저 폴더를 비운다.
-- - message 가 지워지면 SET NULL — 고아가 되고 하루 1회 정리 단계가 치운다.
-- - RLS on, 정책 없음(anon 전면 차단). 서버는 service_role 로만 만진다.
-- 코드보다 먼저 적용한다(추가 전용).

CREATE TABLE IF NOT EXISTS widget_shots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  storage_path text NOT NULL UNIQUE,
  mime text NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg')),
  bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 1048576),
  width integer NOT NULL CHECK (width > 0 AND width <= 2560),
  height integer NOT NULL CHECK (height > 0 AND height <= 2560),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 봇 하루 상한·방문자 분당 상한 계수
CREATE INDEX IF NOT EXISTS idx_widget_shots_bot_created ON widget_shots (bot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_widget_shots_visitor_created ON widget_shots (bot_id, visitor_id, created_at);
-- 운영자 화면이 메시지로 찾는다
CREATE INDEX IF NOT EXISTS idx_widget_shots_message ON widget_shots (message_id) WHERE message_id IS NOT NULL;
-- 고아 정리
CREATE INDEX IF NOT EXISTS idx_widget_shots_orphan ON widget_shots (created_at) WHERE message_id IS NULL;

ALTER TABLE widget_shots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON widget_shots FROM anon, authenticated;

-- 비공개 버킷. 공개 URL 없음 — 운영자 라우트가 10분짜리 서명 URL 만 싣는다.
-- 크기·형식 상한은 라우트가 먼저 보지만 버킷에도 한 번 더 건다.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('widget-shots', 'widget-shots', false, 1048576, ARRAY['image/webp', 'image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

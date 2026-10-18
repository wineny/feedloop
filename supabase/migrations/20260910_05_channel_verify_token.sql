-- 채널톡 웹훅 토큰 대조 (2026-09-10 실계정 검증 후속). 추가만.
--
-- 실계정(E2)에서 확인한 것: 채널톡은 서명 헤더를 보내지 않고, 웹훅을 등록하면 대화상자에
-- 32hex 토큰을 한 번 보여주고 그 뒤 모든 요청에 `?token=<그 값>` 을 붙여 온다.
-- 운영자가 그 값을 연결 화면에 붙여넣으면 두 번째 인증이 된다 — URL 경로의 시크릿 세그먼트가
-- 요청 로그에 남아 새는 경우를 대비한 겹이다. 비어 있으면 대조하지 않는다(종전 동작).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS channel_webhook_verify_token_encrypted TEXT;

COMMENT ON COLUMN bots.channel_webhook_verify_token_encrypted IS
  '채널톡이 웹훅 등록 시 발급해 ?token= 으로 붙여 보내는 값. 운영자가 붙여넣으면 대조하고, NULL 이면 대조하지 않는다. 어떤 응답에도 되돌려 내보내지 않는다';

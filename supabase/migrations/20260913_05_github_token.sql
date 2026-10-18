-- B5 GitHub 연결 BYO — 봇별 GitHub 토큰 (2026-09-13).
--
-- 왜: PR 엔진·PR 검토 화면이 플랫폼 공용 GITHUB_TOKEN 하나로 GitHub 을 부른다.
-- 우리가 초대받지 않은 레포엔 push 권한이 없어, 운영자가 자기 레포를 등록하면 「PR 만들기」가 실패한다.
-- 봇에 토큰이 있으면 그걸 먼저 쓰고, 없으면 종전대로 공용 토큰으로 간다 — 기존 봇 동작 불변.
--
-- 구조는 LLM 키 BYOK(20260910_01·_02)와 같다: AES-256-GCM 암호문 + 마지막 4자 + 검증 시각 + 실패 시각/사유.
-- 원문은 어떤 응답에도 나가지 않는다. 화면은 last4 만 읽는다(암호문 컬럼은 select 에 넣지 않을 것).
-- failed_reason 에는 lib/github/token.ts 의 3분류 «고정 문자열»만 들어간다 — GitHub 에러 원문 금지.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_encrypted   TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_last4       TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_verified_at TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_failed_at   TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_failed_reason TEXT;

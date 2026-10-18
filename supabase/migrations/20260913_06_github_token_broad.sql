-- B5 후속(보안 재검토 R2) — 저장된 GitHub 토큰이 «계정 전체 레포»에 닿는 종류(classic PAT·OAuth)인지.
-- 저장 때 x-oauth-scopes 헤더 유무로 정한다(fine-grained 는 헤더가 없다). 스코프 문자열은 저장하지 않는다 —
-- 비밀은 아니지만 boolean 이상의 쓸모가 없다. 사고 때 「어느 봇이 계정 전체 자격을 들고 있나」에 답하는 컬럼.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_token_broad BOOLEAN NOT NULL DEFAULT false;

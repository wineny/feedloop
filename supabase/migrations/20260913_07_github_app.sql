-- GitHub App 설치형 연결 (2026-09-13, 안 B). 봇마다 «우리 앱이 설치된 installation» 을 기억한다.
--
-- 왜: 봇별 PAT(20260913_05)는 운영자가 GitHub 설정 화면에서 토큰을 손수 만들어 붙여 넣어야 한다.
-- 조사한 12개 서비스(Vercel·Netlify·Sentry·Devin·Cursor·Codegen·Gleap·Copilot …) 중 PAT 를 받는 곳은 0 이고
-- 레포에 쓰는 곳은 전부 GitHub App 설치다 — 「설치」 버튼 → GitHub 화면에서 레포 선택 → 끝.
-- 설치 토큰은 1시간마다 자동 발급되므로 여기엔 **비밀이 없다.** 설치 id 와 계정 이름뿐이다.
--
-- 판정은 installation_id 쿼리 파라미터가 아니라 «봇 레포로 GET /repos/{o}/{r}/installation» 으로 한다
-- (공식 문서: installation_id 는 스푸핑 가능). 잃어버림(lost_*)은 웹훅(installation.deleted/suspend,
-- installation_repositories.removed)이 적는다. 우선순위: 설치 → 봇 PAT → 공용 토큰. 기존 봇은 NULL 이라 무변화.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_id           BIGINT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_login        TEXT;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_connected_at TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_lost_at      TIMESTAMPTZ;
-- 고정 문자열만: uninstalled · suspended · repo_removed · missing (lib/github/app.ts InstallationLostReason)
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_lost_reason  TEXT;
-- 웹훅이 installation id 로 봇을 찾는다
CREATE INDEX IF NOT EXISTS idx_bots_github_installation
  ON bots (github_installation_id) WHERE github_installation_id IS NOT NULL;
-- 누구의 인가로 묶였나(설치 콜백에서 유저 토큰으로 확인한 GitHub 로그인). 비밀 아님, 감사용
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_by TEXT;
-- 설치가 「All repositories」인가(보안 재검토 M3). 우리가 쓰는 건 이 봇의 레포 하나지만,
-- 운영자가 계정 전체를 내준 상태라는 사실은 화면이 말해야 한다. 값은 'all' | 'selected' 만.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS github_installation_repo_selection TEXT;

-- Auto-Dev 기능 추가 마이그레이션

-- 1. bots 테이블에 github_repo_url 컬럼 추가
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS github_repo_url TEXT;

-- 2. auto_dev_runs 테이블 생성
CREATE TABLE auto_dev_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  insight_id UUID REFERENCES insights(id) ON DELETE SET NULL,

  -- 실행 상태
  status TEXT DEFAULT 'running',           -- running | completed | failed
  error_message TEXT,

  -- 결과
  pr_url TEXT,
  pr_number INTEGER,
  files_changed JSONB,                     -- [{path, action}]
  duration_ms INTEGER,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_adr_bot ON auto_dev_runs(bot_id);
CREATE INDEX idx_adr_status ON auto_dev_runs(status);

-- RLS: 봇 소유자만 접근
ALTER TABLE auto_dev_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY adr_owner ON auto_dev_runs FOR ALL
  USING (bot_id IN (SELECT id FROM bots WHERE user_id = auth.uid()));

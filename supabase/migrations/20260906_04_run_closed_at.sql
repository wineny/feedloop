-- 머지 없이 닫힌 PR 을 기록한다 (2026-09-06).
-- 머지 감지는 merged_at 만 봤기 때문에 GitHub 에서 닫아버린 PR(리허설 중복 PR #4)이 화면에 영원히 「열림」으로 남았다.
-- checkMergedRuns 가 GitHub state=closed && merged=false 를 보면 여기 시각을 찍고, 화면은 「닫힘」으로 그린다.
ALTER TABLE auto_dev_runs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

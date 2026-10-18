-- 머지 없이 닫힌 PR 의 사유를 기록한다 (2026-09-10).
--
-- closed_at 은 GitHub 상태(state=closed && !merged)를 보고 자동으로 찍히지만, 왜 닫혔는지는
-- GitHub 가 모른다. 경로를 지어냈는지(PR #1·#5), 실재 파일을 고쳤으나 인과가 틀렸는지(PR #6),
-- 중복이었는지(PR #4)는 사람만 안다. 사유는 「수정 PR」 화면에서 사람이 고른다.
-- 사유가 쌓이면 어떤 실패가 반복되는지 보이고, 그게 다음 방어의 근거가 된다.
--
-- 컬럼 추가만. 기존 행은 NULL(미분류)로 남는다.

ALTER TABLE auto_dev_runs
  ADD COLUMN IF NOT EXISTS close_reason TEXT
    CHECK (close_reason IN ('hallucinated_path', 'wrong_causality', 'duplicate', 'superseded', 'other'));

ALTER TABLE auto_dev_runs
  ADD COLUMN IF NOT EXISTS close_note TEXT;

COMMENT ON COLUMN auto_dev_runs.close_reason IS
  '머지 없이 닫힌 이유. 사람이 화면에서 고른다. NULL = 미분류';
COMMENT ON COLUMN auto_dev_runs.close_note IS
  '사유에 붙이는 짧은 메모 (500자 이하, 애플리케이션이 검증)';

-- 기존 닫힌 run 2건 백필 — QA 로 사유가 확정된 것들이다.
-- PR #4 (2026-09-06 리허설): 카카오 후속 문의가 별도 묶음이 돼 실수로 만든 중복. useCallback·주석뿐인 무의미한 변경.
-- PR #6 (2026-09-09 QA): coupon-session.ts 가 이미 막고 있는 실패에 도달 불가능한 else 분기를 추가. 고칠 버그가 없었다.
UPDATE auto_dev_runs
SET close_reason = 'duplicate',
    close_note = '리허설 중 후속 문의 묶음에 실수로 생성. useCallback·주석뿐인 무의미한 변경'
WHERE pr_number = 4
  AND pr_url LIKE 'https://github.com/wineny/nullnul-tour-demo/%'
  AND closed_at IS NOT NULL AND merged_at IS NULL AND close_reason IS NULL;

UPDATE auto_dev_runs
SET close_reason = 'wrong_causality',
    close_note = 'coupon-session.ts:58·60 이 이미 막는 실패에 도달 불가능한 분기 추가. 고칠 버그가 존재하지 않았다'
WHERE pr_number = 6
  AND pr_url LIKE 'https://github.com/wineny/nullnul-tour-demo/%'
  AND closed_at IS NOT NULL AND merged_at IS NULL AND close_reason IS NULL;

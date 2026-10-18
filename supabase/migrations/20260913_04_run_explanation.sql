-- 수정안의 「담당자용 설명」 (2026-09-13, I-19).
--
-- 「수정 PR」 상세에서 비개발자 담당자가 반영 여부를 정하려면 diff 가 아니라
-- 「무엇이 문제였고 / 무엇을 바꿨고 / 반영되면 어떻게 되는지 / 확인하지 못한 것」이 필요하다.
-- 엔진이 2-pass 에서 수정안과 함께 쓰고, 형태는 src/lib/auto-dev/explanation.ts 가 정한다:
--   { problem, change, effect, unverified: [{ text, verifiableBy, files, question, verdict }], source }
-- [AI 에게 확인시키기] 결과(verdict)도 같은 JSON 안에 쓴다 — 항목이 곧 손잡이라 따로 둘 이유가 없다.
--
-- 컬럼 추가만. 기존 실행은 NULL 이고, 화면은 그때 PR 본문에서 최선의 설명을 뽑아 보여준다(source='pr_body').

ALTER TABLE auto_dev_runs
  ADD COLUMN IF NOT EXISTS explanation JSONB;

COMMENT ON COLUMN auto_dev_runs.explanation IS
  '담당자용 설명 {problem, change, effect, unverified[], source}. 엔진이 쓰고 verify 라우트가 verdict 를 채운다. NULL = 이 기능 전 실행';

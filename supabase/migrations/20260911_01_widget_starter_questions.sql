-- 위젯 첫 화면 「자주 묻는 질문」 칩 — 운영자가 정하는 시작 질문.
--
-- 지금까지 첫 화면 칩은 코드에 박힌 3개(불편·기능·문의)뿐이었다. 봇에 답변 지식이
-- 들어간 뒤로 위젯은 "피드백 수집함"이자 "물어보면 답하는 창구"가 됐는데,
-- 첫 화면이 그 변화를 못 담았다 — 방문자는 물어봐도 된다는 걸 알 길이 없다.
--
-- 운영자가 여기에 실제 질문 문장을 넣으면 그게 칩이 되고, 누르면 바로 전송돼
-- 그 자리에서 답을 받는다. 비워두면 위젯 config 라우트가 knowledge_faq 앞쪽
-- 질문으로 채운다(lib/bot/appearance.ts resolveStarterQuestions).
--
-- NULL 이 아니라 빈 배열이 기본이다 — knowledge_faq 와 같은 모양으로 맞춰
-- 읽는 쪽이 null 검사를 따로 하지 않게 한다. 기존 봇은 빈 배열이라 FAQ 폴백을 탄다.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS starter_questions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bots.starter_questions IS '위젯 첫 화면 「자주 묻는 질문」 칩 문장 배열 (문자열 최대 4개, 각 40자). 빈 배열이면 knowledge_faq 앞 3개의 질문으로 폴백한다. 이 값은 무인증 위젯 config 로 나간다.';

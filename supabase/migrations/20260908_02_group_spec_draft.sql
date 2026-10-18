-- 기능 요청 묶음의 스펙 초안 (Gleap 차용 P1-3).
--
-- 기능 요청에 코드 수정 PR 을 여는 것은 대개 틀린 답이다 — 무엇을 만들지는
-- 사람이 정해야 한다. 대신 "여러 사람이 말한 요청" 을 읽을 수 있는 스펙 초안으로
-- 정리해 두고, 만들지 말지는 운영자가 판단한다.

alter table insight_groups add column if not exists spec_draft text;
alter table insight_groups add column if not exists spec_drafted_at timestamptz;

comment on column insight_groups.spec_draft is
  '기능 요청 묶음의 스펙 초안(마크다운). 사람이 읽고 판단하는 재료이지 실행 지시가 아니다.';

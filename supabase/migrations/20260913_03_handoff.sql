-- 「상담원 연결」(백로그 B2 v2, 2026-09-13)
--
-- messages.handoff_at      — 방문자가 「상담원 연결」로 남긴 메시지. AI 가 답하지 않고 사람에게 간다.
-- conversations.owner_notified_at — 봇 소유자에게 상담원 연결 알림 메일을 마지막으로 보낸 시각(같은 대화 1시간 1통).
-- 전부 추가만. 기존 행은 NULL 이라 동작이 바뀌지 않는다.

alter table public.messages add column if not exists handoff_at timestamptz;
alter table public.conversations add column if not exists owner_notified_at timestamptz;

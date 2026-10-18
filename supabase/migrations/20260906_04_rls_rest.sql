-- 2026-09-06 P0-3 나머지: RLS 가 꺼져 있던 6개 테이블.
--
-- accounts·sessions 는 NextAuth 어댑터 테이블이고 코드는 service_role 로만 만진다.
-- cooldown_state·feedbacks·classifications·action_logs 는 A3(B계열 제거, 커밋 3a67a25)
-- 이후 코드 참조가 0건이다. 테이블은 남아 있지만 anon 키로 읽히면 안 된다.
--
-- 20260905_01_enable_rls_users.sql 과 같은 원칙: 정책은 만들지 않는다.
-- 인증이 NextAuth JWT 라 auth.uid() 는 항상 NULL 이고, 정책 0개 + RLS on = anon 전면 차단.
-- 앱 경로는 전부 service_role 이라 영향이 없다 (2026-09-06 실측 6개 테이블 전부 0행).

ALTER TABLE public.accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cooldown_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedbacks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.action_logs     ENABLE ROW LEVEL SECURITY;

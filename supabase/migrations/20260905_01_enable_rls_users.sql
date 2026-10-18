-- 2026-09-05 P0-3: public.users 가 anon 키로 그대로 읽혔다 (이름·이메일 평문 노출).
--
-- 앱은 users 를 NextAuth 콜백에서만 만지고, 그 두 곳 모두 service_role 클라이언트를 쓴다
-- (src/app/api/auth/[...nextauth]/route.ts:22, :45). service_role 은 RLS 를 우회하므로
-- 로그인 경로는 영향을 받지 않는다.
--
-- 정책은 만들지 않는다. 인증이 NextAuth JWT 전략이라 Supabase 의 auth.uid() 는 항상 NULL 이고,
-- RLS 를 켜고 정책이 하나도 없으면 anon 은 전면 차단된다. 이게 의도한 상태다.
--
-- 파일명 프리픽스: 기존 add_*.sql 이 init_schema.sql 보다 알파벳순으로 앞이라
-- 인스턴스를 재구축하면 순서가 깨진다. 이후 마이그레이션은 날짜 프리픽스를 붙인다.

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

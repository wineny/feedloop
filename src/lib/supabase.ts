import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// lazy 초기화 — bot-dev.ts에서 dotenv 로딩 후에도 동작하도록

let _supabase: SupabaseClient | null = null;

// 클라이언트 사이드와 일반적인 서버 사이드 작업에 사용
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_supabase) {
      _supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
    }
    return Reflect.get(_supabase, prop);
  },
});

// 권한 우회나 관리자 작업이 필요할 때 사용 (서버 사이드 전용)
export const getServiceRoleClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not defined');
  }
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not defined');
  }
  return createClient(url, serviceRoleKey);
};

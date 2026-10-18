import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { LoginCard } from '@/components/auth/LoginCard';

export const metadata: Metadata = { title: '로그인 — Feedloop' };

/**
 * 우리 스킨의 로그인 화면. NextAuth 기본 /api/auth/signin (흰 바탕에 버튼 하나) 대신 쓴다 —
 * authOptions.pages 가 signin·error 를 여기로 보낸다.
 *
 * callbackUrl 은 두 모양으로 온다:
 *  - 우리 페이지가 보낸 상대 경로 (`/bots/…/connect`)
 *  - NextAuth 자신이 보낸 절대 URL (`${NEXTAUTH_URL}/dashboard`) — /api/auth/signin 을 거치면 이렇게 온다
 * 절대 URL 은 NEXTAUTH_URL 과 같은 origin 일 때만 경로로 바꿔 받는다. 다른 origin·프로토콜 상대(`//`)는
 * 버린다 — 로그인 뒤 남의 사이트로 튕기는 오픈 리디렉트 방지. 첫 값만 본다.
 */
const FALLBACK = '/dashboard';

function safeCallbackUrl(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return FALLBACK;
  if (v.startsWith('/')) return v.startsWith('//') ? FALLBACK : v;
  try {
    const url = new URL(v);
    const own = new URL(process.env.NEXTAUTH_URL ?? '');
    if (url.origin !== own.origin) return FALLBACK;
    return url.pathname + url.search;
  } catch {
    return FALLBACK;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(params.callbackUrl);
  const rawError = Array.isArray(params.error) ? params.error[0] : params.error;

  // 이미 로그인돼 있으면 로그인 화면을 보여줄 이유가 없다 — 가려던 곳으로.
  const session = await getServerSession(authOptions);
  if (session?.user?.id) redirect(callbackUrl);

  return <LoginCard callbackUrl={callbackUrl} error={rawError ?? null} />;
}

import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // 화면 경로만 거친다. 빼는 것:
  // - /api (PayPal return·cancel·webhook, 위젯 API 포함), /_next, /_vercel
  // - /ingest — PostHog 프록시(next.config rewrites). 여기서 `/en/ingest` 로 바뀌면 rewrite 가 안 맞는다
  // - 점(.)이 있는 경로 — public 파일(/widget.js, /demo/*.html, favicon, icon.svg 등)
  matcher: '/((?!api/|ingest/|_next|_vercel|.*\\..*).*)',
};

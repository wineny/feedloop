import { ensureVisitorId } from '@/lib/analytics/posthog';

// 위젯(afterInteractive)보다 먼저 방문자 id 를 깔아 둔다 — PostHog 와 위젯이 같은 id 를 쓰게.
// PostHog 자체는 로그아웃이 확인된 뒤 PostHogGate 가 켠다(src/lib/analytics/posthog.ts).
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) ensureVisitorId();

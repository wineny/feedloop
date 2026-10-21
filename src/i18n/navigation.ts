import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// `usePathname` 은 내부 접두어(`/en`)를 떼어 준다 — 정적 렌더 HTML 은 `/en/inbox` 로 그려지므로
// next/navigation 의 usePathname 을 그대로 쓰면 서버(`/en/inbox`)와 브라우저(`/inbox`)가 어긋난다.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);

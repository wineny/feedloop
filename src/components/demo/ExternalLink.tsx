import type { ReactNode } from 'react';
import { isSampleUrl } from '@/lib/demo/sample-url';

interface ExternalLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
}

/** 새 탭으로 여는 바깥 링크. 견본 주소(`github.com/example/...`)면 누를 수 없는 글자로만 보인다. */
export function ExternalLink({ href, className, children }: ExternalLinkProps) {
  if (isSampleUrl(href)) {
    // 링크처럼 보이게 하는 hover 클래스는 걷어낸다 — Tailwind v4 는 클래스 순서가 아니라 유틸 순서로
    // 이겨서 `hover:no-underline` 을 덧붙여도 `hover:underline` 이 이긴다(코드 검토에서 확인).
    const inert = (className ?? '')
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('hover:'))
      .join(' ');
    return (
      <span className={`${inert} cursor-default`} title="Sample data">
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

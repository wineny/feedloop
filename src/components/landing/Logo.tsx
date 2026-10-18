import type { CSSProperties } from 'react';

/**
 * Feedloop 로고 마크 — 기울어진 무한 루프(두 고리). 2026-09-16 GPT 시안에서 형태를 가져와 SVG 로 다시 그렸다.
 * 색은 `currentColor` 라 놓이는 자리의 글자색을 따른다(기본은 코랄로 쓴다).
 */
export function LogoMark({ size = 24, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path
        d="M16 16c0-5.8 8.4-5.8 8.4 0s-8.4 5.8-8.4 0c0-5.8-8.4-5.8-8.4 0s8.4 5.8 8.4 0z"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="rotate(-28 16 16)"
      />
    </svg>
  );
}

/** 마크 + 워드마크. 내비·푸터·앱 헤더가 같은 조합을 쓴다. */
export function Wordmark({ markSize = 24, className }: { markSize?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark size={markSize} className="shrink-0 text-[#F2645C]" />
      <span>Feedloop</span>
    </span>
  );
}

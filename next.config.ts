import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // 온보딩 캡처는 작은 글씨투성이라 기본 q=75 로는 글자가 뭉갠다.
  // Next 16 은 여기 없는 quality 값을 조용히 기본값으로 떨어뜨린다.
  images: {
    qualities: [75, 90],
  },
  // 상위 폴더 lockfile 때문에 워크스페이스 루트가 한글 경로(hackaton/)로 오인되면
  // Turbopack이 chunk 이름 한글 바이트 경계에서 패닉한다 → 앱 디렉토리로 고정
  turbopack: {
    root: __dirname,
  },
  // PostHog 수집을 우리 도메인(/ingest)으로 받아 넘긴다 — 광고 차단기가 posthog.com 을 막는다.
  // 끝 슬래시를 붙였다 떼는 리다이렉트가 끼면 PostHog API 요청이 깨지므로 끈다.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/ingest/static/:path*', destination: 'https://us-assets.i.posthog.com/static/:path*' },
      { source: '/ingest/array/:path*', destination: 'https://us-assets.i.posthog.com/array/:path*' },
      { source: '/ingest/:path*', destination: 'https://us.i.posthog.com/:path*' },
    ];
  },
};

export default nextConfig;

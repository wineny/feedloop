import type { MetadataRoute } from 'next';

// `/robots.txt` 처럼 점이 든 경로는 proxy 를 안 거쳐 [locale] 로 들어가 빈 404 가 되고, 그게 1년 캐시된다.
// 파일을 따로 두어 그 경로를 [locale] 밖에서 받는다.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/ingest/'] },
  };
}

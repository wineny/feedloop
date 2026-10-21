import { describe, it, expect } from 'vitest';
import {
  verifyContextItems,
  formatVerifiedForPrompt,
  formatVerifiedForPrBody,
} from '@/lib/widget/verify-context';
import { collectContextItems } from '@/lib/widget/context';

/** 데모 레포(널널투어)의 실제 레이아웃 — 프로젝트가 `app/` 안에 또 들어 있다 */
const DEMO_REPO = [
  'app/app/page.tsx',
  'app/app/coupons/page.tsx',
  'app/app/coupons/[issueId]/use/page.tsx',
  'app/app/api/coupons/mine/route.ts',
  'app/app/api/coupons/issue/route.ts',
  'app/app/api/coupons/[issueId]/use/route.ts',
  'app/app/api/cron/route.ts',
  'app/lib/coupon-session.ts',
  'app/components/CalendarSheet.tsx',
  'app/package.json',
];

/** Feedloop 자신처럼 `src/app` 을 쓰고 라우트 그룹·catch-all 이 있는 레포 */
const SRC_REPO = [
  'src/app/(main)/dashboard/page.tsx',
  'src/app/api/health/route.ts',
  'src/app/api/widget/[botId]/messages/route.ts',
  'src/app/docs/[...slug]/page.tsx',
  'src/lib/thing.ts',
];

const items = (o: Partial<{ urls: string[]; errors: string[]; requests: string[] }>) => ({
  urls: o.urls ?? [],
  errors: o.errors ?? [],
  requests: o.requests ?? [],
});

describe('실패한 요청 대조', () => {
  it('레포에 없는 라우트를 missing 으로 잡는다 (PR #6 이 속은 그 값)', () => {
    const v = verifyContextItems(
      items({ requests: ['500 https://nullnul-tour-demo.vercel.app/api/coupons/history'] }),
      DEMO_REPO,
    );
    expect(v.requests[0].status).toBe('missing');
    expect(v.hasMissing).toBe(true);
  });

  it('실재하는 라우트는 confirmed', () => {
    const v = verifyContextItems(
      items({ requests: ['500 https://nullnul-tour-demo.vercel.app/api/coupons/mine'] }),
      DEMO_REPO,
    );
    expect(v.requests[0].status).toBe('confirmed');
    expect(v.hasMissing).toBe(false);
  });

  it('동적 세그먼트를 없는 라우트로 오판하지 않는다', () => {
    const v = verifyContextItems(
      items({ requests: ['500 /api/coupons/7f3a-9b2c/use'] }),
      DEMO_REPO,
    );
    expect(v.requests[0].status).toBe('confirmed');
  });

  it('페이지 파일만 있고 라우트 파일이 없는 경로는 API 로 안 쳐준다', () => {
    const v = verifyContextItems(items({ requests: ['500 /coupons'] }), DEMO_REPO);
    expect(v.requests[0].status).toBe('missing');
  });
});

describe('발생 페이지 대조', () => {
  it('중첩된 app/app 레이아웃에서도 페이지를 찾는다', () => {
    const v = verifyContextItems(items({ urls: ['https://x.vercel.app/coupons?tab=history'] }), DEMO_REPO);
    expect(v.urls[0].status).toBe('confirmed');
  });

  it('라우트 그룹 (main) 은 URL 에 안 나오므로 무시한다', () => {
    const v = verifyContextItems(items({ urls: ['https://x.app/dashboard'] }), SRC_REPO);
    expect(v.urls[0].status).toBe('confirmed');
  });

  it('catch-all 은 더 긴 경로도 받는다', () => {
    const v = verifyContextItems(items({ urls: ['https://x.app/docs/a/b/c'] }), SRC_REPO);
    expect(v.urls[0].status).toBe('confirmed');
  });

  it('루트 경로는 항상 confirmed', () => {
    const v = verifyContextItems(items({ urls: ['https://x.app/'] }), DEMO_REPO);
    expect(v.urls[0].status).toBe('confirmed');
  });

  it('없는 페이지는 missing', () => {
    const v = verifyContextItems(items({ urls: ['https://x.app/there-is-no-such-page'] }), DEMO_REPO);
    expect(v.urls[0].status).toBe('missing');
  });

  it('레포에 라우트·페이지 파일이 하나도 없으면 unknown 이지 missing 이 아니다', () => {
    const v = verifyContextItems(items({ urls: ['https://x.app/anything'] }), ['README.md', 'main.py']);
    expect(v.urls[0].status).toBe('unknown');
    expect(v.hasMissing).toBe(false);
  });
});

describe('콘솔 에러 대조 — 번들 산출물을 없는 파일로 몰지 않는다', () => {
  it('page.js:42 같은 번들 이름은 unknown', () => {
    const v = verifyContextItems(
      items({ errors: ["TypeError: Cannot read properties of undefined (reading 'map') (page.js:42)"] }),
      DEMO_REPO,
    );
    expect(v.errors[0].status).toBe('unknown');
    expect(v.hasMissing).toBe(false);
  });

  it('소스맵이 풀린 .tsx 이름이 실재하면 confirmed', () => {
    const v = verifyContextItems(
      items({ errors: ['TypeError at CalendarSheet.tsx:31'] }),
      DEMO_REPO,
    );
    expect(v.errors[0].status).toBe('confirmed');
  });

  it('실재하지 않는 .tsx 이름은 missing', () => {
    const v = verifyContextItems(
      items({ errors: ['TypeError at ReservationForm.tsx:12'] }),
      DEMO_REPO,
    );
    expect(v.errors[0].status).toBe('missing');
    expect(v.errors[0].note).toContain('ReservationForm.tsx');
  });
});

describe('출력', () => {
  it('프롬프트 본문에 판정 표시가 붙는다', () => {
    const v = verifyContextItems(
      items({ requests: ['500 /api/coupons/history'], urls: ['https://x.app/coupons'] }),
      DEMO_REPO,
    );
    const out = formatVerifiedForPrompt(v);
    expect(out).toContain('레포에서 확인 안 됨');
    expect(out).toContain('/api/coupons/history');
    // 확인된 항목에는 경고가 안 붙는다
    const urlLine = out.split('\n').find((l) => l.includes('/coupons') && !l.includes('history'));
    expect(urlLine).not.toContain('확인 안 됨');
  });

  it('PR 본문은 확인된 것과 확인 안 된 것을 나눈다', () => {
    const v = verifyContextItems(
      items({ requests: ['500 /api/coupons/history'], urls: ['https://x.app/coupons'] }),
      DEMO_REPO,
    );
    const body = formatVerifiedForPrBody(v);
    expect(body).toContain("Values sent by the reporter's browser");
    expect(body).toContain('were not found in this repository');
    expect(body.indexOf("Values sent by the reporter's browser")).toBeLessThan(
      body.indexOf('were not found in this repository'),
    );
  });

  it('맥락이 없으면 빈 문자열', () => {
    const v = verifyContextItems(items({}), DEMO_REPO);
    expect(formatVerifiedForPrompt(v)).toBe('');
    expect(formatVerifiedForPrBody(v)).toBe('');
  });
});

describe('collectContextItems — 원자료 수집', () => {
  it('여러 제보에서 겹치는 값을 횟수와 함께 남긴다', () => {
    const raw = {
      url: 'https://x.app/coupons?tab=history',
      errors: ['boom'],
      failed_requests: ['500 /api/coupons/history'],
    };
    const got = collectContextItems([raw, raw, { ...raw, url: 'https://x.app/other' }]);
    expect(got.urls[0]).toContain('(2건)');
    expect(got.errors[0]).toContain('boom');
    expect(got.requests[0]).toContain('/api/coupons/history');
  });

  it('맥락이 없는 채널(카카오)은 빈 항목', () => {
    expect(collectContextItems([undefined, null])).toEqual({ urls: [], errors: [], requests: [], targets: [], targetsForPrBody: [], targetItems: [] });
  });

  it('수집한 원자료가 그대로 대조에 물린다', () => {
    const got = collectContextItems([
      { failed_requests: ['500 https://nullnul-tour-demo.vercel.app/api/coupons/history'] },
    ]);
    const v = verifyContextItems(got, DEMO_REPO);
    expect(v.hasMissing).toBe(true);
  });
});

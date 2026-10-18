import { describe, it, expect } from 'vitest';
import {
  sanitizeWidgetContext,
  sanitizeUrl,
  maskSecrets,
  formatContextForPrompt,
  mergeContextsForPrompt,
} from '@/lib/widget/context';

// 이 경로는 무인증이다 — 아무나 아무 값이나 보낼 수 있고, 통과한 값은
// 그대로 자동 PR 프롬프트에 실린다. 그래서 마스킹과 상한을 테스트한다.

describe('maskSecrets — 자유 텍스트의 비밀 가리기', () => {
  it('이메일을 가린다', () => {
    expect(maskSecrets('failed for user@example.com')).toBe('failed for ***');
  });

  it('JWT 를 가린다', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature';
    expect(maskSecrets(`Authorization ${jwt} rejected`)).toBe('Authorization *** rejected');
  });

  it('32자 이상 영숫자 덩어리(API 키 모양)를 가린다', () => {
    const key = 'sk' + 'A1b2C3d4'.repeat(5);
    expect(maskSecrets(`key=${key}`)).toBe('key=***');
  });

  it('평범한 에러 문구는 그대로 둔다', () => {
    const msg = "TypeError: Cannot read properties of undefined (reading 'map')";
    expect(maskSecrets(msg)).toBe(msg);
  });
});

describe('sanitizeUrl — 재현에 필요한 건 남기고 비밀만 지운다', () => {
  it('민감한 키의 값을 가린다', () => {
    const out = sanitizeUrl('https://shop.example.com/cart?token=abc123&tab=coupons');
    expect(out).toContain('token=***');
    // 재현에 필요한 평범한 쿼리는 살아 있어야 한다
    expect(out).toContain('tab=coupons');
  });

  it('키 이름이 평범해도 값이 이메일이면 가린다', () => {
    const out = sanitizeUrl('https://a.com/p?ref=someone@example.com');
    expect(out).not.toContain('someone@example.com');
    expect(out).toContain('***');
  });

  it('경로에 든 비밀도 가린다 — /users/{email}/orders/{key} 는 흔한 모양이다', () => {
    // QA 실측에서 실제로 새어 나갔던 경로. 쿼리만 가리면 여기로 빠진다.
    const out = sanitizeUrl(
      'https://a.com/users/victim@example.com/orders/sk_live_9999888877776666555544443333',
    );
    expect(out).not.toContain('victim@example.com');
    expect(out).not.toContain('sk_live_9999888877776666555544443333');
    expect(out).toContain('***');
    // 평범한 경로 세그먼트는 살아 있어야 한다
    expect(out).toContain('/users/');
    expect(out).toContain('/orders/');
  });

  it('인코딩된 비밀(%40)도 잡는다', () => {
    const out = sanitizeUrl('https://a.com/u/victim%40example.com/x');
    expect(out).not.toContain('victim');
    expect(out).toContain('***');
  });

  it('평범한 경로는 건드리지 않는다', () => {
    expect(sanitizeUrl('https://a.com/coupons/history')).toBe('https://a.com/coupons/history');
  });

  it('URL 에 실린 자격증명(user:pass@host)은 통째로 버린다', () => {
    const out = sanitizeUrl('https://admin:hunter2@a.com/p');
    expect(out).not.toContain('admin');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('a.com');
  });

  it('해시는 버린다', () => {
    expect(sanitizeUrl('https://a.com/p#section')).toBe('https://a.com/p');
  });

  it('http(s) 가 아니면 버린다', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeUrl('data:text/html,<script>')).toBeUndefined();
  });

  it('URL 이 아니면 버린다', () => {
    expect(sanitizeUrl('그냥 문자열')).toBeUndefined();
  });
});

describe('sanitizeWidgetContext — 모양·개수 강제', () => {
  it('정상 입력을 그대로 통과시킨다', () => {
    const ctx = sanitizeWidgetContext({
      url: 'https://a.com/coupons',
      user_agent: 'Mozilla/5.0',
      viewport: '390x844',
      errors: ["TypeError: Cannot read properties of undefined (reading 'map')"],
    });
    expect(ctx?.url).toBe('https://a.com/coupons');
    expect(ctx?.errors).toHaveLength(1);
  });

  it('에러는 5개까지만 남긴다', () => {
    const ctx = sanitizeWidgetContext({
      errors: Array.from({ length: 50 }, (_, i) => `error ${i}`),
    });
    expect(ctx?.errors).toHaveLength(5);
  });

  it('긴 에러 문구를 자른다', () => {
    const ctx = sanitizeWidgetContext({ errors: ['x'.repeat(5000)] });
    expect(ctx!.errors![0].length).toBeLessThanOrEqual(300);
  });

  it('쓸 만한 게 없으면 null — 컬럼을 비워둔다', () => {
    expect(sanitizeWidgetContext({})).toBeNull();
    expect(sanitizeWidgetContext(null)).toBeNull();
    expect(sanitizeWidgetContext('문자열')).toBeNull();
    expect(sanitizeWidgetContext([1, 2, 3])).toBeNull();
  });

  it('배열이 아닌 errors 는 조용히 버린다', () => {
    expect(sanitizeWidgetContext({ errors: 'not an array' })).toBeNull();
  });

  // ── I-45: 방문자가 깔아 둔 확장이 낸 에러 ──────────────────
  // 남겨 두면 요약이 증상으로 받아 적고, 묶기가 그 문자열로 전혀 다른 제보를 한데 묶는다.
  // 실측(2026-09-18 전수 QA): 「쿠폰 사용 버튼이 안 먹는다」가 「MetaMask 연결 실패」 묶음에 합류.

  it('확장이 낸 에러는 빼고, 사이트가 낸 에러만 남긴다', () => {
    const ctx = sanitizeWidgetContext({
      errors: [
        'Error at chrome-extension://abcdefghijklmno/inpage.js:1:1',
        "TypeError: Cannot read properties of undefined (reading 'map')",
        'boom at moz-extension://1234/content.js:9:9',
      ],
    });
    expect(ctx?.errors).toEqual(["TypeError: Cannot read properties of undefined (reading 'map')"]);
  });

  it('확장 에러는 «자르기 전에» 빠진다 — 진짜 에러가 상한 밖으로 밀려나면 안 된다', () => {
    const ctx = sanitizeWidgetContext({
      errors: [
        ...Array.from({ length: 5 }, (_, i) => `noise ${i} at chrome-extension://xyz/inpage.js:1:1`),
        '진짜 에러: 쿠폰 사용 확인 실패',
      ],
    });
    // 나중에 걸렀다면 확장 에러 5개가 상한을 채우고 진짜 에러는 사라진다.
    expect(ctx?.errors).toEqual(['진짜 에러: 쿠폰 사용 확인 실패']);
  });

  it('확장 에러밖에 없으면 errors 를 아예 안 싣는다', () => {
    const ctx = sanitizeWidgetContext({
      url: 'https://a.com/coupons',
      errors: ['Error at chrome-extension://abc/inpage.js:1:1'],
    });
    expect(ctx?.url).toBe('https://a.com/coupons');
    expect(ctx?.errors).toBeUndefined();
  });

  it('확장과 무관한 곳에 쓰인 낱말은 그대로 둔다', () => {
    const msg = 'MetaMask 결제 버튼이 눌리지 않습니다';
    expect(sanitizeWidgetContext({ errors: [msg] })?.errors).toEqual([msg]);
  });

  it('숫자·객체가 섞여 와도 문자열만 남긴다', () => {
    const ctx = sanitizeWidgetContext({ errors: [1, {}, 'real error', null] });
    expect(ctx?.errors).toEqual(['real error']);
  });
});

describe('formatContextForPrompt', () => {
  it('값이 없으면 빈 문자열 — 프롬프트에 빈 섹션이 안 생긴다', () => {
    expect(formatContextForPrompt(null)).toBe('');
    expect(formatContextForPrompt({})).toBe('');
  });

  it('페이지와 에러를 함께 싣는다', () => {
    const out = formatContextForPrompt({
      url: 'https://a.com/coupons',
      errors: ['TypeError: x is undefined'],
    });
    expect(out).toContain('발생 페이지: https://a.com/coupons');
    expect(out).toContain('TypeError: x is undefined');
  });
});

describe('mergeContextsForPrompt — 묶음의 맥락 합치기', () => {
  it('겹치는 페이지는 횟수로 남긴다 — 그게 곧 신호다', () => {
    const out = mergeContextsForPrompt([
      { url: 'https://a.com/coupons' },
      { url: 'https://a.com/coupons' },
      { url: 'https://a.com/mypage' },
    ]);
    expect(out).toContain('https://a.com/coupons (2건)');
    expect(out).toContain('https://a.com/mypage');
  });

  it('많이 나온 것이 먼저 온다', () => {
    const out = mergeContextsForPrompt([
      { url: 'https://a.com/rare' },
      { url: 'https://a.com/common' },
      { url: 'https://a.com/common' },
    ]);
    expect(out.indexOf('common')).toBeLessThan(out.indexOf('rare'));
  });

  it('빈 배열이면 빈 문자열', () => {
    expect(mergeContextsForPrompt([])).toBe('');
    expect(mergeContextsForPrompt([null, undefined, {}])).toBe('');
  });
});

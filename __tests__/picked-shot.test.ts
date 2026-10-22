import { describe, expect, it } from 'vitest';
import {
  MIN_MARK_PX,
  PICKED_SHOT_RETENTION_DAYS,
  frameOf,
  missingShotKind,
  pagePathLabel,
  pickedFromContext,
  safePageUrl,
  thumbLayout,
  visibleRect,
} from '@/lib/widget/picked-shot';
import { SHOT_RETENTION_DAYS } from '@/lib/widget/shots';

const VIEW = { w: 1320, h: 1334 };
const SHOT = { url: 'https://signed.test/a.webp', width: 1280, height: 1293 };

describe('picked-shot — 썸네일 배치', () => {
  it('보존 기간이 서버 상수와 같다', () => {
    expect(PICKED_SHOT_RETENTION_DAYS).toBe(SHOT_RETENTION_DAYS);
  });

  it('짚은 영역을 가운데 두고, 이미지 밖이 안 보이게 가둔다(빈 칸 없음)', () => {
    const box = { w: 240, h: 160 };
    const l = thumbLayout({ viewport: VIEW, shot: SHOT, rect: { x: 600, y: 600, w: 134, h: 23 } }, box);
    // 이미지가 상자를 덮는다
    expect(l.img.left).toBeLessThanOrEqual(0);
    expect(l.img.top).toBeLessThanOrEqual(0);
    expect(l.img.left + l.img.width).toBeGreaterThanOrEqual(box.w - 0.001);
    expect(l.img.top + l.img.height).toBeGreaterThanOrEqual(box.h - 0.001);
    // 테두리 중심이 상자 중심
    expect(l.mark!.left + l.mark!.width / 2).toBeCloseTo(120, 0);
    expect(l.mark!.top + l.mark!.height / 2).toBeCloseTo(80, 0);
  });

  it('작은 요소는 최소 12px 상자 + small 표시', () => {
    const l = thumbLayout({ viewport: VIEW, shot: SHOT, rect: { x: 10, y: 10, w: 4, h: 3 } }, { w: 96, h: 72 });
    expect(l.mark!.width).toBeGreaterThanOrEqual(MIN_MARK_PX);
    expect(l.mark!.height).toBeGreaterThanOrEqual(MIN_MARK_PX);
    expect(l.mark!.small).toBe(true);
  });

  it('화면 위로 삐져나간 영역(y<0)은 보이던 부분만 잡는다, 전혀 안 보였으면 테두리 없음', () => {
    expect(visibleRect({ x: 24, y: -160, w: 1257, h: 320 }, VIEW)).toEqual({ x: 24, y: 0, w: 1257, h: 160 });
    expect(thumbLayout({ viewport: VIEW, rect: { x: 0, y: -500, w: 10, h: 10 } }, { w: 96, h: 72 }).mark).toBeNull();
  });

  it('contain(미니맵·라이트박스)은 판 전체가 상자 안', () => {
    const l = thumbLayout({ viewport: VIEW, rect: { x: 0, y: 0, w: 100, h: 100 } }, { w: 240, h: 160 }, { contain: true });
    expect(l.img.width).toBeLessThanOrEqual(240);
    expect(l.img.height).toBeLessThanOrEqual(160.001);
    expect(l.img.left).toBeGreaterThanOrEqual(0);
  });

  it('이미지가 있으면 세로는 이미지 비율 — 보낼 때 뷰포트가 달라도 늘어나지 않는다 (코드 리뷰 M1)', () => {
    // 짚을 때 1320×1334 → 이미지 1280×1293. 보낼 때 주소창이 접혀 1320×1414 가 와도 판은 이미지 비율
    const f = frameOf({ viewport: { w: 1320, h: 1414 }, shot: SHOT });
    expect(f.w).toBe(1320);
    expect(f.h).toBeCloseTo(1320 * 1293 / 1280, 5);
  });

  it('뷰포트가 없으면 이미지 크기, 둘 다 없으면 rect 를 담는 판', () => {
    expect(frameOf({ shot: SHOT })).toEqual({ w: 1280, h: 1293 });
    expect(frameOf({ rect: { x: 1500, y: 10, w: 100, h: 10 } })).toEqual({ w: 1600, h: 800 });
  });
});

describe('picked-shot — 재료와 폴백 문구', () => {
  const ctx = {
    viewport: '1320x1334',
    target: { kind: '영역', tag: 'div', selector: '#pick-list', heading: '오늘의 널널 PICK', rect: { x: 24, y: -160, w: 1257, h: 320 }, shot: 'aaaaaaaa-1111-4111-8111-111111111111' },
  };
  it('짚는 순간의 뷰포트(target.viewport)가 보낼 때 값보다 우선이다', () => {
    const d = pickedFromContext({ ...ctx, target: { ...ctx.target, viewport: '390x844' } }, null)!;
    expect(d.viewport).toEqual({ w: 390, h: 844 });
  });

  it('context 에서 라벨·rect·뷰포트·hadShot 을 뽑는다', () => {
    const d = pickedFromContext(ctx, SHOT, '2026-09-25T00:00:00Z')!;
    expect(d.label).toBe('「오늘의 널널 PICK」 구역 · 1257×320');
    // 영어 화면은 영어 이름(GitHub PR 본문과 같은 규칙)
    expect(pickedFromContext(ctx, SHOT, '2026-09-25T00:00:00Z', 'en')!.label).toBe('"오늘의 널널 PICK" section · 1257×320');
    expect(d.viewport).toEqual(VIEW);
    expect(d.hadShot).toBe(true);
    expect(d.shot).toEqual(SHOT);
    expect(pickedFromContext({ url: 'https://x' }, null)).toBeNull();
  });

  it('이미지가 없을 때 — 원래 없음 / 보존 기간 경과 / 못 불러옴', () => {
    const now = Date.parse('2026-12-31T00:00:00Z');
    expect(missingShotKind({ shot: SHOT, hadShot: true })).toBeNull();
    expect(missingShotKind({ shot: null, hadShot: false })).toBe('noShot');
    expect(missingShotKind({ shot: null, hadShot: true, at: '2026-09-01T00:00:00Z' }, now)).toBe('expired');
    expect(missingShotKind({ shot: null, hadShot: true, at: '2026-12-30T00:00:00Z' }, now)).toBe('failed');
  });
});

describe('picked-shot — 「제보된 페이지」 주소', () => {
  const target = { kind: '버튼', tag: 'button', selector: 'main > button', text: '쿠폰 받기' };
  it('짚은 시점 페이지(target.url)를 쓴다 — 보낼 때 페이지(context.url)보다 우선', () => {
    const d = pickedFromContext({ url: 'https://a.test/later', target: { ...target, url: 'https://a.test/spots/g?tab=1' } }, null)!;
    expect(d.pageUrl).toBe('https://a.test/spots/g?tab=1');
  });
  it('target.url 이 없으면 context.url', () => {
    expect(pickedFromContext({ url: 'https://a.test/x', target }, null)!.pageUrl).toBe('https://a.test/x');
  });
  it('주소가 전혀 없으면 링크 없음', () => {
    expect(pickedFromContext({ target }, null)!.pageUrl).toBeUndefined();
  });
  it('http(s) 가 아니면 싣지 않는다 (javascript:·data:·상대경로)', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '/spots/g', 'ftp://a.test/x', ' https://a.test']) {
      expect(pickedFromContext({ target: { ...target, url: bad } }, null)!.pageUrl).toBeUndefined();
      expect(safePageUrl(bad)).toBeUndefined();
    }
    // 양성 대조 — 같은 경로로 https 는 통과한다
    expect(safePageUrl('HTTPS://a.test/x')).toBe('HTTPS://a.test/x');
    expect(safePageUrl('http://a.test/x')).toBe('http://a.test/x');
  });
  it('링크 글자는 경로+쿼리만', () => {
    expect(pagePathLabel('https://nullnul-tour-demo.vercel.app/spots/gyeongbokgung')).toBe('/spots/gyeongbokgung');
    expect(pagePathLabel('https://a.test/c?tab=used')).toBe('/c?tab=used');
    expect(pagePathLabel('https://a.test')).toBe('a.test');
    expect(pagePathLabel('https://a.test/?q=1')).toBe('/?q=1');
  });
});

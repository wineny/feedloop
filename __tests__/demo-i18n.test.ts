import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuidedDemo } from '@/components/demo/guided/GuidedDemo';
import { SiteStage } from '@/components/demo/guided/SiteStage';
import { Widget } from '@/components/demo/guided/Widget';
import { INITIAL, getScript, type Scene } from '@/components/demo/guided/script';
import { getDemoData } from '@/lib/demo/mock-data';
import { renderWithIntl } from './helpers/intl';

// 영어 랜딩의 가이드 데모 구역에 한국어가 한 글자도 없어야 한다(PayPal 해커톤 심사위원이 처음 보는 화면).
// 데모는 클라이언트에서 각본을 그리므로 서버 HTML 만으로는 부족하다 — 각본의 모든 단계를 직접 렌더해 본다.

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const HANGUL = /[가-힣]/g;
const hangul = (s: string) => s.match(HANGUL)?.length ?? 0;
const noop = () => {};

/** 단계 `upto` 직전까지의 프레임을 몰아 적용한 장면 */
function sceneAt(locale: 'en' | 'ko', upto: number): Scene {
  const { STEPS } = getScript(locale);
  let s: Scene = { ...INITIAL };
  for (let i = 0; i <= upto; i++) {
    s = { ...s, page: STEPS[i].page };
    for (const f of STEPS[i].frames) s = { ...s, ...(typeof f.patch === 'function' ? f.patch(s) : f.patch) };
  }
  return s;
}

describe('가이드 데모 — 영어판에 한국어가 없다', () => {
  const en = getScript('en');

  it('각본의 모든 말(제목·지시·말풍선·대사·주소)이 영어다', () => {
    const words: string[] = [en.SAY, ...en.SIMILAR_SAYS, ...Object.values(en.PAGE_URL), en.POINT_LABEL];
    for (const s of en.STEPS) {
      words.push(s.title, s.short, s.hint, s.label ?? '', s.spot?.say ?? '', ...(s.spot?.text ?? []));
      if (s.target && 'text' in s.target) words.push(...s.target.text);
      let scene: Scene = { ...INITIAL };
      for (const f of s.frames) {
        scene = { ...scene, ...(typeof f.patch === 'function' ? f.patch(scene) : f.patch) };
        for (const m of scene.msgs) words.push(m.text);
      }
    }
    expect(words.join('\n').match(HANGUL)).toBeNull();
  });

  it('단계마다 렌더한 위젯·무대에 한국어가 없다', () => {
    for (let i = 0; i < en.STEPS.length; i++) {
      const scene = { ...sceneAt('en', i), picked: { x: 0, y: 0, w: 0, h: 0, label: 'Get coupon' }, picking: i === 2, attached: i >= 3 };
      const widget = renderWithIntl(React.createElement(Widget, { scene, want: null, onHit: noop }), 'en');
      expect(hangul(widget), `${en.STEPS[i].key} 위젯`).toBe(0);
      const stage = renderWithIntl(
        React.createElement(SiteStage, {
          scene,
          target: en.STEPS[i].target,
          hint: en.STEPS[i].hint,
          spot: en.STEPS[i].spot ?? null,
          handoff: i === 4,
          onHit: noop,
          onPick: noop,
          onTargetMissing: noop,
          onSkip: noop,
        }),
        'en',
      );
      // iframe 주소는 영어판 사본이어야 한다
      expect(stage, `${en.STEPS[i].key} 무대`).not.toContain('index.ko.html');
      expect(hangul(stage), `${en.STEPS[i].key} 무대`).toBe(0);
    }
  });

  it('데모 틀(GuidedDemo) 전체를 렌더해도 한국어가 없다', () => {
    const html = renderWithIntl(React.createElement(GuidedDemo, { inline: true }), 'en');
    expect(hangul(html)).toBe(0);
    expect(html).toContain('/demo/nulnul-map/index.html');
  });

  it('영어판 화면 사본(public/demo/*/index.html)에 한국어가 없다', () => {
    for (const page of ['mail', 'team-inbox', 'team-groups', 'team-pr', 'nulnul-map']) {
      const html = fs.readFileSync(path.resolve(__dirname, `../public/demo/${page}/index.html`), 'utf8');
      expect(hangul(html), page).toBe(0);
      expect(html, page).toContain('lang="en"');
    }
  });

  it('영어 시연 가게는 Wander Korea 다(옛 이름 Nulnul 이 화면 사본·문구에 남지 않는다)', () => {
    for (const page of ['mail', 'team-inbox', 'team-groups', 'team-pr', 'nulnul-map']) {
      const html = fs.readFileSync(path.resolve(__dirname, `../public/demo/${page}/index.html`), 'utf8');
      expect(html, page).not.toMatch(/nulnul/i);
    }
    const dict = fs.readFileSync(path.resolve(__dirname, '../messages/en/demo.json'), 'utf8');
    const script = fs.readFileSync(path.resolve(__dirname, '../src/components/demo/guided/script.en.ts'), 'utf8');
    expect(dict + script).not.toMatch(/nulnul/i);
    expect(dict).toContain('Wander Korea');
    expect(JSON.stringify(getDemoData('en'))).not.toMatch(/nulnul/i);
  });

  it('쿠폰 마감일은 지난 날짜가 아니고 요일이 그 날짜와 맞다(2027년 1월 이후)', () => {
    const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
    const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const read = (f: string) => fs.readFileSync(path.resolve(__dirname, `../public/demo/nulnul-map/${f}`), 'utf8');
    const ko = [...read('index.ko.html').matchAll(/(\d+)월 (\d+)일 \(([월화수목금토일])\)/g)];
    const en = [...read('index.html').matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d+) \((Sun|Mon|Tue|Wed|Thu|Fri|Sat)\)/g)];
    expect(ko.length).toBeGreaterThan(0);
    expect(en.length).toBe(ko.length);
    for (const [, m, d, w] of ko) {
      const date = new Date(Date.UTC(2027, Number(m) - 1, Number(d)));
      expect(date.getTime(), `${m}/${d}`).toBeGreaterThanOrEqual(Date.UTC(2027, 0, 1));
      expect(WEEKDAY[date.getUTCDay()], `${m}/${d}`).toBe(w);
    }
    for (const [, m, d, w] of en) {
      const date = new Date(Date.UTC(2027, MONTH_EN.indexOf(m), Number(d)));
      expect(WEEKDAY_EN[date.getUTCDay()], `${m} ${d}`).toBe(w);
    }
  });

  it('영어 연습용 데이터(getDemoData)에 한국어가 없다', () => {
    expect(hangul(JSON.stringify(getDemoData('en')))).toBe(0);
  });

  it('「화면에서 선택하기」 예시 화면은 언어마다 그 언어로 찍은 화면이다', () => {
    type Inbox = {
      shots: Record<string, Record<string, { url: string }>>;
      contexts: Record<string, Record<string, { url: string; target: { rect: unknown; url: string } }>>;
    };
    const pick = (l: 'en' | 'ko') => {
      const inbox = getDemoData(l).inbox as Inbox;
      return { shot: inbox.shots['demo-conv-4']['d4-1'].url, ctx: inbox.contexts['demo-conv-4']['d4-1'] };
    };
    const en = pick('en');
    const ko = pick('ko');
    expect(en.shot).toBe('/demo/picked-shot.webp');
    expect(en.ctx.url).toBe('https://nullnul-tour-demo.vercel.app/en/spots/gyeongbokgung');
    expect(en.ctx.target.url).toBe(en.ctx.url);
    expect(en.ctx.target.rect).toEqual({ x: 804, y: 378, w: 107, h: 44 });
    expect(ko.shot).toBe('/demo/picked-shot.ko.webp');
    expect(ko.ctx.url).toBe('https://nullnul-tour-demo.vercel.app/spots/gyeongbokgung');
    expect(ko.ctx.target.rect).toEqual({ x: 828, y: 371, w: 84, h: 44 });
    for (const f of [en.shot, ko.shot]) expect(fs.existsSync(path.resolve(__dirname, `../public${f}`)), f).toBe(true);
  });
});

describe('가이드 데모 — 한국어판은 그대로 한국어다', () => {
  it('ko 로 렌더하면 한국어 각본·사본을 쓴다', () => {
    const html = renderWithIntl(React.createElement(GuidedDemo, { inline: true }), 'ko');
    expect(hangul(html)).toBeGreaterThan(0);
    expect(html).toContain('/demo/nulnul-map/index.ko.html');
    expect(html).toContain('한 바퀴 둘러보기');
    expect(getScript('ko').SAY).toBe('쿠폰 다운로드가 잘 안됩니다');
  });

  it('ko 연습용 데이터는 한국어이고, 영어와 같은 구조다', () => {
    const ko = getDemoData('ko');
    const en = getDemoData('en');
    expect(hangul(JSON.stringify(ko))).toBeGreaterThan(0);
    expect(Object.keys(ko)).toEqual(Object.keys(en));
    const koInbox = ko.inbox as { conversations: { id: string }[] };
    const enInbox = en.inbox as { conversations: { id: string }[] };
    expect(koInbox.conversations.map((c) => c.id)).toEqual(enInbox.conversations.map((c) => c.id));
  });
});

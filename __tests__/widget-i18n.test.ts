// 위젯 영문화(i18n 3/8) — 서버 기본 문구가 ?locale= 로 갈리고, 위젯 표가 en·ko 짝이 맞는지.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  bot: {
    id: 'b1',
    service_name: 'Nulnul',
    status: 'active',
    display_name: null,
    status_text: null,
    greeting: null,
    profile_image_url: null,
    operator_display_name: null,
    accent_color: null,
    visitor_bubble_color: null,
    starter_questions: [],
    starter_faq_fallback: false,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/widget/http', async (orig) => ({
  ...(await orig<typeof import('@/lib/widget/http')>()),
  resolveWidgetBot: vi.fn(async () => h.bot),
}));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: vi.fn() }));

import { GET } from '@/app/api/widget/[botId]/config/route';
import { HOLDING_MESSAGE, HOLDING_MESSAGE_EN, applyHoldingPolicy, escalationNotice, isHoldingResponse } from '@/lib/bot/holding';
import { buildLoopClosedBody } from '@/lib/auto-dev/loop-closed';
import { CHIP_ONLY_LABELS, isChipOnlyText } from '@/lib/widget/chips';
import { defaultReplyNotices } from '@/lib/widget/strings';
import enBots from '../messages/en/bots.json';
import koBots from '../messages/ko/bots.json';
import enCommon from '../messages/en/common.json';
import koCommon from '../messages/ko/common.json';

async function config(query: string, headers?: Record<string, string>) {
  const req = new NextRequest(`http://localhost/api/widget/b1/config${query}`, { headers });
  const res = await GET(req, { params: Promise.resolve({ botId: 'b1' }) });
  return (await res.json()) as {
    displayName: string;
    statusText: string;
    greeting: string;
    operatorDisplayName: string;
    chips: { hint: string; label: string }[];
  };
}

beforeEach(() => {
  h.bot = { ...h.bot, display_name: null, status_text: null, greeting: null, operator_display_name: null };
});

describe('GET /api/widget/[botId]/config — ?locale=', () => {
  it('en: 기본 인사말·운영자 이름·상태 문구·칩이 영어다 (2단계 사전과 같은 문장)', async () => {
    const c = await config('?locale=en');
    expect(c.statusText).toBe(enBots.defaults.statusText);
    expect(c.greeting).toBe(enBots.defaults.greeting.replace('{name}', 'Nulnul'));
    expect(c.operatorDisplayName).toBe('Nulnul team');
    expect(c.chips.map((x) => x.label)).toEqual([enBots.appearance.chips.bug, enBots.appearance.chips.feature]);
  });

  it('ko: 한국어 기본 문구가 그대로다', async () => {
    const c = await config('?locale=ko');
    expect(c.statusText).toBe('보통 몇 분 안에 답해요');
    expect(c.greeting).toBe(koBots.defaults.greeting.replace('{name}', 'Nulnul'));
    expect(c.operatorDisplayName).toBe('Nulnul 팀');
    expect(c.chips.map((x) => x.label)).toEqual(['불편한 점이 있어요', '기능 제안이 있어요']);
  });

  it('locale 이 없거나 en|ko 가 아니면 en', async () => {
    for (const q of ['', '?locale=fr', '?locale=KO', '?locale=ko-KR', '?locale=']) {
      expect((await config(q)).statusText).toBe(enBots.defaults.statusText);
    }
  });

  it('?locale 이 없으면(옛 widget.js 캐시) Accept-Language 로 고른다', async () => {
    expect((await config('', { 'accept-language': 'ko-KR,ko;q=0.9' })).statusText).toBe(koBots.defaults.statusText);
    expect((await config('', { 'accept-language': 'en-US,en;q=0.9' })).statusText).toBe(enBots.defaults.statusText);
    // ?locale 이 있으면 그것이 우선
    expect((await config('?locale=en', { 'accept-language': 'ko-KR' })).statusText).toBe(enBots.defaults.statusText);
  });

  it('운영자가 직접 쓴 값은 언어와 상관없이 그대로 나간다', async () => {
    h.bot = { ...h.bot, display_name: 'Cafe', status_text: 'Back at 9', greeting: 'Hello!', operator_display_name: 'Mina' };
    for (const q of ['?locale=en', '?locale=ko']) {
      const c = await config(q);
      expect([c.displayName, c.statusText, c.greeting, c.operatorDisplayName]).toEqual(['Cafe', 'Back at 9', 'Hello!', 'Mina']);
    }
  });
});

describe('대기 문구·안내', () => {
  it('영어 대기 문구는 사전(common.holdingMessage)과 같고, 한국어도 그렇다', () => {
    expect(HOLDING_MESSAGE_EN).toBe(enCommon.holdingMessage);
    expect(HOLDING_MESSAGE).toBe(koCommon.holdingMessage);
  });

  it('applyHoldingPolicy·isHoldingResponse 는 두 문장을 모두 대기 문구로 인정한다', () => {
    for (const msg of [HOLDING_MESSAGE, HOLDING_MESSAGE_EN]) {
      const r = applyHoldingPolicy({ response: msg, insight: { category: 'cs' }, escalate: true });
      expect(r.response).toBe(msg); // 이미 대기 문구면 덮어쓰지 않는다
      expect(isHoldingResponse(msg)).toBe(true);
    }
  });

  it('기본 경로 안내: ko 는 종전 문장, en 은 영어', () => {
    expect(defaultReplyNotices('ko').slow).toBe('말씀 잘 받았어요! 확인하고 바로 답 드릴게요 🙌');
    expect(defaultReplyNotices('ko').holdingMessage).toBe(HOLDING_MESSAGE);
    expect(defaultReplyNotices('en').holdingMessage).toBe(HOLDING_MESSAGE_EN);
    expect(defaultReplyNotices('en').holding).toBe(`Got it! ${HOLDING_MESSAGE_EN}`);
    expect(/[가-힣]/.test(Object.values(defaultReplyNotices('en')).join(''))).toBe(false);
  });

  it('상담원 연결 안내(escalationNotice)가 언어별로 나온다', () => {
    const en = escalationNotice({ locale: 'en', quote: 'Refund?', hasEmail: true, statusText: 'Usually replies in a few minutes' });
    expect(en).toBe(`"Refund?" was passed to a person. Usually replies in a few minutes. We'll let you know here and by email when they reply 🙏`);
    const ko = escalationNotice({ locale: 'ko', quote: '환불?', hasEmail: false, statusText: '보통 몇 분 안에 답해요' });
    expect(ko).toBe('"환불?" 를 상담원에게 전달했어요. 보통 몇 분 안에 답해요. 답이 오면 여기로 알려드려요 🙏');
  });

  it('되돌림 본문: 제목에 한글이 있으면 ko, 없으면 en, 인자로 고정할 수 있다', () => {
    expect(buildLoopClosedBody('쿠폰 버그', 12)).toContain('말씀해주신 문제를 고쳤어요');
    expect(buildLoopClosedBody('Coupon bug', 12)).toBe('"Coupon bug" The problem you reported is fixed. It may take a little while to reach the service. (fix #12)');
    expect(buildLoopClosedBody('Coupon bug', null, 'https://github.com/o/r/pull/1', 'ko')).toContain('말씀해주신 문제를');
  });

  it('칩 문장 판정은 한국어·영어 칩을 모두 «칩만 누른 턴»으로 본다', () => {
    expect(CHIP_ONLY_LABELS).toEqual(['불편한 점이 있어요', 'I have a problem', '기능 제안이 있어요', 'I have a suggestion']);
    expect(isChipOnlyText('I have a problem')).toBe(true);
    expect(isChipOnlyText('I have a problem with checkout')).toBe(false);
  });
});

describe('public/widget.js — 문구 표', () => {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
  const keys = (lang: 'en' | 'ko') => {
    const block = src.slice(src.indexOf(`    ${lang}: {`), src.indexOf(lang === 'en' ? '    ko: {' : '  function T('));
    return [...block.matchAll(/\b([a-zA-Z0-9]+): (?:'|function)/g)].map((m) => m[1]).sort();
  };

  it('en·ko 표의 키가 같다', () => {
    expect(keys('en').length).toBeGreaterThan(40);
    expect(keys('en')).toEqual(keys('ko'));
  });

  it('언어 고르는 순서: data-locale → navigator.language(ko 로 시작) → en', () => {
    expect(src).toContain("script.getAttribute('data-locale')");
    expect(src).toContain("if (forced === 'en' || forced === 'ko') return forced;");
    expect(src).toContain("/^ko/i.test(navigator.language || '') ? 'ko' : 'en'");
  });

  it('모든 서버 요청에 locale 을 싣는다', () => {
    for (const path of ['/config', '/escalate', '/contact', '/confirm', '/messages']) {
      expect(src).toContain(`apiBase + '${path}?`);
    }
    expect(src).toContain("'&visitorId='");
  });

  it('en 표에는 한글이 없다', () => {
    const en = src.slice(src.indexOf('    en: {'), src.indexOf('    ko: {'));
    expect(/[가-힣]/.test(en)).toBe(false);
  });
});

describe('public/widget.js 실행 — 언어 고르기', () => {
  function pick(lang: string, attr: string | null) {
    const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
    const m = src.match(/var LOCALE = \(function \(\) \{[\s\S]*?\n  \}\)\(\);/);
    expect(m).not.toBeNull();
    const script = { getAttribute: (k: string) => (k === 'data-locale' ? attr : null) };
    return new Function('script', 'navigator', `${m![0]}; return LOCALE;`)(script, { language: lang }) as string;
  }

  it.each([
    ['ko-KR', null, 'ko'],
    ['ko', null, 'ko'],
    ['en-US', null, 'en'],
    ['ja-JP', null, 'en'],
    ['', null, 'en'],
    ['en-US', 'ko', 'ko'],
    ['ko-KR', 'en', 'en'],
    ['ko-KR', 'EN', 'en'],
    ['ko-KR', 'fr', 'ko'],
  ])('navigator=%s data-locale=%s → %s', (lang, attr, want) => {
    expect(pick(lang, attr)).toBe(want);
  });
});

describe('widget 오류 응답 — { error: 코드, message: 방문자 언어 문구 }', () => {
  it('?locale 로 message 의 언어가 갈리고 error 는 항상 같은 코드', async () => {
    const { widgetError } = await import('@/lib/widget/http');
    const en = await widgetError(new Request('http://x/api/widget/b/messages?locale=en'), 'message_too_long', 400, { max: 2000 }).json();
    const ko = await widgetError(new Request('http://x/api/widget/b/messages?locale=ko'), 'message_too_long', 400, { max: 2000 }).json();
    expect(en).toEqual({ error: 'message_too_long', message: 'Messages can be up to 2000 characters' });
    expect(ko).toEqual({ error: 'message_too_long', message: '메시지는 2000자까지 보낼 수 있어요' });
  });

  it('?locale 이 없으면 Accept-Language 로', async () => {
    const { widgetError } = await import('@/lib/widget/http');
    const res = widgetError(new Request('http://x/y', { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } }), 'bot_not_found', 404);
    expect((await res.json()).message).toBe('봇을 찾을 수 없습니다');
  });

  it('widget.js: 코드가 자기 표(e_<코드>)에 있으면 그것을, 없으면 서버 message 를 보이고, data-locale 은 앞 두 글자만 본다', () => {
    const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
    expect(src).toContain("STR[LOCALE]['e_' + d.error] || d.message");
    expect(src).not.toContain('res.data.error');
    expect(src).toContain(".toLowerCase().slice(0, 2)");
    expect(src.match(/e_rate_limited:/g)).toHaveLength(2);
  });
});

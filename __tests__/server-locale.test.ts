import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explicitWidgetLocale, localeFromAcceptLanguage, localeFromHeaders, localeFromRequest } from '../src/i18n/server-locale';
import { apiText, apiValidation } from '../src/lib/http/api-text';
import { validateAppearanceInput } from '../src/lib/bot/appearance';
import { loadMessages } from './helpers/intl';

const req = (url: string, headers: Record<string, string> = {}) => new Request(`https://x.test${url}`, { headers });

describe('localeFromRequest — widget (쿼리 → Accept-Language → en)', () => {
  it('쿼리 ?locale 이 우선', () => {
    expect(localeFromRequest(req('/api/widget/b/config?locale=ko', { 'accept-language': 'en-US' }), 'widget')).toBe('ko');
    expect(localeFromRequest(req('/api/widget/b/config?locale=en', { 'accept-language': 'ko-KR' }), 'widget')).toBe('en');
  });
  it('쿼리가 없으면(브라우저 캐시의 옛 widget.js) Accept-Language 로 판단', () => {
    expect(localeFromRequest(req('/x', { 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' }), 'widget')).toBe('ko');
    expect(localeFromRequest(req('/x', { 'accept-language': 'en-US,en;q=0.9,ko;q=0.8' }), 'widget')).toBe('en');
  });
  it('쿠키는 보지 않는다(남의 사이트에서 도는 위젯)', () => {
    expect(localeFromRequest(req('/x', { cookie: 'NEXT_LOCALE=ko' }), 'widget')).toBe('en');
  });
  it('엉뚱한 쿼리값·아무것도 없음 → en', () => {
    expect(localeFromRequest(req('/x?locale=fr'), 'widget')).toBe('en');
    expect(localeFromRequest(req('/x'), 'widget')).toBe('en');
  });
});

describe('localeFromRequest — operator (쿠키 → Accept-Language → en)', () => {
  it('쿠키 NEXT_LOCALE 이 우선', () => {
    expect(localeFromRequest(req('/x', { cookie: 'a=1; NEXT_LOCALE=ko; b=2', 'accept-language': 'en' }))).toBe('ko');
    expect(localeFromRequest(req('/x', { cookie: 'NEXT_LOCALE=en', 'accept-language': 'ko' }))).toBe('en');
  });
  it('쿠키가 없거나 엉뚱하면 Accept-Language, 그것도 없으면 en', () => {
    expect(localeFromRequest(req('/x', { 'accept-language': 'ko' }))).toBe('ko');
    expect(localeFromRequest(req('/x', { cookie: 'NEXT_LOCALE=fr' }))).toBe('en');
    expect(localeFromRequest(req('/x'))).toBe('en');
  });
  it('쿼리는 보지 않는다', () => {
    expect(localeFromRequest(req('/x?locale=ko'))).toBe('en');
  });
  it('요청이 없으면 en', () => {
    expect(localeFromRequest(undefined)).toBe('en');
  });
  it('헤더만으로도 같은 순서', () => {
    expect(localeFromHeaders(new Headers({ cookie: 'NEXT_LOCALE=ko' }))).toBe('ko');
    expect(localeFromHeaders(new Headers({ 'accept-language': 'ko-KR' }))).toBe('ko');
  });
});

describe('지역이 붙은 언어값·깨진 쿠키', () => {
  it('?locale=en-US·ko_KR 은 앞 언어 코드로 받는다', () => {
    expect(localeFromRequest(req('/x?locale=en-US', { 'accept-language': 'ko' }), 'widget')).toBe('en');
    expect(localeFromRequest(req('/x?locale=ko-KR', { 'accept-language': 'en' }), 'widget')).toBe('ko');
    expect(localeFromRequest(req('/x?locale=KO_kr'), 'widget')).toBe('ko');
    expect(localeFromRequest(req('/x?locale=english'), 'widget')).toBe('en'); // 알 수 없는 값은 Accept-Language 없음 → en
    expect(localeFromRequest(req('/x?locale=ennui', { 'accept-language': 'ko' }), 'widget')).toBe('ko'); // en 으로 시작해도 en 이 아니다
  });
  it('깨진 퍼센트 인코딩 쿠키는 던지지 않고 없는 것으로 본다(운영자 API 가 500 이 되면 안 된다)', () => {
    expect(() => localeFromRequest(req('/x', { cookie: 'NEXT_LOCALE=%E0%A4%A' }))).not.toThrow();
    expect(localeFromRequest(req('/x', { cookie: 'NEXT_LOCALE=%E0%A4%A', 'accept-language': 'ko' }))).toBe('ko');
    expect(() => localeFromHeaders(new Headers({ cookie: 'NEXT_LOCALE=%' }))).not.toThrow();
  });
});

describe('explicitWidgetLocale — 저장해도 되는 언어', () => {
  it('?locale 을 직접 보냈을 때만 값이 있고, Accept-Language 짐작은 undefined', () => {
    expect(explicitWidgetLocale(req('/x?locale=ko'))).toBe('ko');
    expect(explicitWidgetLocale(req('/x?locale=en-US'))).toBe('en');
    expect(explicitWidgetLocale(req('/x', { 'accept-language': 'ko-KR' }))).toBeUndefined();
    expect(explicitWidgetLocale(req('/x?locale=fr'))).toBeUndefined();
  });
});

describe('Accept-Language', () => {
  it('첫 항목이 ko 로 시작하면 ko', () => {
    expect(localeFromAcceptLanguage('ko')).toBe('ko');
    expect(localeFromAcceptLanguage('KO-kr')).toBe('ko');
    expect(localeFromAcceptLanguage('ja,ko;q=0.5')).toBe('en');
    expect(localeFromAcceptLanguage(null)).toBe('en');
  });
});

describe('apiText / apiValidation', () => {
  it('요청 언어로 errors.api 를 읽는다', () => {
    expect(apiText(req('/x'), 'botNotFound')).toBe('Bot not found');
    expect(apiText(req('/x', { cookie: 'NEXT_LOCALE=ko' }), 'botNotFound')).toBe('봇을 찾을 수 없습니다');
    expect(apiText(req('/x'), 'replyTooLong', { max: 5000 })).toContain('5000');
  });
  it('검증 결과: code 가 있으면 사전, 입력칸 이름은 errors.fields, 없으면 error 그대로', () => {
    const r = { error: '액세스 키 은(는) 문자열이어야 합니다', code: 'notString', vars: { field: 'accessKey' } };
    expect(apiValidation(req('/x'), r)).toBe('Access key must be text');
    expect(apiValidation(req('/x', { cookie: 'NEXT_LOCALE=ko' }), r)).toBe('액세스 키 은(는) 문자열이어야 합니다');
    expect(apiValidation(req('/x'), { error: '한국어만' })).toBe('한국어만');
    expect(apiValidation(req('/x'), { error: 'x', code: 'key.empty' })).toBe('Enter your API key');
  });
  it('점이 든 코드(knowledge.textNotString · closeReason.noteTooLong)도 사전으로 읽힌다 — 한국어 error 로 떨어지면 안 된다', () => {
    for (const code of ['knowledge.textNotString', 'knowledge.faqTooMany', 'closeReason.required', 'closeReason.invalid', 'closeReason.noteTooLong']) {
      const en = apiValidation(req('/x'), { error: '한국어 폴백', code, vars: { max: 500, count: 3, allowed: 'a, b' } });
      expect(en, code).not.toMatch(/[가-힣]/);
      expect(apiValidation(req('/x', { cookie: 'NEXT_LOCALE=ko' }), { error: '한국어 폴백', code, vars: { max: 500, count: 3, allowed: 'a, b' } }), code).toMatch(/[가-힣]/);
    }
  });
  it('위젯 모양 검증 오류는 영어 요청에 한국어가 섞이지 않는다(입력칸 이름까지)', () => {
    const bad: unknown[] = [
      [],
      { display_name: 1 },
      { greeting: 'x'.repeat(301) },
      { accent_color: 'red' },
      { visitor_bubble_color: 'rgb(1,2,3)' },
      { profile_image_url: 'http://x.test/a.png' },
      { starter_faq_fallback: 'false' },
      { starter_questions: 'x' },
      {},
    ];
    for (const body of bad) {
      const r = validateAppearanceInput(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (r.ok) continue;
      const en = apiValidation(req('/x'), r);
      expect(en, JSON.stringify(body)).not.toMatch(/[가-힣]/);
      expect(apiValidation(req('/x', { cookie: 'NEXT_LOCALE=ko' }), r), JSON.stringify(body)).toBe(r.error);
    }
    const color = validateAppearanceInput({ accent_color: 'red' });
    expect(color.ok).toBe(false);
    if (!color.ok) expect(apiValidation(req('/x'), color)).toBe('Accent color must be a color code in #RRGGBB format');
    const long = validateAppearanceInput({ display_name: 'x'.repeat(41) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(apiValidation(req('/x'), long)).toBe('Display name can be up to 40 characters');
  });
});

describe('MergeError 코드', () => {
  it('각 코드가 errors.api 의 merge_<code> 로 번역된다', () => {
    for (const code of ['unconfirmed', 'blocked', 'conflict', 'not_found', 'forbidden', 'failed']) {
      const req = new Request('http://x/y');
      expect(apiText(req, `merge_${code}`, { detail: 'boom' })).not.toMatch(/^merge_/);
      expect(apiText(new Request('http://x/y', { headers: { cookie: 'NEXT_LOCALE=ko' } }), `merge_${code}`, { detail: 'boom' })).toMatch(/[가-힣]/);
    }
    expect(apiText(new Request('http://x/y'), 'merge_failed', { detail: 'boom' })).toBe('The GitHub merge failed: boom');
  });
});

describe('코드에서 쓰는 키가 사전에 있다', () => {
  const en = loadMessages('en') as { errors: { api: Record<string, string>; widget: Record<string, string> } };
  const ko = loadMessages('ko') as typeof en;
  const files: string[] = [];
  (function walk(dir: string) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f.name)) files.push(p);
    }
  })(path.resolve(__dirname, '../src'));

  it("apiText(req, 'key') 의 key 가 errors.api 에 있다", () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/apiText(?:InContext)?\((?:[a-zA-Z_]+, )?'([A-Za-z_]+)'/g)) {
        if (!(m[1] in en.errors.api) || !(m[1] in ko.errors.api)) missing.push(`${path.basename(f)}:${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

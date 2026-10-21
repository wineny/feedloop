import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeFromAcceptLanguage, localeFromHeaders, localeFromRequest } from '../src/i18n/server-locale';
import { apiText, apiValidation } from '../src/lib/http/api-text';
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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACCENT_ON_WHITE_MAX_LUMINANCE,
  ACCENT_TINT_BORDER_RATIO,
  ACCENT_TINT_RATIO,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_VISITOR_BUBBLE_COLOR,
  LIGHT_BACKGROUND_LUMINANCE,
  MAX_STARTER_QUESTIONS,
  MAX_STARTER_QUESTION_CHARS,
  STARTER_FAQ_FALLBACK_COUNT,
  accentTint,
  mixColors,
  mixWithWhite,
  normalizeHexColor,
  readableAccent,
  readableTextOn,
  readFaqFallback,
  relativeLuminance,
  resolveStarterQuestions,
  validateAppearanceInput,
  validateStarterQuestions,
} from '@/lib/bot/appearance';

// 이 값들이 방문자 사이트에 그대로 뜬다. PATCH 는 무인증이 아니지만,
// 운영자가 실수로 넣은 값도 위젯을 망가뜨리면 안 된다.

describe('validateAppearanceInput', () => {
  it('정상 문자열은 trim 해서 통과시킨다', () => {
    const result = validateAppearanceInput({
      display_name: '  널널투어  ',
      status_text: '보통 하루 안에 답해요',
    });

    expect(result).toEqual({
      ok: true,
      values: { display_name: '널널투어', status_text: '보통 하루 안에 답해요' },
    });
  });

  it('빈 문자열과 공백만 있는 값은 null 로 바꾼다 (= 폴백을 쓰겠다는 뜻)', () => {
    const result = validateAppearanceInput({
      display_name: '',
      greeting: '   ',
      profile_image_url: null,
    });

    expect(result).toEqual({
      ok: true,
      values: { display_name: null, greeting: null, profile_image_url: null },
    });
  });

  it('상한을 넘으면 어느 항목인지 알려주며 거절한다', () => {
    const result = validateAppearanceInput({ display_name: 'ㄱ'.repeat(41) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('표시 이름');
  });

  it('상한과 정확히 같은 길이는 통과한다', () => {
    const exact = 'ㄱ'.repeat(40);
    const result = validateAppearanceInput({ display_name: exact });

    expect(result).toEqual({ ok: true, values: { display_name: exact } });
  });

  it('greeting 은 300자, status_text 는 60자가 상한이다', () => {
    expect(validateAppearanceInput({ greeting: 'a'.repeat(301) }).ok).toBe(false);
    expect(validateAppearanceInput({ greeting: 'a'.repeat(300) }).ok).toBe(true);
    expect(validateAppearanceInput({ status_text: 'a'.repeat(61) }).ok).toBe(false);
    expect(validateAppearanceInput({ status_text: 'a'.repeat(60) }).ok).toBe(true);
  });

  it('http 프로필 이미지는 거절한다 — https 사이트에서 혼합 콘텐츠로 차단된다', () => {
    const result = validateAppearanceInput({ profile_image_url: 'http://example.com/logo.png' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('https://');
  });

  it('URL 이 아닌 문자열도 거절한다', () => {
    expect(validateAppearanceInput({ profile_image_url: 'logo.png' }).ok).toBe(false);
    expect(validateAppearanceInput({ profile_image_url: 'javascript:alert(1)' }).ok).toBe(false);
  });

  it('https 주소는 통과한다', () => {
    const url = 'https://example.com/logo.png';
    const result = validateAppearanceInput({ profile_image_url: url });

    expect(result).toEqual({ ok: true, values: { profile_image_url: url } });
  });

  it('알 수 없는 필드는 조용히 버린다', () => {
    const result = validateAppearanceInput({
      display_name: '널널투어',
      user_id: 'someone-else',
      status: 'paused',
    });

    expect(result).toEqual({ ok: true, values: { display_name: '널널투어' } });
  });

  it('문자열이 아닌 값은 거절한다', () => {
    expect(validateAppearanceInput({ display_name: 42 }).ok).toBe(false);
    expect(validateAppearanceInput({ greeting: { text: '안녕' } }).ok).toBe(false);
    expect(validateAppearanceInput({ status_text: true }).ok).toBe(false);
  });

  it('아는 필드가 하나도 없으면 거절한다 — 빈 update 를 DB 로 보내지 않는다', () => {
    const result = validateAppearanceInput({ nope: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('변경할 항목이 없습니다');
  });

  it('객체가 아닌 body 는 거절한다', () => {
    expect(validateAppearanceInput(null).ok).toBe(false);
    expect(validateAppearanceInput('display_name=x').ok).toBe(false);
    expect(validateAppearanceInput([{ display_name: 'x' }]).ok).toBe(false);
  });
});

// ── 색상 ────────────────────────────────────────────
//
// 이 값은 방문자 사이트에서 CSS 변수로 해석된다. 자유 문자열이 통과하면
// 위젯 스타일을 비틀 수 있으므로 #RRGGBB 만 받는다.

describe('validateAppearanceInput — 색상', () => {
  it('#RRGGBB 는 소문자로 정규화해 통과한다', () => {
    expect(validateAppearanceInput({ accent_color: '#0A7CFF' })).toEqual({
      ok: true,
      values: { accent_color: '#0a7cff' },
    });
    expect(validateAppearanceInput({ visitor_bubble_color: '  #ABCDEF  ' })).toEqual({
      ok: true,
      values: { visitor_bubble_color: '#abcdef' },
    });
  });

  it('#RGB 는 6자리로 펼친다', () => {
    expect(validateAppearanceInput({ accent_color: '#F00' })).toEqual({
      ok: true,
      values: { accent_color: '#ff0000' },
    });
    expect(validateAppearanceInput({ visitor_bubble_color: '#abc' })).toEqual({
      ok: true,
      values: { visitor_bubble_color: '#aabbcc' },
    });
  });

  it('빈 값은 null — 기본색(코랄·잉크)을 쓰겠다는 뜻', () => {
    expect(validateAppearanceInput({ accent_color: '', visitor_bubble_color: '   ' })).toEqual({
      ok: true,
      values: { accent_color: null, visitor_bubble_color: null },
    });
    expect(validateAppearanceInput({ accent_color: null })).toEqual({
      ok: true,
      values: { accent_color: null },
    });
  });

  it('hex 가 아닌 색 표기는 전부 거절한다', () => {
    for (const bad of [
      'red',
      '#ggg',
      '#12345',
      '#1234567',
      'rgb(242,100,92)',
      'var(--brand)',
      '#f2645c;background:url(x)',
      'F2645C',
      'hsl(4 84% 65%)',
    ]) {
      const result = validateAppearanceInput({ accent_color: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error).toContain('강조색');
    }
  });

  it('긴 색 표기도 길이가 아니라 형식을 지적한다 — 자릿수를 고치게 만들지 않는다', () => {
    // 형식 검사가 길이 검사보다 뒤에 있으면 여기서 「7자까지」가 나온다.
    // 붙여넣은 사람은 표기법이 문제인데 길이를 줄이려 든다.
    for (const bad of ['rgb(242,100,92)', 'hsl(4 84% 65%)', 'rgba(0,0,0,.5)']) {
      const result = validateAppearanceInput({ accent_color: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) {
        expect(result.error, bad).toContain('#RRGGBB');
        expect(result.error, bad).not.toContain('7자');
      }
    }
  });

  it('말풍선색도 같은 메시지를 준다', () => {
    const result = validateAppearanceInput({ visitor_bubble_color: 'rgb(0,0,0)' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('내 말풍선색');
      expect(result.error).toContain('#RRGGBB');
    }
  });

  it('문자열이 아닌 값은 거절한다', () => {
    expect(validateAppearanceInput({ accent_color: 0xf2645c }).ok).toBe(false);
    expect(validateAppearanceInput({ visitor_bubble_color: ['#fff'] }).ok).toBe(false);
  });
});

describe('normalizeHexColor', () => {
  it('통과한 값은 항상 소문자 7자다', () => {
    expect(normalizeHexColor('#FFF')).toBe('#ffffff');
    expect(normalizeHexColor('#000000')).toBe('#000000');
    expect(normalizeHexColor(' #F2645C ')).toBe('#f2645c');
  });

  it('형식이 아니면 null', () => {
    expect(normalizeHexColor('')).toBeNull();
    expect(normalizeHexColor('#')).toBeNull();
    expect(normalizeHexColor('#12')).toBeNull();
    expect(normalizeHexColor('#1234')).toBeNull();
    expect(normalizeHexColor('white')).toBeNull();
  });

  it('기본색 상수는 스스로 정규화된 형태다 — 위젯 CSS 폴백과 문자열로 비교된다', () => {
    expect(normalizeHexColor(DEFAULT_ACCENT_COLOR)).toBe(DEFAULT_ACCENT_COLOR);
    expect(normalizeHexColor(DEFAULT_VISITOR_BUBBLE_COLOR)).toBe(DEFAULT_VISITOR_BUBBLE_COLOR);
  });
});

describe('mixWithWhite', () => {
  it('ratio 1 은 원색, 0 은 흰색', () => {
    expect(mixWithWhite('#f2645c', 1)).toBe('#f2645c');
    expect(mixWithWhite('#f2645c', 0)).toBe('#ffffff');
  });

  it('12% 틴트는 기존 코랄 틴트(#FDF1F0) 근처에 떨어진다 — 위젯 폴백과 눈에 안 띄게 다르다', () => {
    // 자리수가 항상 2개여야 한다 — padStart 를 빼먹으면 6자리가 깨진다
    const tint = mixWithWhite('#f2645c', 0.12);
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(tint).toBe('#fdeceb');
  });

  it('잘못된 hex 는 흰색으로 떨어진다 — 입력 중에도 미리보기가 안 깨진다', () => {
    expect(mixWithWhite('nope', 0.5)).toBe('#ffffff');
  });
});

describe('readableTextOn', () => {
  it('어두운 색 위에는 흰 글씨', () => {
    expect(readableTextOn('#191d1b')).toBe('#ffffff');
    expect(readableTextOn('#0a7cff')).toBe('#ffffff');
    expect(readableTextOn(DEFAULT_VISITOR_BUBBLE_COLOR)).toBe('#ffffff');
  });

  it('밝은 색 위에는 잉크 — 흰 글씨가 안 읽히는 걸 막는다', () => {
    expect(readableTextOn('#ffffff')).toBe('#191d1b');
    expect(readableTextOn('#ffe066')).toBe('#191d1b');
    expect(readableTextOn('#a8e6cf')).toBe('#191d1b');
  });

  it('잘못된 hex 는 흰색', () => {
    expect(readableTextOn('#zz')).toBe('#ffffff');
  });
});

describe('readableAccent — 흰 바탕 위의 글자·선', () => {
  const CONTRAST_FLOOR = 3;
  const contrastOnWhite = (hex: string) => 1.05 / (relativeLuminance(hex)! + 0.05);

  it('이미 충분히 어두운 강조색은 그대로 돌려준다 — 기존 봇의 픽셀이 안 바뀐다', () => {
    expect(readableAccent(DEFAULT_ACCENT_COLOR)).toBe(DEFAULT_ACCENT_COLOR);
    expect(readableAccent('#0a7cff')).toBe('#0a7cff');
    expect(readableAccent('#191d1b')).toBe('#191d1b');
  });

  it('밝은 색은 흰 바탕 대비 3:1 아래로 내린다', () => {
    for (const light of ['#ffffff', '#ffe066', '#a8e6cf', '#fff59d', '#e0f7fa']) {
      const strong = readableAccent(light);
      expect(contrastOnWhite(strong), light).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
      // 원색보다 어두워졌을 뿐, 잉크로 뭉개지지는 않는다
      expect(strong, light).not.toBe(light);
    }
  });

  it('어떤 hex 를 넣어도 결과는 3:1 을 만족한다', () => {
    for (let r = 0; r < 256; r += 51) {
      for (let g = 0; g < 256; g += 51) {
        for (let b = 0; b < 256; b += 51) {
          const hex = mixColors(
            `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
            '#ffffff',
            1,
          );
          expect(contrastOnWhite(readableAccent(hex)), hex).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
        }
      }
    }
  });

  it('상한은 코랄의 명도를 통과시키는 값이다 — 배포된 화면과 같은 바', () => {
    expect(relativeLuminance(DEFAULT_ACCENT_COLOR)!).toBeLessThanOrEqual(
      ACCENT_ON_WHITE_MAX_LUMINANCE,
    );
    // 말풍선 글자색 임계값과 «다른» 값이어야 한다. 같게 두면 명도 0.5 짜리
    // 강조색이 링크로 쓰이면서 대비 1.9:1 이 된다
    expect(ACCENT_ON_WHITE_MAX_LUMINANCE).toBeLessThan(LIGHT_BACKGROUND_LUMINANCE);
  });

  it('hex 가 아니면 기본 코랄로 떨어진다', () => {
    expect(readableAccent('nope')).toBe(DEFAULT_ACCENT_COLOR);
  });
});

describe('accentTint — 되돌림 카드', () => {
  it('어두운 강조색에서는 기존 코랄 틴트를 그대로 낸다', () => {
    expect(accentTint(DEFAULT_ACCENT_COLOR, ACCENT_TINT_RATIO)).toBe('#fdeceb');
    expect(accentTint(DEFAULT_ACCENT_COLOR, ACCENT_TINT_BORDER_RATIO)).toBe('#fce0de');
  });

  it('아주 밝은 강조색에서도 카드 배경·테두리가 흰색과 구별된다', () => {
    // 예전 계산(원색을 흰색과 12% 섞기)은 #ffffff 강조색에서 둘 다 #ffffff 가 돼
    // 카드가 통째로 사라졌다. 그 회귀를 잡는 테스트다.
    for (const light of ['#ffffff', '#ffe066', '#a8e6cf']) {
      const bg = accentTint(light, ACCENT_TINT_RATIO);
      const border = accentTint(light, ACCENT_TINT_BORDER_RATIO);

      expect(bg, light).not.toBe('#ffffff');
      expect(border, light).not.toBe('#ffffff');
      // 테두리는 배경보다 진해야 보인다
      expect(relativeLuminance(border)!, light).toBeLessThan(relativeLuminance(bg)!);
    }
  });

  it('#ffffff 강조색에서 옛 계산은 흰색이었다 — 대조', () => {
    expect(mixWithWhite('#ffffff', ACCENT_TINT_RATIO)).toBe('#ffffff');
    expect(accentTint('#ffffff', ACCENT_TINT_RATIO)).not.toBe('#ffffff');
  });
});

describe('validateStarterQuestions', () => {
  it('문장을 다듬어 순서대로 받는다', () => {
    expect(validateStarterQuestions(['  쿠폰은 하루 몇 장까지 받나요? ', '혼잡도가 실시간인가요?'])).toEqual({
      ok: true,
      value: ['쿠폰은 하루 몇 장까지 받나요?', '혼잡도가 실시간인가요?'],
    });
  });

  it('개행·연속 공백을 한 칸으로 접는다 — 칩은 한 줄짜리다', () => {
    const result = validateStarterQuestions(['쿠폰은\n하루   몇 장?']);
    expect(result).toEqual({ ok: true, value: ['쿠폰은 하루 몇 장?'] });
  });

  it('빈 줄과 중복은 조용히 버린다', () => {
    expect(validateStarterQuestions(['가', '', '   ', '가', '나'])).toEqual({
      ok: true,
      value: ['가', '나'],
    });
  });

  it('없음·null 은 빈 목록 — FAQ 폴백을 쓰겠다는 뜻이다', () => {
    expect(validateStarterQuestions(null)).toEqual({ ok: true, value: [] });
    expect(validateStarterQuestions(undefined)).toEqual({ ok: true, value: [] });
    expect(validateStarterQuestions([])).toEqual({ ok: true, value: [] });
  });

  it('목록이 아니거나 문자열이 아닌 항목은 거절한다', () => {
    expect(validateStarterQuestions('쿠폰은 하루 몇 장?').ok).toBe(false);
    expect(validateStarterQuestions({ 0: '가' }).ok).toBe(false);
    expect(validateStarterQuestions(['가', 42]).ok).toBe(false);
    expect(validateStarterQuestions(['가', { q: '나' }]).ok).toBe(false);
  });

  it('길이·개수 상한을 넘으면 어느 규칙인지 알려주며 거절한다', () => {
    const long = validateStarterQuestions(['ㄱ'.repeat(MAX_STARTER_QUESTION_CHARS + 1)]);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toContain(String(MAX_STARTER_QUESTION_CHARS));

    expect(validateStarterQuestions(['ㄱ'.repeat(MAX_STARTER_QUESTION_CHARS)]).ok).toBe(true);

    const many = validateStarterQuestions(
      Array.from({ length: MAX_STARTER_QUESTIONS + 1 }, (_, i) => `질문 ${i}`),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain(String(MAX_STARTER_QUESTIONS));
  });

  it('위젯 모양 PATCH 가 같은 규칙을 쓴다', () => {
    expect(validateAppearanceInput({ starter_questions: [' 가 ', '가', '나'] })).toEqual({
      ok: true,
      values: { starter_questions: ['가', '나'] },
    });
    expect(validateAppearanceInput({ starter_questions: ['ㄱ'.repeat(41)] }).ok).toBe(false);
    // 빈 목록만 보내는 것도 「비우겠다」는 변경이다 — "변경할 항목이 없습니다" 로 막히면 안 된다
    expect(validateAppearanceInput({ starter_questions: [] })).toEqual({
      ok: true,
      values: { starter_questions: [] },
    });
  });
});

describe('resolveStarterQuestions', () => {
  const faq = [
    { q: '널널투어가 뭔가요?', a: '관광지 혼잡도를 미리 보고 쿠폰을 받는 서비스예요.' },
    { q: '앱이 있나요?', a: '웹으로 씁니다.' },
    { q: '로그인해야 쓸 수 있나요?', a: '아니요.' },
    { q: '쿠폰은 언제 쓸 수 있나요?', a: '받은 날짜에요.' },
  ];

  it('운영자가 정했으면 그게 이긴다', () => {
    expect(resolveStarterQuestions(['쿠폰은 하루 몇 장?'], faq, true)).toEqual([
      '쿠폰은 하루 몇 장?',
    ]);
  });

  it('비어 있으면 FAQ 앞쪽 질문으로 채운다', () => {
    expect(resolveStarterQuestions([], faq, true)).toEqual([
      '널널투어가 뭔가요?',
      '앱이 있나요?',
      '로그인해야 쓸 수 있나요?',
    ]);
    expect(resolveStarterQuestions(null, faq, true)).toHaveLength(STARTER_FAQ_FALLBACK_COUNT);
  });

  it('답변은 절대 내보내지 않는다 — 이 값은 무인증 config 로 나간다', () => {
    const out = resolveStarterQuestions([], faq, true).join(' ');
    for (const entry of faq) {
      expect(out).not.toContain(entry.a);
    }
  });

  it('긴 FAQ 질문은 자르지 않고 건너뛴다 — 뜻이 잘린 칩을 만들지 않는다', () => {
    const long = 'ㄱ'.repeat(MAX_STARTER_QUESTION_CHARS + 1);
    expect(
      resolveStarterQuestions([], [{ q: long, a: '답' }, { q: '짧은 질문?', a: '답' }], true),
    ).toEqual(['짧은 질문?']);
  });

  it('FAQ 가 없거나 모양이 다르면 빈 목록 — 칩 줄 자체가 안 뜬다', () => {
    expect(resolveStarterQuestions([], null, true)).toEqual([]);
    expect(resolveStarterQuestions([], 'FAQ', true)).toEqual([]);
    expect(resolveStarterQuestions([], [{ question: '가', answer: '나' }, null, 7], true)).toEqual(
      [],
    );
  });

  it('운영자 값이 상한을 넘어도 위젯에는 상한까지만 나간다', () => {
    const many = Array.from({ length: MAX_STARTER_QUESTIONS + 3 }, (_, i) => `질문 ${i}`);
    expect(resolveStarterQuestions(many, faq, true)).toHaveLength(MAX_STARTER_QUESTIONS);
  });

  // ── 자동 채우기 끄기 (20260911_02) ──
  //
  // 끄는 스위치가 없으면 운영자가 동의한 적 없는 FAQ 질문이 공개 첫 화면에 뜬다.

  it('자동 채우기를 끄면 FAQ 가 있어도 아무것도 안 띄운다', () => {
    expect(resolveStarterQuestions([], faq, false)).toEqual([]);
    expect(resolveStarterQuestions(null, faq, false)).toEqual([]);
  });

  it('직접 쓴 시작 질문은 자동 채우기와 무관하게 뜬다 — 띄우겠다는 의사가 명시적이다', () => {
    expect(resolveStarterQuestions(['쿠폰은 하루 몇 장?'], faq, false)).toEqual([
      '쿠폰은 하루 몇 장?',
    ]);
  });

  it('쓸 만한 운영자 질문이 하나도 없으면 꺼진 상태에서 FAQ 로 새지 않는다', () => {
    // 40자 초과라 전부 버려지는 경우 — 켜져 있으면 FAQ 로 떨어지지만 꺼져 있으면 빈 목록
    const tooLong = ['ㄱ'.repeat(MAX_STARTER_QUESTION_CHARS + 1)];
    expect(resolveStarterQuestions(tooLong, faq, true)).toHaveLength(STARTER_FAQ_FALLBACK_COUNT);
    expect(resolveStarterQuestions(tooLong, faq, false)).toEqual([]);
  });
});

describe('readFaqFallback', () => {
  it('false 일 때만 꺼진 것으로 본다. null 은 기본값(켜짐)', () => {
    expect(readFaqFallback(false)).toBe(false);
    expect(readFaqFallback(true)).toBe(true);
    // 컬럼이 NOT NULL 이라 null 은 스키마상 오지 않지만, 제약이 바뀌는 날을 위해 받는다.
    expect(readFaqFallback(null)).toBe(true);
    // undefined(= select 에서 컬럼이 빠진 경우)는 «타입이» 막는다. 런타임 분기로 두면
    // 운영자가 끈 스위치가 조용히 무시되는데 쿼리도 테스트도 전부 초록이다.
    // @ts-expect-error 인자를 boolean | null 로 좁혀 둔 것이 이 실수의 방어선이다
    expect(() => readFaqFallback(undefined)).not.toThrow();
  });
});

describe('validateAppearanceInput — 자동 채우기', () => {
  it('boolean 만 받는다', () => {
    expect(validateAppearanceInput({ starter_faq_fallback: false })).toEqual({
      ok: true,
      values: { starter_faq_fallback: false },
    });
    expect(validateAppearanceInput({ starter_faq_fallback: true })).toEqual({
      ok: true,
      values: { starter_faq_fallback: true },
    });
  });

  it("문자열 'false' 를 참으로 삼키지 않는다 — 껐는데 계속 뜨는 상태가 최악이다", () => {
    for (const bad of ['false', 'true', 0, 1, null, {}]) {
      expect(validateAppearanceInput({ starter_faq_fallback: bad }).ok).toBe(false);
    }
  });

  it('안 보낸 필드는 값에 담기지 않는다 — 다른 항목만 고칠 때 스위치가 덮이면 안 된다', () => {
    const result = validateAppearanceInput({ display_name: '널널투어' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).not.toHaveProperty('starter_faq_fallback');
      expect(result.values).not.toHaveProperty('starter_questions');
    }
  });
});

// ── 위젯이 config 와 같은 이름을 읽는지 ──────────────
//
// 키 이름이 어긋나면 조용히 칩 줄만 사라진다. 화면을 안 열면 못 잡는 종류의 사고다.

describe('widget.js 의 첫 화면 = config 응답', () => {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

  it('config 가 주는 이름 그대로 읽는다', () => {
    expect(src).toContain('state.cfg.starterQuestions');
    expect(src).toContain('state.cfg.chips');
  });

  it('시작 질문은 입력창을 거치지 않고 바로 전송된다', () => {
    expect(src).toContain("send(text, 'question')");
  });

  it('의견 알약은 입력창을 채우고 힌트를 함께 든다', () => {
    expect(src).toContain('state.draft = c.label');
    expect(src).toContain('state.hint = c.hint');
  });
});

// ── widget.js 와 서버 계산이 같은지 ─────────────────
//
// 위젯은 의존성 0 이라 appearance.ts 를 import 할 수 없고, 색 계산을 손으로
// 두 번 적어야 한다. 둘이 어긋나면 운영자 미리보기와 방문자 화면의 색이 달라진다 —
// 그 순간을 눈으로는 못 잡는다. 그래서 위젯 «소스에서» 함수를 떼어내 실행으로 대조한다.

function loadWidgetColorFns() {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

  // function <name>( … ) { … } 를 중괄호 짝을 세어 잘라낸다
  const grab = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`widget.js 에 ${name} 이 없다`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error(`${name} 의 본문이 안 닫혔다`);
  };

  const body = [
    "var HEX6 = /^#[0-9a-f]{6}$/i;",
    "var INK = '#191d1b';",
    grab('hex'),
    grab('byte'),
    grab('mix'),
    grab('lum'),
    grab('readableOn'),
    grab('strongAccent'),
    'return { hex: hex, mix: mix, lum: lum, readableOn: readableOn, strongAccent: strongAccent };',
  ].join('\n');

  return new Function(body)() as {
    hex: (v: unknown) => string | null;
    mix: (a: string, b: string, ratio: number) => string;
    lum: (c: string) => number;
    readableOn: (c: string) => string;
    strongAccent: (c: string) => string;
  };
}

describe('widget.js 의 색 계산 = appearance.ts', () => {
  const widget = loadWidgetColorFns();
  const samples = [
    '#f2645c',
    '#191d1b',
    '#ffffff',
    '#000000',
    '#0a7cff',
    '#ffe066',
    '#a8e6cf',
    '#2d2f2e',
    '#7f00ff',
    '#fff59d',
    '#123456',
    '#abcdef',
  ];

  it('mix 가 mixColors 와 같다', () => {
    for (const c of samples) {
      for (const ratio of [0, 0.12, 0.2, 0.45, 1]) {
        expect(widget.mix(c, '#ffffff', ratio), `${c} @${ratio}`).toBe(
          mixColors(c, '#ffffff', ratio),
        );
        expect(widget.mix(c, '#191d1b', ratio), `${c} @${ratio}`).toBe(
          mixColors(c, '#191d1b', ratio),
        );
      }
    }
  });

  it('lum 이 relativeLuminance 와 같다', () => {
    for (const c of samples) expect(widget.lum(c), c).toBeCloseTo(relativeLuminance(c)!, 12);
  });

  it('readableOn 이 readableTextOn 과 같다 — 말풍선·강조색 위의 글자', () => {
    for (const c of samples) expect(widget.readableOn(c), c).toBe(readableTextOn(c));
  });

  it('strongAccent 가 readableAccent 와 같다 — 링크·테두리', () => {
    for (const c of samples) expect(widget.strongAccent(c), c).toBe(readableAccent(c));
  });

  it('틴트 두 개가 accentTint 와 같다 — 되돌림 카드 배경·테두리', () => {
    for (const c of samples) {
      const strong = widget.strongAccent(c);
      expect(widget.mix(strong, '#ffffff', 0.12), c).toBe(accentTint(c, ACCENT_TINT_RATIO));
      expect(widget.mix(strong, '#ffffff', 0.2), c).toBe(accentTint(c, ACCENT_TINT_BORDER_RATIO));
    }
  });

  it('위젯이 쓰는 상수가 서버 상수와 같다 — 한쪽만 고치는 사고를 잡는다', () => {
    const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

    expect(src).toContain(`lum(candidate) <= ${ACCENT_ON_WHITE_MAX_LUMINANCE}`);
    expect(src).toContain(`lum(color) > ${LIGHT_BACKGROUND_LUMINANCE}`);
    expect(src).toContain(`'--fl-accent-tint', mix(strong, '#ffffff', ${ACCENT_TINT_RATIO})`);
    expect(src).toContain(`'--fl-accent-tint-2', mix(strong, '#ffffff', ${ACCENT_TINT_BORDER_RATIO})`);
  });

  it('위젯의 hex 가드는 6자리만 통과시킨다', () => {
    expect(widget.hex('#F2645C')).toBe('#F2645C');
    expect(widget.hex(' #f2645c ')).toBe('#f2645c');
    expect(widget.hex('#fff')).toBeNull();
    expect(widget.hex('red')).toBeNull();
    expect(widget.hex('#f2645c;background:url(x)')).toBeNull();
    expect(widget.hex(null)).toBeNull();
    expect(widget.hex(42)).toBeNull();
  });
});

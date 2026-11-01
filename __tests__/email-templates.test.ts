import { describe, it, expect } from 'vitest';
import { htmlEscape, safeHttpsUrl, sanitizeSubjectText, textToHtml } from '@/lib/email/html';
import { formatKst, formatUtcEnglish, renderLoopClosedEmail, renderOperatorReplyEmail } from '@/lib/email/templates';
import { formatFrom } from '@/lib/email/postmark';

describe('html 정제', () => {
  it('사람이 쓴 값의 HTML 특수문자를 전부 이스케이프한다', () => {
    expect(htmlEscape(`<b onclick="x">&'`)).toBe('&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('줄바꿈은 <br> 로, CRLF 도 한 줄바꿈으로 본다', () => {
    expect(textToHtml('a\r\nb\nc')).toBe('a<br />b<br />c');
  });

  it('제목은 이스케이프하지 않고 개행만 접는다 — 엔티티가 받은편지함에 그대로 보이면 안 된다', () => {
    expect(sanitizeSubjectText("O'Brien\r\nBcc: x")).toBe("O'Brien Bcc: x");
  });

  it('https 가 아니면 링크를 만들지 않는다', () => {
    expect(safeHttpsUrl('https://nulnul.vercel.app/coupons')).toBe('https://nulnul.vercel.app/coupons');
    expect(safeHttpsUrl('http://example.com')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('/relative')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});

describe('renderOperatorReplyEmail', () => {
  const base = {
    serviceName: '널널투어',
    recipientName: '누리',
    operatorName: '널널투어 팀',
    replyBody: '확인해 보니 쿠폰 적용 버튼이 iOS 에서만 안 눌렸어요.\n오늘 고쳤습니다.',
    quotedMessage: '쿠폰 적용 버튼이 안 눌려요',
    siteUrl: 'https://nulnul.vercel.app/coupons',
    locale: 'ko' as const,
  };

  it('제목에 서비스 이름, 본문에 답장·원문·이름이 들어간다', () => {
    const r = renderOperatorReplyEmail(base);
    expect(r.subject).toBe('[널널투어] 남기신 피드백에 답장이 왔어요');
    expect(r.html).toContain('누리 님, 남기신 피드백에 답장이 왔어요.');
    expect(r.html).toContain('오늘 고쳤습니다.');
    expect(r.html).toContain('쿠폰 적용 버튼이 안 눌려요');
    expect(r.html).toContain('href="https://nulnul.vercel.app/coupons"');
    expect(r.text).toContain('[널널투어 팀이 보낸 답장]');
    expect(r.text).toContain('이어서 이야기하기(대화 창): https://nulnul.vercel.app/coupons');
    // 주 경로는 대화 창이다 — 「이 메일에 회신하세요」로 안내하지 않는다
    expect(r.html).not.toContain('회신하면');
    expect(r.html).toContain('fluentui-emoji');
  });

  it('답장 본문·이름·서비스 이름의 HTML 은 해석되지 않는다', () => {
    const r = renderOperatorReplyEmail({
      ...base,
      recipientName: '<img src=x onerror=alert(1)>',
      replyBody: '<script>alert(1)</script>',
      serviceName: '<b>널널</b>',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;script&gt;');
    // 제목은 plain text — 태그 문자를 그대로 두되 개행만 없다
    expect(r.subject).toBe('[<b>널널</b>] 남기신 피드백에 답장이 왔어요');
  });

  it('제목의 서비스 이름에 개행이 있어도 헤더가 깨지지 않는다', () => {
    const r = renderOperatorReplyEmail({ ...base, serviceName: '널널\r\n투어' });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('이름이 없으면 호칭 없이, 원문이 없으면 인용 없이, 사이트가 http 면 버튼 없이', () => {
    const r = renderOperatorReplyEmail({
      ...base,
      recipientName: null,
      quotedMessage: null,
      siteUrl: 'http://insecure.example',
    });
    expect(r.html).toContain('>남기신 피드백에 답장이 왔어요.</h1>');
    expect(r.html).not.toContain('남기신 내용');
    expect(r.html).not.toContain('대화 이어가기 →');
    expect(r.text).not.toContain('이어서 이야기하기(대화 창)');
  });
});

describe('renderLoopClosedEmail', () => {
  it('반영된 제목·PR 링크·사이트 버튼을 싣는다', () => {
    const r = renderLoopClosedEmail({
      serviceName: '널널투어',
      recipientName: null,
      title: '쿠폰 적용 버튼이 눌리지 않음',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      siteUrl: 'https://nulnul.vercel.app',
      locale: 'ko',
    });
    expect(r.subject).toBe('[널널투어] 말씀하신 문제를 고쳤어요');
    expect(r.html).toContain('쿠폰 적용 버튼이 눌리지 않음');
    expect(r.html).toContain('href="https://github.com/o/r/pull/12"');
    expect(r.html).toContain('바뀐 내용 보기');
    expect(r.text).toContain('변경 내역: https://github.com/o/r/pull/12');
  });

  it('PR 링크가 없거나 https 가 아니면 링크 줄 자체가 없다', () => {
    const r = renderLoopClosedEmail({
      serviceName: '널널투어',
      recipientName: '누리',
      title: '제목',
      prNumber: null,
      prUrl: 'javascript:alert(1)',
      siteUrl: null,
      locale: 'ko',
    });
    expect(r.html).not.toContain('변경 내역');
    expect(r.html).not.toContain('javascript:');
    expect(r.text).not.toContain('변경 내역');
  });
});

describe('formatFrom', () => {
  it('서비스 이름을 표시 이름으로, 주소는 고정 — 누가 대신 보냈는지 이름에 드러난다', () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    expect(formatFrom('널널투어')).toBe('"널널투어 via Feedloop" <feedloop@rona.so>');
  });

  it('표시 이름의 따옴표·개행은 지운다 — 헤더 인젝션', () => {
    expect(formatFrom('널널"\r\nBcc: x')).toBe('"널널Bcc: x via Feedloop" <feedloop@rona.so>');
    expect(formatFrom('   ')).toBe('"Feedloop" <feedloop@rona.so>');
  });
});

describe('formatKst', () => {
  it('KST 로 「YYYY년 M월 D일 HH:mm」 — 런타임 ICU 와 무관하게 같은 문자열', () => {
    expect(formatKst(new Date('2026-09-12T12:21:00Z'))).toBe('2026년 9월 12일 21:21');
    expect(formatKst(new Date('2026-01-05T15:05:00Z'))).toBe('2026년 1월 6일 00:05');
  });
});

describe('formatUtcEnglish', () => {
  it('영어 메일은 UTC 로 「Mon D, YYYY, HH:mm UTC」 — KST 로 옮기지 않는다', () => {
    expect(formatUtcEnglish(new Date('2026-09-12T12:21:00Z'))).toBe('Sep 12, 2026, 12:21 UTC');
    expect(formatUtcEnglish(new Date('2026-01-05T15:05:00Z'))).toBe('Jan 5, 2026, 15:05 UTC');
  });
});

describe('메일 껍데기 폭 — 휴대폰에서 줄어든다', () => {
  // 🔴 2026-09-18 ny 「모바일에서 개선 이메일 쪽 깨져보여서 반응형으로 가능할까?」
  //    원인은 `width="600"` 속성이었다. 그 속성은 «고정 폭»이라 390px 화면에서도 600 을 차지해서
  //    문서가 화면보다 넓어진다(실측: 문서 632px · 화면 390px). `max-width` 는 «더 커지는 것»만
  //    막지 «줄어드는 것»을 시키지 않는다 — 줄어들게 하는 것은 `width:100%` 다.
  //    셋을 같이 둔다(속성=구형 Outlook 폴백 · width:100%=줄어듦 · max-width=안 넘침).
  it('600px 카드에 width:100% 가 함께 붙어 있다', () => {
    const r = renderLoopClosedEmail({
      serviceName: '널널투어',
      recipientName: '이수진',
      title: '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음',
      prNumber: 128,
      prUrl: 'https://github.com/example/demo/pull/128',
      siteUrl: 'https://nulnul.vercel.app',
    });
    const cards = r.html.match(/<table[^>]*width="600"[^>]*>/g) ?? [];
    expect(cards.length, '600px 카드가 없다 — 껍데기 구조가 바뀌었다').toBeGreaterThan(0);
    for (const t of cards) {
      expect(t, `고정 폭 600 만 있고 width:100% 가 없다 → 좁은 화면에서 안 줄어든다: ${t}`).toMatch(
        /style="[^"]*width:100%/,
      );
      expect(t, `max-width:600px 가 없다 → 넓은 화면에서 끝없이 늘어난다: ${t}`).toMatch(
        /style="[^"]*max-width:600px/,
      );
    }
    // 화면 폭에 맞춰 축소되라는 신호가 문서에 있어야 한다(없으면 모바일이 데스크톱 폭으로 렌더한다)
    expect(r.html).toContain('width=device-width');
  });
});

describe('메일 언어 — locale 로 사전을 고른다(기본 en)', () => {
  const reply = {
    serviceName: 'Nulnul Tours',
    recipientName: 'Mina',
    operatorName: 'Nulnul Tours team',
    replyBody: 'Found it. The coupon button was broken on iOS.',
    quotedMessage: 'The coupon button does not work',
    siteUrl: 'https://nulnul.vercel.app/coupons',
  };

  it('운영자 답장: locale 이 없으면 영어, ko 면 한국어 — 같은 구조', () => {
    const en = renderOperatorReplyEmail(reply);
    expect(en.subject).toBe('[Nulnul Tours] You have a reply to your feedback');
    expect(en.html).toContain('Hi Mina, you have a reply to your feedback.');
    expect(en.html).toContain('Continue the chat on Nulnul Tours →');
    expect(en.text).toContain('[Reply from Nulnul Tours team]');
    expect(en.text).toContain('This reply arrived on ');
    expect(en.text).toMatch(/on [A-Z][a-z]{2} \d{1,2}, 2026, \d{2}:\d{2} UTC\./);
    expect(en.text).not.toContain('KST');
    expect(/[가-힣]/.test(en.subject + en.html + en.text)).toBe(false);

    const ko = renderOperatorReplyEmail({ ...reply, locale: 'ko' });
    expect(ko.subject).toBe('[Nulnul Tours] 남기신 피드백에 답장이 왔어요');
    expect(ko.html).toContain('Mina 님, 남기신 피드백에 답장이 왔어요.');
  });

  it('되돌림: 영어 본문에 한글이 없고 PR 링크 라벨은 영어', () => {
    const en = renderLoopClosedEmail({
      serviceName: 'Nulnul Tours',
      recipientName: null,
      title: 'The coupon button does nothing',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      siteUrl: 'https://nulnul.vercel.app',
    });
    expect(en.subject).toBe('[Nulnul Tours] The problem you reported is fixed');
    expect(en.html).toContain('>The problem you reported is fixed.</h1>');
    expect(en.html).toContain('See what changed →');
    expect(en.text).toContain('Changes: https://github.com/o/r/pull/12');
    expect(/[가-힣]/.test(en.subject + en.html + en.text)).toBe(false);
  });

  it('값에 든 HTML 은 영어 문구에서도 이스케이프된다', () => {
    const en = renderOperatorReplyEmail({ ...reply, operatorName: '<i>Boss</i>', recipientName: '<img src=x>' });
    expect(en.html).not.toContain('<i>Boss</i>');
    expect(en.html).not.toContain('<img src=x>');
    expect(en.html).toContain('&lt;i&gt;Boss&lt;/i&gt;');
  });
});

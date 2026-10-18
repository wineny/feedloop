import { describe, it, expect } from 'vitest';
import { parseInline, parseSpecMarkdown } from '@/lib/groups/spec-markdown';

// 스펙 초안은 `<pre>` 에 원문이 그대로 보였다(I-21). 프롬프트가 시키는 세 가지(### 소제목 · - 불릿 · **굵게**)만
// 풀고, 그 밖의 줄은 한 글자도 바꾸지 않는다 — 모르는 문법은 보이는 게 안전하다.

describe('parseSpecMarkdown — 스펙 초안 세 가지 문법만 (I-21)', () => {
  it('### 소제목은 heading 이 된다 (기호는 사라지고 글자만 남는다)', () => {
    expect(parseSpecMarkdown('### 사용자가 원하는 것')).toEqual([{ type: 'heading', text: '사용자가 원하는 것' }]);
    expect(parseSpecMarkdown('## 왜 필요한가  ')).toEqual([{ type: 'heading', text: '왜 필요한가' }]);
  });

  it('- 불릿이 이어지면 한 목록으로 묶인다 (`*`·`•` 도 불릿)', () => {
    const blocks = parseSpecMarkdown('- 첫째\n* 둘째\n• 셋째');
    expect(blocks).toEqual([
      { type: 'list', items: [[{ text: '첫째', bold: false }], [{ text: '둘째', bold: false }], [{ text: '셋째', bold: false }]] },
    ]);
  });

  it('**굵게** 는 불릿 안·문단 안 어디서든 풀린다', () => {
    expect(parseInline('요청은 **쿠폰함 열기** 입니다')).toEqual([
      { text: '요청은 ', bold: false },
      { text: '쿠폰함 열기', bold: true },
      { text: ' 입니다', bold: false },
    ]);
    expect(parseSpecMarkdown('- **범위**: 웹만')).toEqual([
      { type: 'list', items: [[{ text: '범위', bold: true }, { text: ': 웹만', bold: false }]] },
    ]);
  });

  it('그 밖의 줄은 원문 그대로 문단이다 — 빈 줄이 문단 경계, 안쪽 줄바꿈은 보존', () => {
    const blocks = parseSpecMarkdown('첫 문단 1줄\n첫 문단 2줄\n\n둘째 문단');
    expect(blocks).toEqual([
      { type: 'paragraph', inlines: [{ text: '첫 문단 1줄\n첫 문단 2줄', bold: false }] },
      { type: 'paragraph', inlines: [{ text: '둘째 문단', bold: false }] },
    ]);
  });

  it('모르는 문법은 건드리지 않는다 — 짝 안 맞는 `**`, 띄어쓰기 없는 `-`, 숫자 목록, `#` 만 있는 줄', () => {
    const raw = '**열린 굵게\n-붙은 하이픈\n1. 숫자 목록\n#해시태그';
    expect(parseSpecMarkdown(raw)).toEqual([{ type: 'paragraph', inlines: [{ text: raw, bold: false }] }]);
  });

  it('프롬프트가 만드는 실제 모양 — 소제목·문단·불릿이 섞인 초안이 순서대로 나온다', () => {
    const draft = [
      '### 사용자가 원하는 것',
      '쿠폰함이 열리지 않는 문제의 해결.',
      '',
      '### 만든다면 이런 모습',
      '- 쿠폰함 버튼을 누르면 **1초 안에** 목록이 뜬다',
      '- 비어 있으면 안내 문구',
      '',
      '### 정해야 할 것',
      '- 앱과 웹 중 어디를 먼저 고칠지',
    ].join('\n');
    const blocks = parseSpecMarkdown(draft);
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'list', 'heading', 'list']);
    expect(blocks[3]).toMatchObject({ type: 'list', items: [[{ text: '쿠폰함 버튼을 누르면 ', bold: false }, { text: '1초 안에', bold: true }, { text: ' 목록이 뜬다', bold: false }], [{ text: '비어 있으면 안내 문구', bold: false }]] });
  });

  it('CRLF 도 같은 결과다 (모델 출력의 줄바꿈 종류를 가리지 않는다)', () => {
    expect(parseSpecMarkdown('### 제목\r\n- 항목')).toEqual(parseSpecMarkdown('### 제목\n- 항목'));
  });
});

describe('parseSpecMarkdown — 리뷰 보강', () => {
  it('내용 없는 `- ` 는 불릿이 아니라 원문 그대로 문단이다 (빈 점이 찍히지 않게)', () => {
    expect(parseSpecMarkdown('- ')).toEqual([{ type: 'paragraph', inlines: [{ text: '- ', bold: false }] }]);
  });
});

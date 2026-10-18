// 스펙 초안(`insight_groups.spec_draft`)의 «아주 작은» 마크다운 해석기. 의존성 0.
//
// 초안 형식은 우리 프롬프트(`spec.ts`)가 정한다 — `###` 소제목·`- ` 불릿·`**굵게**` 세 가지만 쓰라고
// 시키므로 그 셋만 푼다. 예전엔 `<pre>` 에 원문을 그대로 넣어 「### 사용자가 원하는 것」이 기호째 보였다(I-21).
// 범용 마크다운 라이브러리를 안 붙인 이유: 제출 직전 의존성 추가를 피하고, 모르는 문법은 «그대로 보이는
// 것»이 더 안전하다(표·링크·코드블록은 프롬프트가 금지하니 나올 일이 없고, 나오면 원문이 그대로 보인다).

export type SpecInline = { text: string; bold: boolean };

export type SpecBlock =
  | { type: 'heading'; text: string }
  | { type: 'list'; items: SpecInline[][] }
  | { type: 'paragraph'; inlines: SpecInline[] };

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
// 내용이 없는 `- ` 는 불릿으로 치지 않는다(빈 점이 찍힌다). 앞 공백은 무시한다 — 중첩 목록은 프롬프트가 안 시키고, 나오면 한 단계로 평탄해진다.
const BULLET = /^\s*[-*•]\s+(\S.*)$/;

/** `**굵게**` 만 푼다. 짝이 안 맞는 `**` 는 글자 그대로 남긴다. */
export function parseInline(text: string): SpecInline[] {
  const out: SpecInline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

/**
 * 줄 단위로 나눈다. 빈 줄은 블록 경계다. 불릿이 이어지면 한 목록으로 묶고, 그 밖의 줄은 이어진
 * 것끼리 한 문단이다(문단 안 줄바꿈은 화면이 `whitespace-pre-line` 으로 살린다).
 */
export function parseSpecMarkdown(text: string): SpecBlock[] {
  const blocks: SpecBlock[] = [];
  let list: SpecInline[][] | null = null;
  let para: string[] | null = null;

  const flush = () => {
    if (list) blocks.push({ type: 'list', items: list });
    if (para) blocks.push({ type: 'paragraph', inlines: parseInline(para.join('\n')) });
    list = null;
    para = null;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(raw);
    if (h) {
      flush();
      blocks.push({ type: 'heading', text: h[1] });
      continue;
    }
    const b = BULLET.exec(raw);
    if (b) {
      if (para) flush();
      (list ??= []).push(parseInline(b[1]));
      continue;
    }
    if (list) flush();
    (para ??= []).push(raw);
  }
  flush();
  return blocks;
}

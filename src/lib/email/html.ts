// 이메일 HTML 에 사람이 쓴 값을 넣을 때의 정제.
//
// 답장 본문·방문자 이름·서비스 이름은 전부 사람이 쓴 값이다. 방문자 이름은 무인증 위젯에서
// 오고, 답장 본문은 운영자가 쓴다 — 어느 쪽도 HTML 로 해석되면 안 된다.

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/** 여러 줄 텍스트 → 이스케이프 + 줄바꿈을 `<br>` 로. 빈 줄은 문단 간격으로 남긴다. */
export function textToHtml(value: string): string {
  return htmlEscape(value.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br />');
}

/**
 * 제목용 정제 — 제목은 plain text 라 htmlEscape 를 쓰면 엔티티가 그대로 보인다.
 * 헤더 인젝션만 막는다(CR/LF → 공백).
 */
export function sanitizeSubjectText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * href 용 URL — https 만 허용하고 나머지는 null. 호출부는 null 이면 링크 자체를 뺀다.
 * `#` 폴백으로 눌러도 아무 일 없는 버튼을 만드는 것보다 안 보이는 편이 낫다.
 */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    // 원문을 그대로 돌려준다 — `URL.toString()` 은 `https://a.b` 에 `/` 를 붙여 origin 값이 바뀐다.
    return new URL(url).protocol === 'https:' ? url.trim() : null;
  } catch {
    return null;
  }
}

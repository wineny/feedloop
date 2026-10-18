// 이메일 공유 레이아웃 — rona_practice 결제 영수증 메일(`templates/payment-receipt.ts` ·
// `base-layout.ts`)의 구조를 Feedloop 토큰으로 옮긴 것. 통문자열 HTML 대신 이 조각들을 조합한다.
//
// 영수증 메일의 뼈대를 그대로 따른다:
//   Fluent 3D 이모지(64px) → 코랄 eyebrow → 26/800 헤드라인 → 보조 문단
//   → 「01 · …」 번호 섹션(헤어라인 + 20/800 제목) → 영수증식 행 카드(#f8fafc)
//   → 코랄 틴트 하이라이트 카드 안에 CTA → 회색 푸터
//
// 색은 `globals.css` `.landing` 의 값을 하드카피했다(이메일은 CSS 변수를 못 쓴다):
//   코랄 #F2645C · 잉크 #191d1b · 회색 #6e6968 / #a39d9b · 헤어라인 #eeeae9 · 칩 #f6f3f2 · 틴트 #FDF1F0
//
// 플레인 텍스트 인자는 여기서 이스케이프하고, `*Html` 인자는 호출자가 이미 정제한 HTML 로 본다.

import { htmlEscape } from './html';

export const EMAIL_COLORS = {
  brand: '#F2645C',
  ink: '#191d1b',
  body: '#3a3f3d',
  muted: '#6e6968',
  faint: '#a39d9b',
  line: '#eeeae9',
  chip: '#f6f3f2',
  cardBg: '#f8f7f6',
  tint: '#FDF1F0',
  pageBg: '#f3f0ef',
} as const;

const FONT_STACK =
  "'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif";

/**
 * Fluent 3D 이모지 — rona 영수증이 쓰는 CDN 그대로. 여기 적힌 것은 2026-09-12 에 200 을 확인한 경로다.
 * 새 이모지를 쓰려면 먼저 CDN 200 을 확인할 것(스킨톤 있는 이모지는 `Default/3D/<name>_3d_default.png`).
 */
export const FLUENT_3D = {
  speechBalloon:
    'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Speech%20balloon/3D/speech_balloon_3d.png',
  partyPopper:
    'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Party%20popper/3D/party_popper_3d.png',
  sparkles: 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Sparkles/3D/sparkles_3d.png',
  checkMark:
    'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Check%20mark%20button/3D/check_mark_button_3d.png',
} as const;

/**
 * 바깥 배경 + 600px 흰 카드. children 은 `<tr>…</tr>` 행들.
 *
 * 🔴 **`width="600"` 만으로는 휴대폰에서 안 줄어든다.** 그 속성은 «고정 폭»이라 390px 화면에서도
 *    600px 를 그대로 차지해서, 문서가 화면보다 넓어지고 메일이 옆으로 삐져나간다
 *    (2026-09-18 실측 390px: 문서 폭 632px · 화면 390px — ny 「모바일에서 개선 이메일 쪽 깨져보여서」).
 *    `max-width` 는 «더 커지는 것»만 막지 «줄어드는 것»을 시키지 않는다. 줄어들게 하는 것은
 *    `style` 의 `width:100%` 다. 셋을 같이 둔다:
 *      · `width="600"` 속성 — CSS 를 거의 안 읽는 구형 Outlook(데스크톱, 어차피 넓다)용 폴백
 *      · `width:100%`     — 화면이 좁으면 따라 줄어든다
 *      · `max-width:600px` — 화면이 넓어도 600 을 안 넘는다
 */
export function emailShell(opts: { title: string; children: string }): string {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${htmlEscape(opts.title)}</title></head>
<body style="margin:0;padding:0;background:${EMAIL_COLORS.pageBg};font-family:${FONT_STACK};-webkit-text-size-adjust:100%;word-break:keep-all;color:${EMAIL_COLORS.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.pageBg};padding:36px 16px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;overflow:hidden;width:100%;max-width:600px;box-shadow:0 2px 0 rgba(25,29,27,0.04)">
${opts.children}
</table>
</td></tr></table>
</body></html>`;
}

/** 히어로 — 64px Fluent 3D 이모지 + 코랄 eyebrow + 26/800 헤드라인 + 보조 문단(raw HTML). */
export function emailHero(opts: {
  imageUrl: string;
  eyebrow: string;
  heading: string;
  subHtml: string;
}): string {
  return `<tr><td style="padding:40px 32px 8px">
  <img src="${opts.imageUrl}" width="64" height="64" alt="" style="display:block;margin:0 0 18px;border:0;width:64px;height:64px" />
  <p style="font-size:11px;letter-spacing:0.18em;color:${EMAIL_COLORS.brand};font-weight:700;margin:0 0 14px">${htmlEscape(opts.eyebrow)}</p>
  <h1 style="font-size:26px;font-weight:800;color:${EMAIL_COLORS.ink};margin:0 0 14px;line-height:1.35;letter-spacing:-0.025em">${htmlEscape(opts.heading)}</h1>
  <p style="font-size:15px;color:${EMAIL_COLORS.muted};line-height:1.7;margin:0 0 28px">${opts.subHtml}</p>
</td></tr>`;
}

/** 번호 섹션 — 상단 헤어라인 + 「01 · …」 eyebrow + 20/800 제목 + 본문(raw HTML). */
export function emailSection(opts: {
  eyebrow: string;
  title: string;
  children: string;
  /** 마지막 섹션이면 하단 패딩을 키운다(영수증 패턴). */
  last?: boolean;
}): string {
  const pad = opts.last ? '0 32px 32px' : '0 32px';
  return `<tr><td style="padding:${pad}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${EMAIL_COLORS.line}"><tr><td style="padding:26px 0 6px">
    <p style="font-size:11px;letter-spacing:0.18em;color:${EMAIL_COLORS.faint};font-weight:700;margin:0 0 6px;font-variant-numeric:tabular-nums">${htmlEscape(opts.eyebrow)}</p>
    <p style="font-size:20px;font-weight:800;color:${EMAIL_COLORS.ink};margin:0 0 18px;letter-spacing:-0.02em">${htmlEscape(opts.title)}</p>
    ${opts.children}
  </td></tr></table>
</td></tr>`;
}

/** 본문 카드 — 답장처럼 긴 글이 들어가는 연회색 카드. */
export function emailCard(opts: { bodyHtml: string }): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.cardBg};border-radius:12px;margin:0 0 14px"><tr><td style="padding:20px 22px;font-size:15px;color:${EMAIL_COLORS.ink};line-height:1.75">${opts.bodyHtml}</td></tr></table>`;
}

/** 영수증식 행 카드 — 라벨 | 값. 값은 raw HTML(링크가 들어갈 수 있다). */
export function emailRows(rows: { label: string; valueHtml: string; strong?: boolean }[]): string {
  const divider = `<tr><td colspan="2" style="border-top:1px solid ${EMAIL_COLORS.line};font-size:0;line-height:0;height:1px">&nbsp;</td></tr>`;
  const body = rows
    .map((r, i) => {
      const value = r.strong
        ? `font-size:15px;color:${EMAIL_COLORS.ink};font-weight:800;letter-spacing:-0.01em`
        : `font-size:14px;color:${EMAIL_COLORS.body};font-weight:600;letter-spacing:-0.005em`;
      const row = `<tr>
  <td width="110" style="padding:9px 0;font-size:13px;color:${EMAIL_COLORS.faint};font-weight:600;vertical-align:top">${htmlEscape(r.label)}</td>
  <td style="padding:9px 0;${value};text-align:right;line-height:1.55;vertical-align:top">${r.valueHtml}</td>
</tr>`;
      return i === 0 ? row : divider + row;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.cardBg};border-radius:12px;margin:0 0 14px"><tr><td style="padding:12px 22px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
</td></tr></table>`;
}

/** 인용 — 방문자가 남긴 원문. 코랄 왼선. */
export function emailQuote(opts: { label: string; bodyHtml: string }): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px"><tr><td style="padding:2px 0 2px 16px;border-left:3px solid ${EMAIL_COLORS.brand}">
  <p style="font-size:11px;letter-spacing:0.14em;color:${EMAIL_COLORS.faint};font-weight:700;margin:0 0 6px">${htmlEscape(opts.label)}</p>
  <p style="font-size:14px;color:${EMAIL_COLORS.muted};line-height:1.7;margin:0">${opts.bodyHtml}</p>
</td></tr></table>`;
}

/** 코랄 틴트 하이라이트 카드 — eyebrow + 굵은 한 줄 + 설명 + (있으면) CTA. 영수증의 「02 · 부탁드려요」 카드. */
export function emailHighlightCard(opts: {
  eyebrow: string;
  leadHtml: string;
  bodyHtml: string;
  cta?: { href: string; label: string } | null;
}): string {
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 0"><tr><td>
    <a href="${htmlEscape(opts.cta.href)}" style="display:inline-block;background:${EMAIL_COLORS.brand};color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-size:14px;font-weight:700;letter-spacing:-0.005em">${htmlEscape(opts.cta.label)}</a>
  </td></tr></table>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.tint};border-radius:14px;margin:0 0 18px"><tr><td style="padding:24px 24px 22px">
  <p style="font-size:12px;letter-spacing:0.16em;color:${EMAIL_COLORS.brand};font-weight:700;margin:0 0 10px;text-transform:uppercase">${htmlEscape(opts.eyebrow)}</p>
  <p style="font-size:15px;color:${EMAIL_COLORS.ink};line-height:1.65;margin:0 0 ${opts.bodyHtml ? '10px' : '0'};font-weight:600;letter-spacing:-0.01em">${opts.leadHtml}</p>
  ${opts.bodyHtml ? `<p style="font-size:14px;color:${EMAIL_COLORS.body};line-height:1.7;margin:0">${opts.bodyHtml}</p>` : ''}
  ${cta}
</td></tr></table>`;
}

/** 섹션 끝 작은 안내 문단(raw HTML). */
export function emailNote(opts: { html: string }): string {
  return `<p style="font-size:12px;color:${EMAIL_COLORS.faint};line-height:1.65;margin:0 0 4px">${opts.html}</p>`;
}

/** 푸터 — 서비스 링크 + 누가 왜 보냈는지 한 줄. 트랜잭션 메일이라 수신거부 링크는 없다. */
export function emailFooter(opts: { link?: { href: string; label: string } | null; note: string }): string {
  const link = opts.link
    ? `<p style="font-size:12px;color:${EMAIL_COLORS.muted};line-height:1.6;margin:0 0 4px"><a href="${htmlEscape(opts.link.href)}" style="color:${EMAIL_COLORS.brand};font-weight:600;text-decoration:none">${htmlEscape(opts.link.label)}</a></p>`
    : '';
  return `<tr><td style="background:${EMAIL_COLORS.chip};padding:18px 32px;text-align:center;border-top:1px solid ${EMAIL_COLORS.line}">
  ${link}<p style="font-size:11px;color:${EMAIL_COLORS.faint};line-height:1.6;margin:0">${htmlEscape(opts.note)}</p>
</td></tr>`;
}

// 방문자에게 가는 메일 2종 — 운영자 답장 · 되돌림(PR 머지).
//
// 둘 다 위젯에 이미 뜨는 내용의 «이메일 사본»이다. 방문자가 사이트를 다시 열지 않으면
// 위젯 안의 답장은 영영 못 보므로, 연락처 폼에 이메일을 남긴 사람에게는 이걸 보낸다.
//
// ⚠️ 주 경로는 «대화 창에서 이어가기»다. 이 메일에 답장을 써도 Reply-To 로 운영자 메일함에
// 가긴 하지만 Feedloop 대화엔 기록이 안 남고 반영 소식(되돌림)도 그쪽으로는 안 간다.
// 그래서 문구가 「회신하세요」가 아니라 「대화 창에서 이어가 주세요」다(2026-09-12 사용자 지적).
//
// 렌더는 순수 함수다 — DB·네트워크 없이 테스트한다.
//
// 문구는 전부 사전(`messages/<locale>/email.json`)에서 온다. 각 렌더 함수는 `locale` 을 받는다(없으면 en):
//   · 방문자에게 가는 메일(답장·되돌림) — 대화에 저장된 언어(`conversations.locale`), 호출부 notify.ts 가 정한다
//   · 사업자에게 가는 메일(상담원 연결·새 대화·환불 승인) — `OWNER_EMAIL_LOCALE`(notify.ts) 하나로 고정
// 사전 값에는 HTML 을 넣지 않는다. HTML 에 들어가는 자리는 호출부가 htmlEscape 한 값을 인자로 넘기고,
// 텍스트 본문·제목에는 원문을 넘긴다.

import { serverT } from '@/i18n/server-messages';
import type { Locale } from '@/i18n/routing';
import { htmlEscape, sanitizeSubjectText, safeHttpsUrl, textToHtml } from './html';
import {
  EMAIL_COLORS,
  FLUENT_3D,
  emailCard,
  emailFooter,
  emailHero,
  emailHighlightCard,
  emailNote,
  emailQuote,
  emailRows,
  emailSection,
  emailShell,
} from './layout';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** 이름 앞뒤 공백을 접고, 없으면 null. 호칭은 호출부가 붙인다. */
function cleanName(name: string | null | undefined): string | null {
  const v = (name ?? '').replace(/\s+/g, ' ').trim();
  return v === '' ? null : v;
}

type MailT = ReturnType<typeof serverT>;
const mailT = (locale: Locale | undefined, ns: string): MailT => serverT(locale ?? 'en', `email.${ns}`);

/** 제목·헤드라인용 이름 붙은 문구(`xxxNamed`)와 없는 문구를 고른다. */
function headline(t: MailT, key: string, name: string | null): string {
  return name ? t(`${key}Named`, { name }) : t(key);
}

/** 서비스 URL 을 푸터에 보여줄 짧은 라벨(호스트만). */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 「2026년 9월 12일 21:21」 — KST 고정. Intl 의 ko-KR 시각 표기는 런타임 ICU 에 따라
 * 「오후 9:21」/「PM 9:21」로 갈려서(로컬 실측) 부품만 받아 직접 조립한다.
 */
const KST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function formatKst(d: Date): string {
  const p = Object.fromEntries(KST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}년 ${Number(p.month)}월 ${Number(p.day)}일 ${p.hour}:${p.minute}`;
}

/** "Oct 21, 2026, 22:00 KST" — 영어 메일은 시간대(KST)는 유지하되 표기만 영어로. */
function formatKstEnglish(d: Date): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(d)} KST`;
}

function formatMailTime(d: Date, locale: Locale | undefined): string {
  return locale === 'ko' ? formatKst(d) : formatKstEnglish(d);
}

function linkHtml(href: string, label: string): string {
  return `<a href="${htmlEscape(href)}" style="color:${EMAIL_COLORS.brand};font-weight:700;text-decoration:none">${htmlEscape(label)}</a>`;
}

// ── 운영자 답장 ─────────────────────────────────────────

export interface OperatorReplyEmailVars {
  /** 봇의 service_name — 제목 머리·발신자 표시·푸터에 쓴다 */
  serviceName: string;
  /** 방문자가 연락처 폼에 남긴 이름 */
  recipientName: string | null;
  /** 답장 라벨 — `operator_display_name`, 없으면 «{서비스} team» */
  operatorName: string;
  /** 운영자가 쓴 답장 원문(여러 줄 가능) */
  replyBody: string;
  /** 방문자의 마지막 메시지 — 무엇에 대한 답인지 상기시킨다 */
  quotedMessage: string | null;
  /** 대화를 이어갈 곳 — 위젯이 붙은 페이지(origin) 또는 서비스 URL. https 아니면 버튼 생략 */
  siteUrl: string | null;
  /** 답장 시각. 없으면 지금 */
  repliedAt?: Date;
  /** 메일 언어. 방문자가 위젯에서 쓴 언어(conversations.locale). 없으면 en */
  locale?: Locale;
}

export function renderOperatorReplyEmail(v: OperatorReplyEmailVars): RenderedEmail {
  const t = mailT(v.locale, 'operatorReply');
  const service = sanitizeSubjectText(v.serviceName) || mailT(v.locale, 'common')('service');
  const name = cleanName(v.recipientName);
  const site = safeHttpsUrl(v.siteUrl);
  const repliedAt = formatMailTime(v.repliedAt ?? new Date(), v.locale);
  const subject = t('subject', { service });
  const quoted = v.quotedMessage?.trim() || null;
  const heading = headline(t, 'heading', name);

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: t('eyebrow'),
      heading,
      subHtml: `${htmlEscape(t('sub1', { operator: v.operatorName }))}<br>${htmlEscape(t('sub2', { service }))}`,
    }),
    emailSection({
      eyebrow: t('s1Eyebrow'),
      title: t('s1Title', { operator: v.operatorName }),
      children: [
        emailCard({ bodyHtml: textToHtml(v.replyBody) }),
        quoted ? emailQuote({ label: t('quoteLabel'), bodyHtml: textToHtml(quoted) }) : '',
        emailNote({ html: htmlEscape(t('arrivedNote', { at: repliedAt })) }),
      ].join('\n'),
    }),
    emailSection({
      eyebrow: t('s2Eyebrow'),
      title: t('s2Title'),
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: t('hlEyebrow'),
          leadHtml: htmlEscape(t('hlLead')),
          bodyHtml: `${htmlEscape(t('hlBody1'))}<br>${htmlEscape(t('hlBody2'))}`,
          cta: site ? { href: site, label: t('cta', { service }) } : null,
        }),
        emailNote({ html: htmlEscape(t('note')) }),
      ].join('\n'),
    }),
    emailFooter({
      link: site ? { href: site, label: hostLabel(site) } : null,
      note: t('footer', { service }),
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n'), lang: v.locale ?? 'en' });

  const textLines = [heading, '', t('textReply', { operator: v.operatorName }), v.replyBody];
  if (quoted) textLines.push('', t('textQuote'), quoted);
  textLines.push('', t('textArrived', { at: repliedAt }));
  if (site) textLines.push('', t('textContinue', { url: site }));
  textLines.push('', t('textRecord'), `— ${service} · Feedloop`);

  return { subject, html, text: textLines.join('\n') };
}

// ── 되돌림 ─────────────────────────────────────────────

export interface LoopClosedEmailVars {
  serviceName: string;
  recipientName: string | null;
  /** 반영된 문제의 제목(묶음 제목 또는 인사이트 요약) */
  title: string;
  prNumber: number | null;
  /** PR 링크. 비공개 레포면 방문자에겐 404 일 수 있어 «참고» 로만 싣는다 */
  prUrl: string | null;
  siteUrl: string | null;
  /** 반영(머지 확인) 시각. 없으면 지금 */
  appliedAt?: Date;
  /** 메일 언어. 방문자가 위젯에서 쓴 언어(conversations.locale). 없으면 en */
  locale?: Locale;
}

export function renderLoopClosedEmail(v: LoopClosedEmailVars): RenderedEmail {
  const t = mailT(v.locale, 'loopClosed');
  const service = sanitizeSubjectText(v.serviceName) || mailT(v.locale, 'common')('service');
  const name = cleanName(v.recipientName);
  const site = safeHttpsUrl(v.siteUrl);
  const pr = safeHttpsUrl(v.prUrl);
  const appliedAt = formatMailTime(v.appliedAt ?? new Date(), v.locale);
  const subject = t('subject', { service });
  const prLabel = t('prLabel');
  const heading = headline(t, 'heading', name);

  const receipt: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: t('rowFixed'), valueHtml: htmlEscape(v.title), strong: true },
    { label: t('rowTime'), valueHtml: htmlEscape(appliedAt) },
  ];
  if (pr) receipt.push({ label: t('rowPr'), valueHtml: linkHtml(pr, prLabel) });

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.partyPopper,
      eyebrow: t('eyebrow'),
      heading,
      subHtml: `${htmlEscape(t('sub1', { service }))}<br>${htmlEscape(t('sub2'))}`,
    }),
    emailSection({
      eyebrow: t('s1Eyebrow'),
      title: t('s1Title'),
      children: [emailRows(receipt), emailNote({ html: htmlEscape(t('note')) })].join('\n'),
    }),
    emailSection({
      eyebrow: t('s2Eyebrow'),
      title: t('s2Title'),
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: t('hlEyebrow'),
          leadHtml: htmlEscape(t('hlLead')),
          bodyHtml: htmlEscape(t('hlBody')),
          cta: site ? { href: site, label: t('cta', { service }) } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: site ? { href: site, label: hostLabel(site) } : null,
      note: t('footer', { service }),
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n'), lang: v.locale ?? 'en' });

  const textLines = [heading, '', t('textFixed'), v.title, t('textTime', { at: appliedAt })];
  if (pr) textLines.push(t('textPr', { url: pr }));
  if (site) textLines.push('', t('textCheck', { url: site }));
  textLines.push('', t('textStill'), `— ${service} · Feedloop`);

  return { subject, html, text: textLines.join('\n') };
}

// ── 운영자 알림 — 상담원 연결 요청 / 「아직 안 고쳐졌다」 (봇 소유자에게) ──
//
// 위 둘은 «방문자»에게 가지만 이건 «운영자»에게 간다 — 「상담원 연결 요청이 왔으니 확인하고 답장해 달라」.
// 답장은 메일 회신이 아니라 Feedloop 「대화」 탭에서 한다(회신하면 대화에 안 남고 방문자 위젯에도 안 간다).
// 조사 결과(리서치 문서) 공통: 전문 + AI 요약 + 사유를 같이 넘겨 「처음부터 다시 묻게 하지 않는다」.

export interface HandoffRequestEmailVars {
  /**
   * `handoff` 방문자가 「상담원 연결」을 눌렀다 / `not_fixed` 되돌림을 받고 「아직 그대로예요」라고 답했다.
   *
   * 둘을 한 템플릿으로 두는 이유: 도착하는 상태가 같다(대화 `escalated_at`). 운영자가 할 일도
   * 「대화에서 답장」으로 같고 맥락·딥링크·발송 상한도 공유한다. 다른 건 «왜 왔는가» 한 줄뿐이다.
   */
  kind?: 'handoff' | 'not_fixed';
  serviceName: string;
  /** 방문자 표시 — 연락처 이름, 없으면 «Visitor #xxxx» */
  visitorLabel: string;
  visitorEmail: string | null;
  /** 방문자가 「상담원 연결」로 남긴 말. 없으면(버튼만) 마지막 메시지 */
  requestBody: string | null;
  /** 최근 대화(오래된 → 최신). 라벨은 방문자/서비스이름/안내 */
  recentTurns: { who: string; body: string }[];
  /** AI 한 줄 요약. 못 만들었으면 null */
  summary: string | null;
  /** 요청이 들어온 페이지(origin). https 아니면 텍스트로만 */
  pageUrl: string | null;
  /** Feedloop 「대화」 딥링크. 없으면 버튼 생략 */
  inboxUrl: string | null;
  requestedAt?: Date;
  /** 메일 언어(사업자 메일은 notify.ts 의 OWNER_EMAIL_LOCALE). 없으면 en */
  locale?: Locale;
}

export function renderHandoffRequestEmail(v: HandoffRequestEmailVars): RenderedEmail {
  const t = mailT(v.locale, 'handoff');
  const common = mailT(v.locale, 'common');
  const service = sanitizeSubjectText(v.serviceName) || common('service');
  const visitor = sanitizeSubjectText(v.visitorLabel) || common('visitor');
  const inbox = safeHttpsUrl(v.inboxUrl);
  const page = safeHttpsUrl(v.pageUrl);
  const at = formatMailTime(v.requestedAt ?? new Date(), v.locale);
  const notFixed = v.kind === 'not_fixed';
  const subject = t(notFixed ? 'subjectNotFixed' : 'subject', { service, visitor });
  const request = v.requestBody?.trim() || null;

  const facts: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: t('factVisitor'), valueHtml: htmlEscape(v.visitorLabel), strong: true },
    { label: t('factEmail'), valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : htmlEscape(t('emailNone')) },
    { label: t('factRequested'), valueHtml: htmlEscape(at) },
  ];
  if (v.pageUrl) facts.push({ label: t('factPage'), valueHtml: page ? linkHtml(page, hostLabel(page)) : htmlEscape(v.pageUrl) });

  const turnsHtml = v.recentTurns.length
    ? v.recentTurns
        .map((turn) => `<p style="margin:0 0 8px"><b style="color:${EMAIL_COLORS.ink}">${htmlEscape(turn.who)}</b> · ${textToHtml(turn.body)}</p>`)
        .join('')
    : '';

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: t(notFixed ? 'eyebrowNotFixed' : 'eyebrow'),
      heading: t(notFixed ? 'headingNotFixed' : 'heading', { visitor: v.visitorLabel }),
      subHtml: notFixed
        ? `${htmlEscape(t('subNotFixed1', { service }))}<br>${htmlEscape(t('subNotFixed2'))}`
        : `${htmlEscape(t('sub1', { service }))}<br>${htmlEscape(t(v.visitorEmail ? 'sub2Mail' : 'sub2'))}`,
    }),
    emailSection({
      eyebrow: t('s1Eyebrow'),
      // 「처음 말한 문제」가 아니다 — not_fixed 경로는 requestBody 가 비어 있어 발송기가
      // «최근 8턴 중 마지막 방문자 발화»를 채운다(notify.ts 의 fallbackQuote). 제목이 그걸 말해야 한다.
      title: t(notFixed ? 's1TitleNotFixed' : 's1Title'),
      children: [
        request
          ? emailCard({ bodyHtml: textToHtml(request) })
          : emailNote({ html: htmlEscape(t(notFixed ? 'noMessageNotFixed' : 'noMessage')) }),
        v.summary ? emailQuote({ label: t('summaryLabel'), bodyHtml: textToHtml(v.summary) }) : '',
      ].join('\n'),
    }),
    emailSection({
      eyebrow: t('s2Eyebrow'),
      title: t('s2Title'),
      children: [turnsHtml ? emailCard({ bodyHtml: turnsHtml }) : emailNote({ html: htmlEscape(t('noTurns')) }), emailRows(facts)].join('\n'),
    }),
    emailSection({
      eyebrow: t('s3Eyebrow'),
      title: t('s3Title'),
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: t('hlEyebrow'),
          leadHtml: htmlEscape(t('hlLead')),
          bodyHtml: htmlEscape(t('hlBody')),
          cta: inbox ? { href: inbox, label: t('cta') } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: t('footerLink') } : null,
      note: t(notFixed ? 'footerNotFixed' : 'footer', { service }),
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n'), lang: v.locale ?? 'en' });

  const textLines = [t(notFixed ? 'textHeadNotFixed' : 'textHead', { visitor: v.visitorLabel }), ''];
  textLines.push(t(notFixed ? 'textMessageNotFixed' : 'textMessage'), request ?? t('textNone'));
  if (v.summary) textLines.push('', t('textSummary'), v.summary);
  if (v.recentTurns.length) {
    textLines.push('', t('textRecent'));
    for (const turn of v.recentTurns) textLines.push(`${turn.who}: ${turn.body}`);
  }
  textLines.push(
    '',
    t('textVisitor', { visitor: v.visitorLabel }),
    t('textEmail', { email: v.visitorEmail ?? t('emailNoneText') }),
    t('textRequested', { at }),
  );
  if (v.pageUrl) textLines.push(t('textPage', { url: v.pageUrl }));
  if (inbox) textLines.push('', t('textReply', { url: inbox }));
  textLines.push('', t('textDoNotReply'), `— ${service} · Feedloop`);

  return { subject, html, text: textLines.join('\n') };
}

// ── 새 대화 알림(봇 소유자) ───────────────────────────────────────────────
//
// 대화가 «새로 열려» 첫 말이 들어왔을 때 한 번만 간다(2026-09-23 ny 결정). 「상담원 연결」·「아직
// 그대로예요」 알림과 템플릿을 합치지 않는 이유: 저쪽은 «사람이 필요하다»는 신호라 최근 대화·AI 요약이
// 실리고 답장을 재촉하지만, 이쪽은 «들어왔다»는 알림이라 첫 메시지 하나면 충분하고 재촉하지 않는다.
// 이어지는 말은 실리지 않는다 — 모든 채팅을 메일로 보내지 않는다.

export interface NewConversationEmailVars {
  serviceName: string;
  /** 방문자 표시 — 연락처 이름, 없으면 «Visitor #xxxx» */
  visitorLabel: string;
  visitorEmail: string | null;
  /** 방문자가 처음 남긴 말(칩만 누른 건 제외한 첫 «진짜» 메시지) */
  firstMessage: string;
  /** 대화가 열린 페이지(origin). https 아니면 텍스트로만 */
  pageUrl: string | null;
  /** Feedloop 「대화」 딥링크. 없으면 버튼 생략 */
  inboxUrl: string | null;
  receivedAt?: Date;
  /** 메일 언어(사업자 메일은 notify.ts 의 OWNER_EMAIL_LOCALE). 없으면 en */
  locale?: Locale;
}

/** 제목에 실을 첫 메시지 조각. 길면 자르고 「…」. */
function subjectSnippet(text: string, max = 28): string {
  const t = sanitizeSubjectText(text);
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

export function renderNewConversationEmail(v: NewConversationEmailVars): RenderedEmail {
  const t = mailT(v.locale, 'newConversation');
  const common = mailT(v.locale, 'common');
  const service = sanitizeSubjectText(v.serviceName) || common('service');
  const visitor = sanitizeSubjectText(v.visitorLabel) || common('visitor');
  const inbox = safeHttpsUrl(v.inboxUrl);
  const page = safeHttpsUrl(v.pageUrl);
  const at = formatMailTime(v.receivedAt ?? new Date(), v.locale);
  const first = v.firstMessage.trim();
  const subject = t('subject', { service, visitor, snippet: subjectSnippet(first) });

  const facts: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: t('factVisitor'), valueHtml: htmlEscape(v.visitorLabel), strong: true },
    { label: t('factEmail'), valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : htmlEscape(t('emailNone')) },
    { label: t('factReceived'), valueHtml: htmlEscape(at) },
  ];
  if (v.pageUrl) facts.push({ label: t('factPage'), valueHtml: page ? linkHtml(page, hostLabel(page)) : htmlEscape(v.pageUrl) });

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: t('eyebrow'),
      heading: t('heading', { visitor: v.visitorLabel }),
      subHtml: `${htmlEscape(t('sub1', { service }))}<br>${htmlEscape(t('sub2'))}`,
    }),
    emailSection({
      eyebrow: t('s1Eyebrow'),
      title: t('s1Title'),
      children: [emailCard({ bodyHtml: textToHtml(first) }), emailRows(facts)].join('\n'),
    }),
    emailSection({
      eyebrow: t('s2Eyebrow'),
      title: t('s2Title'),
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: t('hlEyebrow'),
          leadHtml: htmlEscape(t('hlLead')),
          bodyHtml: htmlEscape(t('hlBody')),
          cta: inbox ? { href: inbox, label: t('cta') } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: t('footerLink') } : null,
      note: t('footer', { service }),
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n'), lang: v.locale ?? 'en' });

  const textLines = [
    t('textHead', { visitor: v.visitorLabel, service }),
    '',
    t('textFirst'),
    first,
    '',
    t('textVisitor', { visitor: v.visitorLabel }),
    t('textEmail', { email: v.visitorEmail ?? t('emailNone') }),
    t('textReceived', { at }),
  ];
  if (v.pageUrl) textLines.push(t('textPage', { url: v.pageUrl }));
  if (inbox) textLines.push('', t('textOpen', { url: inbox }));
  textLines.push('', t('textOnce'), service === 'Feedloop' ? '— Feedloop' : `— ${service} · Feedloop`);

  return { subject, html, text: textLines.join('\n') };
}

// ── 환불 승인 요청 (봇 소유자) ─────────────────────────────────────
//
// Stage 3 (design v2 §4): a visitor asked the widget for a refund and the guardrail did not let it
// run automatically — the row is `pending` and waits in the inbox. One mail per pending action.
// The decision itself is taken in the inbox (approve / reject); this mail carries the facts and the
// deep link, never a decision button.

export interface RefundApprovalEmailVars {
  serviceName: string;
  visitorLabel: string;
  visitorEmail: string | null;
  /** "$29.50" */
  amount: string;
  reason: string | null;
  /** The guardrail checks that did not pass — why a person is asked. */
  failedChecks: string[];
  /** PayPal capture id, for the operator's PayPal dashboard. */
  captureId: string;
  /** Feedloop inbox deep link. Null → button omitted. */
  inboxUrl: string | null;
  requestedAt?: Date;
  /** 메일 언어(사업자 메일은 notify.ts 의 OWNER_EMAIL_LOCALE). 없으면 en */
  locale?: Locale;
}

export function renderRefundApprovalEmail(v: RefundApprovalEmailVars): RenderedEmail {
  const t = mailT(v.locale, 'refund');
  const service = sanitizeSubjectText(v.serviceName) || t('defaultService');
  const visitor = sanitizeSubjectText(v.visitorLabel) || t('defaultVisitor');
  const inbox = safeHttpsUrl(v.inboxUrl);
  const at = formatMailTime(v.requestedAt ?? new Date(), v.locale);
  const subject = t('subject', { service, amount: v.amount, visitor });
  const reason = v.reason?.trim() || null;

  const checksHtml = v.failedChecks.length
    ? `<ul style="margin:0;padding-left:18px">${v.failedChecks.map((c) => `<li style="margin:0 0 4px">${htmlEscape(c)}</li>`).join('')}</ul>`
    : `<p style="margin:0">${htmlEscape(t('noAuto'))}</p>`;

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: t('eyebrow'),
      heading: t('heading', { visitor, amount: v.amount }),
      subHtml: htmlEscape(t('sub', { service })),
    }),
    emailSection({
      eyebrow: t('s1Eyebrow'),
      title: t('s1Title'),
      children: [
        reason ? emailCard({ bodyHtml: textToHtml(reason) }) : emailNote({ html: htmlEscape(t('noReason')) }),
        emailRows([
          { label: t('rowAmount'), valueHtml: htmlEscape(v.amount), strong: true },
          { label: t('rowVisitor'), valueHtml: htmlEscape(v.visitorLabel) },
          { label: t('rowEmail'), valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : htmlEscape(t('emailNone')) },
          { label: t('rowCapture'), valueHtml: htmlEscape(v.captureId) },
          { label: t('rowRequested'), valueHtml: htmlEscape(at) },
        ]),
      ].join('\n'),
    }),
    emailSection({
      eyebrow: t('s2Eyebrow'),
      title: t('s2Title'),
      children: emailCard({ bodyHtml: checksHtml }),
    }),
    emailSection({
      eyebrow: t('s3Eyebrow'),
      title: t('s3Title'),
      last: true,
      children: emailHighlightCard({
        eyebrow: t('hlEyebrow'),
        leadHtml: htmlEscape(t('hlLead')),
        bodyHtml: htmlEscape(t('hlBody')),
        cta: inbox ? { href: inbox, label: t('cta') } : null,
      }),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: t('footerLink') } : null,
      note: t('footer', { service }),
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n'), lang: v.locale ?? 'en' });
  const textLines = [
    t('textHead', { visitor, amount: v.amount }),
    '',
    t('textReason'),
    reason ?? t('textNoReason'),
    '',
    t('textAmount', { amount: v.amount }),
    t('textVisitor', { visitor: v.visitorLabel }),
    t('textEmail', { email: v.visitorEmail ?? t('emailNone') }),
    t('textCapture', { id: v.captureId }),
    t('textRequested', { at }),
    '',
    t('textChecks'),
    ...(v.failedChecks.length ? v.failedChecks.map((c) => `- ${c}`) : [`- ${t('noAuto')}`]),
  ];
  if (inbox) textLines.push('', t('textDecide', { url: inbox }));
  textLines.push('', t('textNothing'), `— ${service} · Feedloop`);
  return { subject, html, text: textLines.join('\n') };
}

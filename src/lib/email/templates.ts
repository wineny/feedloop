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

function greeting(name: string | null): string {
  return name ? `${name} 님, ` : '';
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

function linkHtml(href: string, label: string): string {
  return `<a href="${htmlEscape(href)}" style="color:${EMAIL_COLORS.brand};font-weight:700;text-decoration:none">${htmlEscape(label)}</a>`;
}

// ── 운영자 답장 ─────────────────────────────────────────

export interface OperatorReplyEmailVars {
  /** 봇의 service_name — 제목 머리·발신자 표시·푸터에 쓴다 */
  serviceName: string;
  /** 방문자가 연락처 폼에 남긴 이름 */
  recipientName: string | null;
  /** 답장 라벨 — `operator_display_name`, 없으면 `${serviceName} 팀` */
  operatorName: string;
  /** 운영자가 쓴 답장 원문(여러 줄 가능) */
  replyBody: string;
  /** 방문자의 마지막 메시지 — 무엇에 대한 답인지 상기시킨다 */
  quotedMessage: string | null;
  /** 대화를 이어갈 곳 — 위젯이 붙은 페이지(origin) 또는 서비스 URL. https 아니면 버튼 생략 */
  siteUrl: string | null;
  /** 답장 시각. 없으면 지금 */
  repliedAt?: Date;
}

export function renderOperatorReplyEmail(v: OperatorReplyEmailVars): RenderedEmail {
  const service = sanitizeSubjectText(v.serviceName) || '서비스';
  const name = cleanName(v.recipientName);
  const site = safeHttpsUrl(v.siteUrl);
  const repliedAt = formatKst(v.repliedAt ?? new Date());
  const subject = `[${service}] 남기신 피드백에 답장이 왔어요`;
  const quoted = v.quotedMessage?.trim() || null;

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: 'NEW REPLY',
      heading: `${greeting(name)}남기신 피드백에 답장이 왔어요.`,
      subHtml: `${htmlEscape(v.operatorName)}이 직접 답했어요.<br>이어서 할 이야기는 ${htmlEscape(service)} 의 대화 창에서 남겨 주세요 — 담당자에게 바로 전달됩니다.`,
    }),
    emailSection({
      eyebrow: '01 · 답장',
      title: `${v.operatorName}이 보낸 답장`,
      children: [
        emailCard({ bodyHtml: textToHtml(v.replyBody) }),
        quoted ? emailQuote({ label: '남기신 내용', bodyHtml: textToHtml(quoted) }) : '',
        emailNote({ html: `${htmlEscape(repliedAt)} 에 도착한 답장이에요.` }),
      ].join('\n'),
    }),
    emailSection({
      eyebrow: '02 · 이어서 이야기하기',
      title: '궁금한 점이 남았나요?',
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: '💬 같은 대화 창에서',
          leadHtml: '답장에 대한 질문이나 아직 그대로인 점은 대화 창에서 이어서 말씀해 주세요.',
          bodyHtml:
            '같은 대화에 기록이 남아 담당자가 앞뒤 맥락을 그대로 봅니다.<br>문제가 고쳐지면 그 소식도 이 메일로 알려드려요.',
          cta: site ? { href: site, label: `${service} 에서 대화 이어가기 →` } : null,
        }),
        emailNote({
          html: `이 메일에 답장을 보내면 담당자 메일함으로 가지만, 대화 창에 남긴 것만 기록에 남아요.`,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: site ? { href: site, label: hostLabel(site) } : null,
      note: `본 메일은 ${service} 에 남기신 피드백의 답장입니다. · Feedloop 이 대신 보냈어요`,
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n') });

  const textLines = [
    `${greeting(name)}남기신 피드백에 답장이 왔어요.`,
    '',
    `[${v.operatorName}이 보낸 답장]`,
    v.replyBody,
  ];
  if (quoted) textLines.push('', '[남기신 내용]', quoted);
  textLines.push('', `${repliedAt} 에 도착한 답장이에요.`);
  if (site) textLines.push('', `이어서 이야기하기(대화 창): ${site}`);
  textLines.push(
    '',
    '대화 창에 남긴 것만 기록에 남고, 문제가 고쳐지면 그 소식도 메일로 알려드려요.',
    `— ${service} · Feedloop`,
  );

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
}

export function renderLoopClosedEmail(v: LoopClosedEmailVars): RenderedEmail {
  const service = sanitizeSubjectText(v.serviceName) || '서비스';
  const name = cleanName(v.recipientName);
  const site = safeHttpsUrl(v.siteUrl);
  const pr = safeHttpsUrl(v.prUrl);
  const appliedAt = formatKst(v.appliedAt ?? new Date());
  const subject = `[${service}] 말씀하신 문제를 고쳤어요`;
  const prLabel = '바뀐 내용 보기 →';

  const receipt: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: '고친 내용', valueHtml: htmlEscape(v.title), strong: true },
    { label: '고친 시각', valueHtml: htmlEscape(appliedAt) },
  ];
  if (pr) receipt.push({ label: '변경 내역', valueHtml: linkHtml(pr, prLabel) });

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.partyPopper,
      eyebrow: 'FEEDBACK APPLIED',
      heading: `${greeting(name)}말씀하신 문제를 고쳤어요.`,
      subHtml: `남겨주신 피드백대로 ${htmlEscape(service)} 를 고쳤어요. 서비스에 반영되기까지는 조금 더 걸릴 수 있어요.<br>알려주셔서 고마워요 — 잘 되는지 대화 창에서 알려주세요.`,
    }),
    emailSection({
      eyebrow: '01 · 고친 내용',
      title: '무엇이 바뀌었나요',
      children: [
        emailRows(receipt),
        emailNote({ html: `같은 내용을 대화 창에서도 볼 수 있어요.` }),
      ].join('\n'),
    }),
    emailSection({
      eyebrow: '02 · 확인해 주세요',
      title: '직접 써보고 알려주세요',
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: '✅ 잘 되는지 한 번만',
          leadHtml: '바뀐 화면을 직접 확인해 보시고, 아직 그대로라면 같은 대화 창에서 알려주세요.',
          bodyHtml: '담당자가 바로 다시 봅니다. 잘 된다는 한마디도 큰 힘이 돼요.',
          cta: site ? { href: site, label: `${service} 에서 확인하기 →` } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: site ? { href: site, label: hostLabel(site) } : null,
      note: `본 메일은 ${service} 에 남기신 피드백의 처리 결과입니다. · Feedloop 이 대신 보냈어요`,
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n') });

  const textLines = [`${greeting(name)}말씀하신 문제를 고쳤어요.`, '', `[고친 내용]`, v.title, `고친 시각: ${appliedAt}`];
  if (pr) textLines.push(`변경 내역: ${pr}`);
  if (site) textLines.push('', `확인하기: ${site}`);
  textLines.push('', `아직 그대로라면 같은 대화 창에서 알려주세요.`, `— ${service} · Feedloop`);

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
  /** 방문자 표시 — 연락처 이름, 없으면 「방문자 #xxxx」 */
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
}

export function renderHandoffRequestEmail(v: HandoffRequestEmailVars): RenderedEmail {
  const service = sanitizeSubjectText(v.serviceName) || '서비스';
  const visitor = sanitizeSubjectText(v.visitorLabel) || '방문자';
  const inbox = safeHttpsUrl(v.inboxUrl);
  const page = safeHttpsUrl(v.pageUrl);
  const at = formatKst(v.requestedAt ?? new Date());
  const notFixed = v.kind === 'not_fixed';
  const subject = notFixed
    ? `[${service}] 고쳤다고 보냈는데 아직이래요 · ${visitor}`
    : `[${service}] 상담원 연결 요청 · ${visitor}`;
  const request = v.requestBody?.trim() || null;

  const facts: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: '방문자', valueHtml: htmlEscape(v.visitorLabel), strong: true },
    { label: '이메일', valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : '남기지 않음(답장은 위젯으로만)' },
    { label: '요청 시각', valueHtml: htmlEscape(at) },
  ];
  if (v.pageUrl) facts.push({ label: '페이지', valueHtml: page ? linkHtml(page, hostLabel(page)) : htmlEscape(v.pageUrl) });

  const turnsHtml = v.recentTurns.length
    ? v.recentTurns
        .map((t) => `<p style="margin:0 0 8px"><b style="color:${EMAIL_COLORS.ink}">${htmlEscape(t.who)}</b> · ${textToHtml(t.body)}</p>`)
        .join('')
    : '';

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: notFixed ? 'NOT FIXED' : 'HANDOFF REQUEST',
      heading: notFixed
        ? `${v.visitorLabel} 님이 아직 안 고쳐졌대요.`
        : `${v.visitorLabel} 님이 상담원을 찾아요.`,
      subHtml: notFixed
        ? `${htmlEscape(service)}에서 「반영됐어요」를 보냈는데 <b>아직 그대로</b>라는 답이 왔어요.<br>그 묶음은 <b>후속 확인 대상</b>이라 새 PR 이 보류돼 있어요 — 「대화」에서 방문자에게 답하고 무엇이 남았는지 확인해 주세요.`
        : `${htmlEscape(service)} 위젯에서 「상담원 연결」을 눌렀어요.<br>AI 가 아니라 사람의 답을 기다리는 중이에요 — 「대화」에서 답장하면 위젯${v.visitorEmail ? '과 이메일' : ''}로 바로 전달됩니다.`,
    }),
    emailSection({
      eyebrow: '01 · 남긴 말',
      // 「처음 말한 문제」가 아니다 — not_fixed 경로는 requestBody 가 비어 있어 발송기가
      // «최근 8턴 중 마지막 방문자 발화»를 채운다(notify.ts 의 fallbackQuote). 제목이 그걸 말해야 한다.
      title: notFixed ? '방문자가 남긴 마지막 말' : '방문자가 상담원에게 남긴 말',
      children: [
        request
          ? emailCard({ bodyHtml: textToHtml(request) })
          : emailNote({
              html: notFixed
                ? '남긴 말이 없어요. 아래 최근 대화에서 원래 제보를 봐 주세요.'
                : '따로 남긴 말 없이 버튼만 눌렀어요. 아래 최근 대화를 봐 주세요.',
            }),
        v.summary ? emailQuote({ label: 'AI 요약', bodyHtml: textToHtml(v.summary) }) : '',
      ].join('\n'),
    }),
    emailSection({
      eyebrow: '02 · 맥락',
      title: '최근 대화',
      children: [turnsHtml ? emailCard({ bodyHtml: turnsHtml }) : emailNote({ html: '이전 대화가 없어요.' }), emailRows(facts)].join('\n'),
    }),
    emailSection({
      eyebrow: '03 · 답장하기',
      title: '「대화」에서 답장해 주세요',
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: '💬 Feedloop 대화',
          leadHtml: '답장은 이 메일에 회신하지 말고 Feedloop 「대화」 탭에서 남겨 주세요.',
          bodyHtml: '거기서 보낸 답장만 방문자 위젯에 도착하고 기록에 남아요. 답장하면 「담당자 확인 필요」 배지도 내려갑니다.',
          cta: inbox ? { href: inbox, label: '대화에서 답장하기 →' } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: 'Feedloop 대화' } : null,
      note: notFixed
        ? `본 메일은 ${service} 봇 소유자에게 가는 「아직 해결 안 됨」 알림입니다. · Feedloop`
        : `본 메일은 ${service} 봇 소유자에게 가는 상담원 연결 알림입니다. · Feedloop`,
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n') });

  const textLines = [
    notFixed
      ? `${v.visitorLabel} 님이 「아직 그대로예요」라고 알려줬어요.`
      : `${v.visitorLabel} 님이 상담원을 찾아요.`,
    '',
  ];
  textLines.push(notFixed ? '[남긴 마지막 말]' : '[남긴 말]', request ?? '(따로 남긴 말 없음)');
  if (v.summary) textLines.push('', '[AI 요약]', v.summary);
  if (v.recentTurns.length) {
    textLines.push('', '[최근 대화]');
    for (const t of v.recentTurns) textLines.push(`${t.who}: ${t.body}`);
  }
  textLines.push('', `방문자: ${v.visitorLabel}`, `이메일: ${v.visitorEmail ?? '남기지 않음'}`, `요청 시각: ${at}`);
  if (v.pageUrl) textLines.push(`페이지: ${v.pageUrl}`);
  if (inbox) textLines.push('', `대화에서 답장하기: ${inbox}`);
  textLines.push('', '이 메일에 회신하지 말고 Feedloop 「대화」에서 답장해 주세요.', `— ${service} · Feedloop`);

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
  /** 방문자 표시 — 연락처 이름, 없으면 「방문자 #xxxx」 */
  visitorLabel: string;
  visitorEmail: string | null;
  /** 방문자가 처음 남긴 말(칩만 누른 건 제외한 첫 «진짜» 메시지) */
  firstMessage: string;
  /** 대화가 열린 페이지(origin). https 아니면 텍스트로만 */
  pageUrl: string | null;
  /** Feedloop 「대화」 딥링크. 없으면 버튼 생략 */
  inboxUrl: string | null;
  receivedAt?: Date;
}

/** 제목에 실을 첫 메시지 조각. 길면 자르고 「…」. */
function subjectSnippet(text: string, max = 28): string {
  const t = sanitizeSubjectText(text);
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

export function renderNewConversationEmail(v: NewConversationEmailVars): RenderedEmail {
  const service = sanitizeSubjectText(v.serviceName) || '서비스';
  const visitor = sanitizeSubjectText(v.visitorLabel) || '방문자';
  const inbox = safeHttpsUrl(v.inboxUrl);
  const page = safeHttpsUrl(v.pageUrl);
  const at = formatKst(v.receivedAt ?? new Date());
  const first = v.firstMessage.trim();
  const subject = `[${service}] 새 대화 · ${visitor} 「${subjectSnippet(first)}」`;

  const facts: { label: string; valueHtml: string; strong?: boolean }[] = [
    { label: '방문자', valueHtml: htmlEscape(v.visitorLabel), strong: true },
    { label: '이메일', valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : '아직 남기지 않음' },
    { label: '들어온 시각', valueHtml: htmlEscape(at) },
  ];
  if (v.pageUrl) facts.push({ label: '페이지', valueHtml: page ? linkHtml(page, hostLabel(page)) : htmlEscape(v.pageUrl) });

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: 'NEW CONVERSATION',
      heading: `${v.visitorLabel} 님이 대화를 시작했어요.`,
      subHtml:
        `${htmlEscape(service)} 위젯에 새 방문자가 첫 말을 남겼어요. AI 답변과 이어지는 대화는 「대화」 탭에 있어요.<br>` +
        `이 메일은 <b>대화가 새로 열릴 때 한 번만</b> 와요 — 이어지는 말은 「대화」에서 보세요.`,
    }),
    emailSection({
      eyebrow: '01 · 첫 메시지',
      title: '방문자가 처음 남긴 말',
      children: [emailCard({ bodyHtml: textToHtml(first) }), emailRows(facts)].join('\n'),
    }),
    emailSection({
      eyebrow: '02 · 이어서 보기',
      title: '대화는 「대화」 탭에서',
      last: true,
      children: [
        emailHighlightCard({
          eyebrow: '💬 Feedloop 대화',
          leadHtml: '답장이 필요하면 Feedloop 「대화」 탭에서 남겨 주세요. 이 메일에 회신해도 방문자에게 가지 않아요.',
          bodyHtml:
            'AI 가 답을 못 하면 「담당자 확인 필요」 배지가 켜지고, 방문자가 「상담원 연결」을 누르면 그때 따로 메일이 와요.',
          cta: inbox ? { href: inbox, label: '대화 열기 →' } : null,
        }),
      ].join('\n'),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: 'Feedloop 대화' } : null,
      note: `본 메일은 ${service} 봇 소유자에게 가는 새 대화 알림입니다. 대화마다 한 번만 보내요. · Feedloop`,
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n') });

  const textLines = [
    `${v.visitorLabel} 님이 ${service} 위젯에서 대화를 시작했어요.`,
    '',
    '[처음 남긴 말]',
    first,
    '',
    `방문자: ${v.visitorLabel}`,
    `이메일: ${v.visitorEmail ?? '아직 남기지 않음'}`,
    `들어온 시각: ${at}`,
  ];
  if (v.pageUrl) textLines.push(`페이지: ${v.pageUrl}`);
  if (inbox) textLines.push('', `대화 열기: ${inbox}`);
  textLines.push('', '이 메일은 대화가 새로 열릴 때 한 번만 와요. 답장은 Feedloop 「대화」에서 남겨 주세요.', service === 'Feedloop' ? '— Feedloop' : `— ${service} · Feedloop`);

  return { subject, html, text: textLines.join('\n') };
}

// ── Refund approval request (bot owner) ─────────────────────────────────────
//
// Stage 3 (design v2 §4): a visitor asked the widget for a refund and the guardrail did not let it
// run automatically — the row is `pending` and waits in the inbox. One mail per pending action,
// English like the rest of the payment feature (§10). The decision itself is taken in the inbox
// (approve / reject); this mail carries the facts and the deep link, never a decision button.

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
}

export function renderRefundApprovalEmail(v: RefundApprovalEmailVars): RenderedEmail {
  const service = sanitizeSubjectText(v.serviceName) || 'your store';
  const visitor = sanitizeSubjectText(v.visitorLabel) || 'A visitor';
  const inbox = safeHttpsUrl(v.inboxUrl);
  const at = formatKstEnglish(v.requestedAt ?? new Date());
  const subject = `[${service}] Refund approval needed · ${v.amount} · ${visitor}`;
  const reason = v.reason?.trim() || null;

  const checksHtml = v.failedChecks.length
    ? `<ul style="margin:0;padding-left:18px">${v.failedChecks.map((c) => `<li style="margin:0 0 4px">${htmlEscape(c)}</li>`).join('')}</ul>`
    : '<p style="margin:0">Automatic refunds are switched off for this store.</p>';

  const rows = [
    emailHero({
      imageUrl: FLUENT_3D.speechBalloon,
      eyebrow: 'REFUND APPROVAL',
      heading: `${visitor} is asking for a ${v.amount} refund.`,
      subHtml: `The refund did not meet ${htmlEscape(service)}'s automatic-refund rules, so it is <b>waiting for you</b> in the Feedloop inbox. Nothing has been sent to PayPal.`,
    }),
    emailSection({
      eyebrow: '01 · Request',
      title: 'What the visitor said',
      children: [
        reason ? emailCard({ bodyHtml: textToHtml(reason) }) : emailNote({ html: 'No reason was given.' }),
        emailRows([
          { label: 'Amount', valueHtml: htmlEscape(v.amount), strong: true },
          { label: 'Visitor', valueHtml: htmlEscape(v.visitorLabel) },
          { label: 'Email', valueHtml: v.visitorEmail ? htmlEscape(v.visitorEmail) : 'not left' },
          { label: 'PayPal capture', valueHtml: htmlEscape(v.captureId) },
          { label: 'Requested', valueHtml: htmlEscape(at) },
        ]),
      ].join('\n'),
    }),
    emailSection({
      eyebrow: '02 · Why it waits',
      title: 'Checks that did not pass',
      children: emailCard({ bodyHtml: checksHtml }),
    }),
    emailSection({
      eyebrow: '03 · Decide',
      title: 'Approve or reject in the inbox',
      last: true,
      children: emailHighlightCard({
        eyebrow: '💬 Feedloop inbox',
        leadHtml: 'Open the conversation and use the Approve / Reject buttons on the refund card.',
        bodyHtml: 'Approving sends the refund to PayPal with the exact amount above. Rejecting tells the visitor in the widget. Either way this request can only be decided once.',
        cta: inbox ? { href: inbox, label: 'Open the conversation →' } : null,
      }),
    }),
    emailFooter({
      link: inbox ? { href: inbox, label: 'Feedloop inbox' } : null,
      note: `This mail goes to the owner of the ${service} bot when a refund needs a person. · Feedloop`,
    }),
  ];

  const html = emailShell({ title: subject, children: rows.join('\n') });
  const textLines = [
    `${v.visitorLabel} is asking for a ${v.amount} refund.`,
    '',
    '[Reason]',
    reason ?? '(none given)',
    '',
    `Amount: ${v.amount}`,
    `Visitor: ${v.visitorLabel}`,
    `Email: ${v.visitorEmail ?? 'not left'}`,
    `PayPal capture: ${v.captureId}`,
    `Requested: ${at}`,
    '',
    '[Checks that did not pass]',
    ...(v.failedChecks.length ? v.failedChecks.map((c) => `- ${c}`) : ['- Automatic refunds are switched off for this store.']),
  ];
  if (inbox) textLines.push('', `Decide in the inbox: ${inbox}`);
  textLines.push('', 'Nothing has been sent to PayPal. Approve or reject on the refund card in the Feedloop inbox.', `— ${service} · Feedloop`);
  return { subject, html, text: textLines.join('\n') };
}

/** "Oct 21, 2026, 10:00 KST" — the English payment mails keep the owner's time zone but not the Korean wording. */
function formatKstEnglish(d: Date): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(d)} KST`;
}

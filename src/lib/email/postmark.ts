// Postmark 발송기 — 이 앱의 유일한 메일 트랜스포트.
//
// rona_practice 의 `src/lib/email/send.ts` 와 같은 모양(Postmark 기본, 결과는 throw 대신
// `{ ok }` 로). 발신 주소 `feedloop@rona.so` 는 rona.so 가 Postmark 에 **도메인 단위**로
// 검증돼 있어 새 서명 없이 통과한다(2026-09-12 블랙홀 주소로 실측). Feedloop 전용 서버를
// 나중에 만들면 `POSTMARK_SERVER_TOKEN` 만 갈아끼우면 된다 — 코드는 서버를 모른다.
//
// 절대 throw 하지 않는다. 답장 저장이 끝난 뒤에 불리므로, 메일이 실패해도 답장은 이미
// 위젯에 가 있다. 실패는 결과로 돌려주고 호출부가 `responses.email_error` 에 적는다.

import { ServerClient } from 'postmark';

/** 기본 발신 주소. 표시 이름은 호출부가 서비스 이름으로 채운다. */
const DEFAULT_FROM_ADDRESS = 'feedloop@rona.so';

/** Postmark 왕복 상한(초). 답장 라우트 안에서 기다리므로 짧게 둔다. */
const TIMEOUT_SEC = 10;

export function isEmailConfigured(): boolean {
  return Boolean(process.env.POSTMARK_SERVER_TOKEN?.trim());
}

export function fromAddress(): string {
  return process.env.EMAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS;
}

/**
 * `"표시 이름" <주소>` — 표시 이름에 든 따옴표·개행은 지운다(헤더 인젝션·파싱 깨짐 방지).
 * 서비스 이름이 그대로 발신자로 보이면 방문자가 「널널투어가 보냈다」로 읽고, 실제 주소가
 * feedloop@ 라 «via Feedloop» 를 이름에 붙여 누가 대신 보냈는지 드러낸다.
 */
export function formatFrom(displayName: string): string {
  const name = displayName.replace(/["\r\n]/g, '').replace(/\s+/g, ' ').trim();
  const label = name ? `${name} via Feedloop` : 'Feedloop';
  return `"${label}" <${fromAddress()}>`;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** 발신자 표시 이름(서비스 이름). 주소는 고정이다 */
  fromName: string;
  /** 방문자가 회신하면 갈 곳 — 봇 소유자(운영자) 이메일 */
  replyTo?: string | null;
  /** Postmark 태그 — 활동 화면에서 종류별로 거른다 */
  tag: 'operator-reply' | 'loop-closed' | 'handoff-request' | 'new-conversation';
  metadata?: Record<string, string>;
}

export type SendEmailResult = { ok: true; id: string } | { ok: false; error: string; uncertain?: boolean };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const token = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (!token) return { ok: false, error: 'POSTMARK_SERVER_TOKEN is not set' };

  try {
    const client = new ServerClient(token, { timeout: TIMEOUT_SEC });
    const res = await client.sendEmail({
      From: formatFrom(input.fromName),
      To: input.to,
      ReplyTo: input.replyTo ?? undefined,
      Subject: input.subject,
      HtmlBody: input.html,
      TextBody: input.text,
      MessageStream: 'outbound',
      Tag: input.tag,
      // 열람·링크 추적은 켜지 않는다 — 방문자 메일이고, 추적 픽셀은 스팸 점수만 올린다.
      TrackOpens: false,
      Metadata: input.metadata,
    });
    return { ok: true, id: res.MessageID };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as {statusCode?:number})?.statusCode;
    return { ok: false, error: message, uncertain: !(status && status >= 400 && status < 500 && status !== 408) };
  }
}

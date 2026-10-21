import { describe, it, expect, vi, beforeEach } from 'vitest';

// 테이블별 첫 행을 돌려주는 Supabase 모킹(loop-closed.test 과 같은 모양).
const tables: Record<string, unknown[]> = {};
const updated: { table: string; patch: Record<string, unknown> }[] = [];

function chain(table: string) {
  const c: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'is', 'not', 'order', 'limit']) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn(async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }));
  c.then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
  return c;
}

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc: vi.fn(async () => ({data:claimAllowed,error:null})),
    from: vi.fn((table: string) => ({
      select: vi.fn(() => chain(table)),
      update: vi.fn((patch: Record<string, unknown>) => {
        updated.push({ table, patch });
        return chain(table);
      }),
    })),
  }),
}));

// Postmark 는 부르지 않는다 — 무엇을 보내려 했는지만 잡는다.
let claimAllowed = true;
const sent: Record<string, unknown>[] = [];
let sendResult: { ok: true; id: string } | { ok: false; error: string; uncertain?:boolean } = { ok: true, id: 'pm-1' };
vi.mock('@/lib/email/postmark', () => ({
  isEmailConfigured: () => Boolean(process.env.POSTMARK_SERVER_TOKEN),
  sendEmail: vi.fn(async (input: Record<string, unknown>) => {
    sent.push(input);
    return sendResult;
  }),
}));

type Mod = typeof import('@/lib/email/notify');
let mod: Mod;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of Object.keys(tables)) delete tables[k];
  updated.length = 0;
  sent.length = 0;
  claimAllowed = true;
  sendResult = { ok: true, id: 'pm-1' };
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
  vi.resetModules();
  mod = await import('@/lib/email/notify');
});

function seedHappyPath() {
  tables.responses = [{ email_sent_at: null }];
  tables.conversations = [{ contact_email: 'visitor@example.com', contact_name: '누리' }];
  tables.bots = [
    {
      service_name: '널널투어',
      service_url: 'https://nulnul.vercel.app',
      operator_display_name: null,
      user_id: 'u1',
    },
  ];
  tables.users = [{ email: 'owner@example.com' }];
  // origin 과 마지막 메시지 둘 다 messages 에서 읽는다
  tables.messages = [{ origin: 'https://nulnul.vercel.app/coupons', body: '쿠폰 버튼이 안 눌려요' }];
}

const OPERATOR = {
  kind: 'operator' as const,
  responseId: 'r1',
  conversationId: 'c1',
  botId: 'b1',
  body: '고쳤어요',
};

describe('emailResponse — 운영자 답장', () => {
  it('이메일을 남긴 방문자에게 보내고, 회신처는 운영자, 발신 이름은 서비스 이름이다', async () => {
    seedHappyPath();
    const out = await mod.emailResponse(OPERATOR);

    expect(out).toEqual({ sent: true, to: 'visitor@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'visitor@example.com',
      replyTo: 'owner@example.com',
      fromName: '널널투어',
      tag: 'operator-reply',
      subject: '[널널투어] 남기신 피드백에 답장이 왔어요',
    });
    expect(String(sent[0].html)).toContain('고쳤어요');
    expect(String(sent[0].html)).toContain('쿠폰 버튼이 안 눌려요');
    // 대화를 이어갈 곳은 위젯이 붙어 있던 페이지(origin)
    expect(String(sent[0].html)).toContain('href="https://nulnul.vercel.app/coupons"');
    // 운영자 이름이 없으면 「서비스 팀」
    expect(String(sent[0].html)).toContain('널널투어 팀');

    const mark = updated.find((u) => u.table === 'responses');
    expect(mark?.patch).toMatchObject({ email_message_id: 'pm-1', email_error: null });
    expect(mark?.patch.email_sent_at).toBeTruthy();
  });

  it('메일 언어는 대화에 저장된 언어(conversations.locale)를 따른다 — 서비스·운영자 이름 폴백도 그 언어', async () => {
    seedHappyPath();
    tables.conversations = [{ contact_email: 'visitor@example.com', contact_name: 'Mina', locale: 'en', source: 'web' }];
    tables.bots = [{ service_name: 'Nulnul Tours', service_url: 'https://nulnul.vercel.app', operator_display_name: null, user_id: 'u1' }];
    await mod.emailResponse({ ...OPERATOR, body: 'Fixed it' });
    expect(sent[0]).toMatchObject({ subject: '[Nulnul Tours] You have a reply to your feedback' });
    expect(String(sent[0].html)).toContain('Nulnul Tours team');
    expect(String(sent[0].html)).toContain('<html lang="en">');
  });

  it('locale 이 NULL 이면 카카오·채널톡은 ko, 웹은 본문에 한글이 있을 때만 ko', () => {
    expect(mod.visitorMailLocale({ locale: 'en', source: 'kakao' })).toBe('en');
    expect(mod.visitorMailLocale({ locale: null, source: 'kakao' }, 'hello')).toBe('ko');
    expect(mod.visitorMailLocale({ locale: null, source: 'channel' })).toBe('ko');
    expect(mod.visitorMailLocale({ locale: null, source: 'web' }, '쿠폰')).toBe('ko');
    expect(mod.visitorMailLocale({ locale: null, source: 'web' }, 'coupon')).toBe('en');
    expect(mod.visitorMailLocale({})).toBe('en');
  });

  it('이메일을 안 남긴 대화면 아무것도 보내지 않는다', async () => {
    seedHappyPath();
    tables.conversations = [{ contact_email: null, contact_name: '누리' }];

    const out = await mod.emailResponse(OPERATOR);
    expect(out).toEqual({ sent: false, reason: 'no_email' });
    expect(sent).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('이미 보낸 응답은 다시 보내지 않는다 — 되돌림 크론은 반복 실행된다', async () => {
    seedHappyPath();
    tables.responses = [{ email_sent_at: '2026-09-12T00:00:00Z' }];

    const out = await mod.emailResponse(OPERATOR);
    expect(out).toEqual({ sent: false, reason: 'already_sent' });
    expect(sent).toHaveLength(0);
  });

  it('토큰이 없으면 조회조차 하지 않고 not_configured', async () => {
    seedHappyPath();
    delete process.env.POSTMARK_SERVER_TOKEN;

    const out = await mod.emailResponse(OPERATOR);
    expect(out).toEqual({ sent: false, reason: 'not_configured' });
    expect(sent).toHaveLength(0);
  });

  it('Postmark 가 실패하면 throw 하지 않고 사유를 responses.email_error 에 적는다', async () => {
    seedHappyPath();
    sendResult = { ok: false, error: 'Inactive recipient', uncertain:false };

    const out = await mod.emailResponse(OPERATOR);
    expect(out).toEqual({ sent: false, reason: 'send_failed' });
    const mark = updated.find((u) => u.table === 'responses');
    expect(mark?.patch).toEqual({ email_error: 'Inactive recipient', email_delivery_status:'failed' });
  });

  it('운영자 이메일을 못 읽어도 메일은 나간다 — Reply-To 만 빠진다', async () => {
    seedHappyPath();
    tables.users = [];

    const out = await mod.emailResponse(OPERATOR);
    expect(out.sent).toBe(true);
    expect(sent[0].replyTo).toBeNull();
  });
});

describe('emailResponse — 되돌림', () => {
  it('제목·PR 링크를 싣고, origin 이 없으면 서비스 URL 로 안내한다(카카오 대화)', async () => {
    seedHappyPath();
    tables.messages = [];

    const out = await mod.emailResponse({
      kind: 'loop_closed',
      responseId: 'r2',
      conversationId: 'c1',
      botId: 'b1',
      title: '쿠폰 적용 버튼이 눌리지 않음',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
    });

    expect(out.sent).toBe(true);
    expect(sent[0]).toMatchObject({
      tag: 'loop-closed',
      subject: '[널널투어] 말씀하신 문제를 고쳤어요',
    });
    expect(String(sent[0].html)).toContain('쿠폰 적용 버튼이 눌리지 않음');
    expect(String(sent[0].html)).toContain('href="https://github.com/o/r/pull/12"');
    expect(String(sent[0].html)).toContain('href="https://nulnul.vercel.app"');
  });
});

describe('describeReplyDelivery', () => {
  it('웹 + 메일 성공 → 메일 주소를 말한다', () => {
    expect(mod.describeReplyDelivery(true, { sent: true, to: 'a@b.c' }, 'ko')).toBe('이메일(a@b.c)로도 보냈어요.');
    expect(mod.describeReplyDelivery(true, { sent: true, to: 'a@b.c' })).toBe('Also sent by email to a@b.c.');
  });

  it('웹 + 이메일 없음 → 아무 말도 안 한다(위젯 즉시 전달은 화면의 고정 문구가 말한다)', () => {
    expect(mod.describeReplyDelivery(true, { sent: false, reason: 'no_email' })).toBeNull();
  });

  it('웹 + 발송 실패 → 위젯에는 갔다고 정확히 말한다', () => {
    expect(mod.describeReplyDelivery(true, { sent: false, reason: 'send_failed' }, 'ko')).toBe(
      '위젯에는 전달됐지만 이메일 발송은 실패했어요.',
    );
    expect(mod.describeReplyDelivery(true, { sent: false, reason: 'send_failed' })).toBe('Delivered to the widget, but sending the email failed.');
  });

  it('카카오 + 메일 성공 → 카카오는 대기, 메일은 지금', () => {
    const s = mod.describeReplyDelivery(false, { sent: true, to: 'a@b.c' }, 'ko');
    expect(s).toContain('다음에 메시지를 보낼 때 전달됩니다.');
    expect(s).toContain('이메일(a@b.c)로는 지금 보냈어요.');
  });

  it('카카오 + 이메일 없음 → 종전 카카오 안내 그대로', () => {
    expect(mod.describeReplyDelivery(false, { sent: false, reason: 'no_email' }, 'ko')).toBe(
      '카카오는 먼저 말을 걸 수 없어, 이 답장은 상대가 다음에 메시지를 보낼 때 전달됩니다.',
    );
  });
});

it('uncertain dispatch is held without sending again',async()=>{
 seedHappyPath(); claimAllowed=false;
 expect(await mod.emailResponse(OPERATOR)).toEqual({sent:false,reason:'delivery_unknown'});
 expect(sent).toHaveLength(0);
});
it('timeout records unknown delivery, not a retryable rejection',async()=>{
 seedHappyPath();sendResult={ok:false,error:'timeout',uncertain:true};
 expect(await mod.emailResponse(OPERATOR)).toEqual({sent:false,reason:'delivery_unknown'});
 expect(updated.at(-1)?.patch.email_delivery_status).toBe('delivery_unknown');
});

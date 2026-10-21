import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

// ── 「상담원 연결」 (백로그 B2 v2) ──────────────────────────
//
// 무인증 라우트라 위젯 라우트의 공용 관문(readJsonBody·isUuid·checkWriteRate·resolveWidgetBot)을
// 그대로 탄다. 여기서는 대화 계층·메일을 가짜로 두고 «상태가 찍히는지·내용이 저장되는지·안내가
// 언제 쌓이는지·소유자 메일이 나가는지»를 본다.

const {
  resolveWidgetBot,
  checkWriteRate,
  findWebConversation,
  upsertConversation,
  saveWebMessage,
  saveContact,
  touchConversation,
  getRecentTurns,
  hasFreshEscalationNotice,
  markHandoffRequested,
  saveConversationResponse,
  getTimeline,
  emailOwnerHandoff,
  after,
} = vi.hoisted(() => ({
  resolveWidgetBot: vi.fn(),
  checkWriteRate: vi.fn(),
  findWebConversation: vi.fn(),
  upsertConversation: vi.fn(),
  saveWebMessage: vi.fn(),
  saveContact: vi.fn(),
  touchConversation: vi.fn(),
  getRecentTurns: vi.fn(),
  hasFreshEscalationNotice: vi.fn(),
  markHandoffRequested: vi.fn(),
  saveConversationResponse: vi.fn(),
  getTimeline: vi.fn(),
  emailOwnerHandoff: vi.fn(),
  after: vi.fn((p: unknown) => p),
}));

vi.mock('@/lib/widget/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/widget/http')>();
  return { ...actual, resolveWidgetBot, checkWriteRate };
});
vi.mock('@/lib/bot/conversations', () => ({
  findWebConversation,
  upsertConversation,
  saveWebMessage,
  saveContact,
  touchConversation,
  getRecentTurns,
  hasFreshEscalationNotice,
  markHandoffRequested,
  saveConversationResponse,
  getTimeline,
}));
vi.mock('@/lib/email/notify', () => ({ emailOwnerHandoff }));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after };
});

const BOT_ID = '11111111-1111-4111-8111-111111111111';
const VISITOR = '22222222-2222-4222-8222-222222222222';

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    bot_id: BOT_ID,
    source: 'web',
    external_user_id: VISITOR,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    escalated_at: null,
    handoff_requested_at: null,
    messageCount: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveWidgetBot.mockResolvedValue({ id: BOT_ID, service_name: '널널투어', status: 'active', status_text: '보통 몇 분 안에 답해요' });
  checkWriteRate.mockResolvedValue(null);
  findWebConversation.mockResolvedValue(conversation());
  upsertConversation.mockResolvedValue(conversation());
  saveWebMessage.mockResolvedValue('msg-9');
  saveContact.mockResolvedValue(true);
  touchConversation.mockResolvedValue(undefined);
  getRecentTurns.mockResolvedValue([{ id: 'm1', kind: 'user', body: '쿠폰함이 안 열려요', at: 't' }]);
  // 기본은 «AI 답변이 마지막»인 대화 — 안내 칩이 새로 붙어야 하는 상황
  hasFreshEscalationNotice.mockResolvedValue(false);
  markHandoffRequested.mockResolvedValue(true);
  saveConversationResponse.mockResolvedValue('resp-1');
  getTimeline.mockResolvedValue([{ id: 'resp-1', kind: 'notice', body: 'x', at: '2026-09-13T00:00:00Z' }]);
  emailOwnerHandoff.mockResolvedValue({ sent: true, to: 'owner@example.com' });
});

async function post(body: unknown, botId = BOT_ID, locale: 'ko' | 'en' = 'ko') {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/widget/[botId]/escalate/route');
  const req = new NextRequest(`https://feedloop.test/api/widget/${botId}/escalate?locale=${locale}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://nulnul.vercel.app' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ botId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

const savedNotice = () => saveConversationResponse.mock.calls[0][0] as Record<string, unknown>;

describe('POST /api/widget/[botId]/escalate — 관문', () => {
  it('없는 봇이면 404 — 아무것도 찍지 않는다', async () => {
    resolveWidgetBot.mockResolvedValue(null);
    const { status } = await post({ visitorId: VISITOR });
    expect(status).toBe(404);
    expect(markHandoffRequested).not.toHaveBeenCalled();
  });

  it('visitorId 가 UUID 가 아니면 400', async () => {
    for (const bad of [{ visitorId: 'nope' }, {}, { visitorId: 42 }]) {
      const { status } = await post(bad);
      expect(status).toBe(400);
    }
    expect(findWebConversation).not.toHaveBeenCalled();
  });

  it('깨진 JSON 은 400', async () => {
    const { status } = await post('{not json');
    expect(status).toBe(400);
  });

  it('이메일 형식이 틀리면 400 — 저장 전에 거른다', async () => {
    const { status, body } = await post({ visitorId: VISITOR, text: '환불 문의', email: 'not-an-email' });
    expect(status).toBe(400);
    expect(body.error).toContain('이메일');
    expect(upsertConversation).not.toHaveBeenCalled();
  });

  it('속도 제한에 걸리면 그 응답을 그대로 돌려준다', async () => {
    const { widgetError } = await import('@/lib/widget/http');
    checkWriteRate.mockResolvedValue(widgetError('잠시 후', 429));
    const { status } = await post({ visitorId: VISITOR, text: '환불 문의' });
    expect(status).toBe(429);
    expect(upsertConversation).not.toHaveBeenCalled();
  });
});

describe('POST /api/widget/[botId]/escalate — 말을 남기는 경로', () => {
  it('locale=en 이면 안내 칩이 영어이고, 상태 문구가 없을 때 영어 기본 문구를 쓴다', async () => {
    resolveWidgetBot.mockResolvedValue({ id: BOT_ID, service_name: 'Nulnul', status: 'active', status_text: null });
    const { status } = await post({ visitorId: VISITOR, text: 'How do I get a refund?' }, BOT_ID, 'en');
    expect(status).toBe(200);
    const n = savedNotice();
    expect(n.body).toBe(
      '"How do I get a refund?" was passed to a person.' +
        ' Usually replies in a few minutes. We\'ll let you know here when they reply 🙏',
    );
  });

  it('메시지를 handoff 로 저장하고(AI 답 없음), 상태를 찍고, 인용 칩을 남기고, 소유자에게 메일을 보낸다', async () => {
    const { status, body, res } = await post({ visitorId: VISITOR, text: '환불은 어떻게 하나요?' });

    expect(status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // 내용이 있으면 대화를 만들어도 된다 — 운영자가 받을 말이 있다
    expect(upsertConversation).toHaveBeenCalledTimes(1);
    const msg = saveWebMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg).toMatchObject({ text: '환불은 어떻게 하나요?', handoff: true, origin: 'https://nulnul.vercel.app' });
    expect(msg).toHaveProperty('context');
    expect(markHandoffRequested).toHaveBeenCalledWith('conv-1');
    // 안내 칩은 «무엇을» 넘겼는지 인용하고, 기대치(status_text)를 싣고, 이메일이 없으면 「여기로」
    const n = savedNotice();
    expect(n.responseType).toBe('system');
    expect(n.triggerMessageId).toBe('msg-9');
    expect(n.body).toContain('"환불은 어떻게 하나요?" 를 상담원에게 전달했어요');
    expect(n.body).toContain('보통 몇 분 안에 답해요');
    expect(n.body).not.toContain('이메일');
    // 소유자 알림은 after() — 응답을 기다리게 하지 않는다
    expect(emailOwnerHandoff).toHaveBeenCalledWith({ botId: BOT_ID, conversationId: 'conv-1', requestBody: '환불은 어떻게 하나요?' });
    expect(after).toHaveBeenCalled();
    // 응답은 증분(커서) — 전량이 아니다
    expect(getTimeline).toHaveBeenCalledWith('conv-1', expect.any(String));
    expect(body).toMatchObject({ conversationId: 'conv-1', escalated: true, already: false });
  });

  it('이름·이메일을 같이 남기면 연락처를 저장하고 「여기와 이메일로」 약속한다', async () => {
    await post({ visitorId: VISITOR, text: '환불', name: '홍길동', email: 'v@example.com' });
    expect(saveContact).toHaveBeenCalledWith('conv-1', { name: '홍길동', email: 'v@example.com' });
    expect(savedNotice().body).toContain('여기와 이메일로');
    expect((saveWebMessage.mock.calls[0][0] as Record<string, unknown>).authorName).toBe('홍길동');
  });

  it('말을 남긴 경로는 직전 칩이 유효해도 새 칩을 붙인다 — 새 내용이다', async () => {
    findWebConversation.mockResolvedValue(conversation({ escalated_at: '2026-09-13T00:00:00Z', handoff_requested_at: '2026-09-13T00:00:00Z' }));
    upsertConversation.mockResolvedValue(conversation({ escalated_at: '2026-09-13T00:00:00Z', handoff_requested_at: '2026-09-13T00:00:00Z' }));
    hasFreshEscalationNotice.mockResolvedValue(true);
    const { body } = await post({ visitorId: VISITOR, text: '아직 답이 없어요' });
    expect(markHandoffRequested).not.toHaveBeenCalled();
    expect(saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ already: true });
  });

  it('메시지 저장에 실패하면 500 — 상태를 찍지 않는다', async () => {
    saveWebMessage.mockResolvedValue(null);
    const { status } = await post({ visitorId: VISITOR, text: '환불' });
    expect(status).toBe(500);
    expect(markHandoffRequested).not.toHaveBeenCalled();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
    // I-29 근본 원인 — 저장이 안 됐으면 last_message_at 도 안 올린다
    expect(touchConversation).not.toHaveBeenCalled();
  });

  it('말을 남긴 경로도 저장이 성공한 «뒤에» last_message_at 을 올린다 (I-29)', async () => {
    const order: string[] = [];
    saveWebMessage.mockImplementation(async () => {
      order.push('save');
      return 'msg-9';
    });
    touchConversation.mockImplementation(async () => {
      order.push('touch');
    });
    const { status } = await post({ visitorId: VISITOR, text: '환불이 안 돼요' });
    expect(status).toBe(200);
    expect(touchConversation).toHaveBeenCalledTimes(1);
    expect(touchConversation).toHaveBeenCalledWith('conv-1');
    expect(order).toEqual(['save', 'touch']);
  });

  it('긴 인용은 60자에서 자른다 — 코드포인트 단위라 이모지가 안 깨진다', async () => {
    await post({ visitorId: VISITOR, text: '가'.repeat(100) });
    expect(savedNotice().body).toContain(`"${'가'.repeat(60)}…" 를`);
    vi.clearAllMocks();
    saveConversationResponse.mockResolvedValue('resp-2');
    await post({ visitorId: VISITOR, text: '🙏'.repeat(61) });
    expect(savedNotice().body).toContain(`"${'🙏'.repeat(60)}…" 를`);
  });
});

describe('POST /api/widget/[botId]/escalate — 버튼만 누른 경로', () => {
  it('한 마디도 안 한 방문자는 400 — 대화를 만들지도, 배지를 찍지도 않는다 (보안 리뷰 M1)', async () => {
    findWebConversation.mockResolvedValue(null);
    let r = await post({ visitorId: VISITOR });
    expect(r.status).toBe(400);

    findWebConversation.mockResolvedValue(conversation({ messageCount: 0 }));
    r = await post({ visitorId: VISITOR });
    expect(r.status).toBe(400);

    expect(upsertConversation).not.toHaveBeenCalled();
    expect(markHandoffRequested).not.toHaveBeenCalled();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
  });

  it('상태를 찍고, 마지막 방문자 메시지를 인용한 칩을 남기고, 메일도 가고, 목록 순서를 끌어올린다', async () => {
    const { status, body } = await post({ visitorId: VISITOR });
    expect(status).toBe(200);
    expect(touchConversation).toHaveBeenCalledWith('conv-1');
    expect(markHandoffRequested).toHaveBeenCalledWith('conv-1');
    expect(savedNotice().body).toContain('"쿠폰함이 안 열려요" 를 상담원에게 전달했어요');
    expect(emailOwnerHandoff).toHaveBeenCalledWith({ botId: BOT_ID, conversationId: 'conv-1', requestBody: null });
    expect(body).toMatchObject({ escalated: true, already: false });
  });

  it('상태를 못 찍으면 500 — 실패를 성공으로 포장하지 않는다', async () => {
    markHandoffRequested.mockResolvedValue(false);
    const { status } = await post({ visitorId: VISITOR });
    expect(status).toBe(500);
    expect(saveConversationResponse).not.toHaveBeenCalled();
  });

  it('AI 가 먼저 물러나 escalated_at 만 있는 대화는 «아직 안 부른 것» — 방문자가 누르면 처음으로 찍고 안내 칩을 남긴다', async () => {
    // 2026-09-16 ny 결정: 위젯 상태 줄은 방문자가 직접 눌렀을 때만. AI 의 escalate 는 배지만 켠다.
    findWebConversation.mockResolvedValue(conversation({ escalated_at: '2026-09-13T00:00:00Z' }));
    const { body } = await post({ visitorId: VISITOR });
    expect(markHandoffRequested).toHaveBeenCalledWith('conv-1');
    expect(saveConversationResponse).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ escalated: true, already: false });
  });

  it('직전 안내 칩이 아직 유효하면 또 쌓지 않는다 — 연타 멱등', async () => {
    findWebConversation.mockResolvedValue(conversation({ escalated_at: '2026-09-13T00:00:00Z', handoff_requested_at: '2026-09-13T00:00:00Z' }));
    hasFreshEscalationNotice.mockResolvedValue(true);
    const { status, body } = await post({ visitorId: VISITOR });
    expect(status).toBe(200);
    expect(saveConversationResponse).not.toHaveBeenCalled();
    expect(body).toMatchObject({ escalated: true, already: true });
  });
});

// ── 위젯 쪽 ─────────────────────────────────────────

describe('widget.js — 상담원 연결', () => {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

  it('gzip 21KB 상한 안이다', () => {
    // 위젯은 남의 사이트에 붙는다. 15 → 16KB 는 2026-09-13(상담원 연결 v2), 16 → 17KB 는
    // 2026-09-16 ny 결정(되돌림 확인을 카드 «안»에서 받기 — I-30), 17 → 18KB 는 같은 날 B3
    // 「화면에서 선택하기」 — 선택기 본체는 widget-pick.js 로 갈라 여기엔 로더·첨부·payload 몫만 들었다.
    // 18 → 19KB 는 같은 날 도구 줄 재설계(안 1 — 알약 두 개가 첨부·상태로 같은 자리에서 바뀐다, ny 결정).
    // 19 → 20KB 는 2026-09-18 라이브 데모 신호(제보 접수·창 열림을 부모에 알리고, 우리 오리진에서 온
    // 「창 열어라」를 받는다). ny 지시 — 안내 말풍선을 눌렀는데 밑에 깔린 링크가 눌려 엉뚱한 페이지로
    // 넘어가던 것을 고치려면 위젯이 직접 창을 열어야 한다. 실측 증가분은 gzip 536B(19,182 → 19,718).
    // 20 → 21KB 는 2026-09-25 ny 결정(I-55 「화면에서 선택하기」 스크린샷 — 촬영 상태 칩·썸네일·shotId 첨부·
    // 촬영기 로더). 촬영기 본체(modern-screenshot)는 widget-shot.js 로 갈라 누르는 방문자만 받는다.
    // 실측 증가분 gzip 672B(20,435 → 21,107).
    // 21 → 22KB 는 2026-10-21 PayPal 3단계 5/6 — `payment` 종류의 결제 카드(서버 고정 영어 문장 + paypal.com
    // 호스트만 통과하는 「Pay with PayPal」 버튼). 설계 v2 §10 의 결정(여유 188B → 상한 22KB 로 올리고 이유를 적는다).
    // 22 → 24KB 는 2026-10-21 i18n 3/8 — 방문자에게 보이는 문구를 en·ko 표로 모두 싣는다(표 하나가 gzip 약 2KB).
    // 측정: 21,747B(22KB 상한 안) → 23,716B. 한쪽 언어만 받게 쪼개면 요청이 하나 늘어 첫 화면이 늦으니 한 파일에 둔다.
    expect(gzipSync(src).length).toBeLessThanOrEqual(24 * 1024);
  });

  it('escalate 라우트에 남긴 말·연락처를 보내고, 서버의 escalated 로 상태 줄을 켜고 끈다', () => {
    expect(src).toContain("apiBase + '/escalate?' + LQ");
    expect(src).toContain('payload.text = text');
    expect(src).toContain('state.escalated = esc');
  });

  it('상태 줄은 「상담원에게 전달됐어요」만 — 기대치 문구를 안 붙여 「보통 몇 …」로 잘리지 않는다 (2026-09-16)', () => {
    const i = src.indexOf("el('b', null, T('passed'))");
    expect(i).toBeGreaterThan(0);
    // 그 알약(st) 안에서 statusText 를 이어 붙이던 줄이 없다
    const pill = src.slice(i, src.indexOf('row.appendChild(st)', i));
    expect(pill).not.toContain('statusText');
    expect(pill).not.toContain('답이 오면 알려드려요');
  });

  it('서버 escalated 는 handoff_requested_at(방문자가 직접 부름)만 본다 — AI 의 escalate 는 배지만', () => {
    const route = readFileSync(new URL('../src/app/api/widget/[botId]/messages/route.ts', import.meta.url), 'utf8');
    expect(route).toContain('escalated: conversation.handoff_requested_at !== null');
    expect(route).not.toContain('escalated: conversation.escalated_at !== null');
  });

  it('버튼·상태 줄·폼 문구는 holding.ts 상수와 같다 — 위젯은 import 를 못 하므로 여기서 대조', async () => {
    const { ASK_HUMAN_LABEL, ESCALATED_STATUS, HANDOFF_FORM_TITLE, HANDOFF_SUBMIT_LABEL, HOLDING_MESSAGE } =
      await import('@/lib/bot/holding');
    expect(src).toContain(`'${ASK_HUMAN_LABEL}'`);
    expect(src).toContain(`'${ESCALATED_STATUS}'`);
    expect(src).toContain(`'${HANDOFF_FORM_TITLE}'`);
    expect(src).toContain(`'${HANDOFF_SUBMIT_LABEL}'`);
    // AI 대기 문구 밑 제안 칩은 대기 문구의 앞부분으로 판별한다
    // en·ko 표의 holdKey 가 각각 대기 문구(한국어 HOLDING_MESSAGE · 영어 HOLDING_MESSAGE_EN)의 앞부분이다
    const ko = src.match(/holdKey: '([^']+)', holdMsg: '([^']+)'/g);
    expect(ko).toHaveLength(2);
    expect(src).toContain('isHolding(it.body)');
    const { HOLDING_MESSAGE_EN } = await import('@/lib/bot/holding');
    const keys = [...src.matchAll(/holdKey: '([^']+)', holdMsg: '([^']+)'/g)].map((x) => [x[1], x[2]]);
    expect(keys.map((k) => k[1])).toEqual([HOLDING_MESSAGE_EN, HOLDING_MESSAGE]);
    for (const [key, msg] of keys) expect(msg.startsWith(key)).toBe(true);
  });

  it('폼 입력은 state 에 살아 재렌더에도 남고, 마지막 내 말을 처음 열 때만 미리 채우며, 그대로 보내면 중복 저장 대신 대화만 넘긴다', () => {
    expect(src).toContain('hf.text = ta.value');
    expect(src).toContain('if (!state.hf.text) state.hf.text = lastMine()');
    expect(src).toContain("if (!text && !hasUserMsg()) { state.error = T('hEmpty')");
    expect(src).toContain("if (text === lastMine().trim()) text = ''");
  });

  it('안내 칩(kind notice)을 되돌림 카드와 다른 모양으로 그린다', () => {
    expect(src).toContain("it.kind === 'notice'");
  });
});

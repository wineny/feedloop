import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
const { rpc, resolveWidgetBot, checkWriteRate, emailOwnerHandoff, maybeSingle, afterTasks } = vi.hoisted(() => ({
  rpc: vi.fn(), resolveWidgetBot: vi.fn(), checkWriteRate: vi.fn(), emailOwnerHandoff: vi.fn(),
  maybeSingle: vi.fn(), afterTasks: [] as unknown[],
}));
// after() 는 요청이 끝난 «뒤» 도는 자리다. 테스트에서는 모아 두었다가 직접 실행해 결과를 본다.
vi.mock('next/server', async (original) => ({
  ...await original<typeof import('next/server')>(),
  after: (task: unknown) => { afterTasks.push(task); },
}));
const chain = { select: () => chain, eq: () => chain, maybeSingle } as Record<string, unknown>;
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ rpc, from: () => chain }) }));
vi.mock('@/lib/email/notify', () => ({ emailOwnerHandoff }));
vi.mock('@/lib/widget/http', async (original) => ({ ...await original<typeof import('@/lib/widget/http')>(), resolveWidgetBot, checkWriteRate }));
import { GET, POST } from '@/app/api/widget/[botId]/confirm/route';
const botId = '11000000-0000-4000-8000-000000000001';
const visitorId = '11000000-0000-4000-8000-000000000002';
const responseId = '11000000-0000-4000-8000-000000000003';
const conversationId = '11000000-0000-4000-8000-000000000004';
const context = { params: Promise.resolve({ botId }) };
const post = (body: unknown) => POST(new NextRequest(`http://localhost/api/widget/${botId}/confirm`, { method: 'POST', body: JSON.stringify(body) }), context);
beforeEach(() => {
  vi.clearAllMocks();
  afterTasks.length = 0;
  resolveWidgetBot.mockResolvedValue({ id: botId });
  checkWriteRate.mockResolvedValue(null);
  rpc.mockResolvedValue({ data: { confirmation: 'fixed', confirmedAt: '2026-09-13T00:00:00Z' }, error: null });
  maybeSingle.mockResolvedValue({ data: { conversation_id: conversationId }, error: null });
  emailOwnerHandoff.mockResolvedValue({ sent: true });
});
/** 라우트가 after() 에 맡긴 일을 실행한다 */
const runAfter = async () => { for (const t of afterTasks) await (typeof t === 'function' ? (t as () => unknown)() : t); };
describe('visitor resolution confirmation', () => {
  it.each([null, [], {}, { visitorId, responseId, confirmation: 'merged' }, { visitorId: 'bad', responseId, confirmation: 'fixed' }])('rejects malformed input %j', async body => { expect((await post(body)).status).toBe(400); expect(rpc).not.toHaveBeenCalled(); });
  it('persists an explicit statement through the atomic ownership check', async () => {
    const res = await post({ visitorId, responseId, confirmation: 'not_fixed' });
    expect(res.status).toBe(200); expect(rpc).toHaveBeenCalledWith('confirm_widget_resolution', { p_bot_id: botId, p_visitor_id: visitorId, p_response_id: responseId, p_confirmation: 'not_fixed' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('GET reads without writing', async () => { expect((await GET(new NextRequest(`http://localhost/api/widget/${botId}/confirm?visitorId=${visitorId}&responseId=${responseId}`), context)).status).toBe(200); expect(rpc.mock.calls[0][1].p_confirmation).toBeNull(); });
  it('rejects missing ownership without disclosing which link failed', async () => { rpc.mockResolvedValue({ data: null, error: null }); expect((await post({ visitorId, responseId, confirmation: 'fixed' })).status).toBe(404); });
  it('does not claim success on a database error', async () => { rpc.mockResolvedValue({ data: null, error: { message: 'connection lost' } }); expect((await post({ visitorId, responseId, confirmation: 'fixed' })).status).toBe(503); });
  it('does not process paused bots', async () => { resolveWidgetBot.mockResolvedValue(null); expect((await post({ visitorId, responseId, confirmation: 'fixed' })).status).toBe(404); expect(rpc).not.toHaveBeenCalled(); });
  it('honors rate limits', async () => { checkWriteRate.mockResolvedValue(new Response(null, { status: 429 })); expect((await post({ visitorId, responseId, confirmation: 'fixed' })).status).toBe(429); expect(rpc).not.toHaveBeenCalled(); });

  // ── 「아직 그대로예요」는 운영자를 부른다 (I-30) ───────────────
  //
  // 고쳤다고 보낸 것이 안 고쳐졌다는 신호다. RPC 가 escalated_at·follow_up_pending 을 찍지만
  // 그것만으로는 운영자가 화면을 열어야 안다.

  it('「아직 그대로예요」면 봇 소유자에게 알린다', async () => {
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z', changed: true }, error: null });
    expect((await post({ visitorId, responseId, confirmation: 'not_fixed' })).status).toBe(200);
    await runAfter();
    expect(emailOwnerHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ botId, conversationId, kind: 'not_fixed', requestBody: null }),
    );
  });

  it('같은 값을 다시 받으면(changed:false) 알리지 않는다 — 연타가 발송기를 깨우지 않게', async () => {
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z', changed: false }, error: null });
    expect((await post({ visitorId, responseId, confirmation: 'not_fixed' })).status).toBe(200);
    await runAfter();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
  });

  it('changed 를 모르는 옛 RPC 에서도 알린다 — 마이그레이션을 잊은 배포에서 조용히 멎지 않게', async () => {
    // 20260916_01 적용 전에는 이 키가 없다. 없으면 종전대로 보내고 상한이 막는다.
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z' }, error: null });
    expect((await post({ visitorId, responseId, confirmation: 'not_fixed' })).status).toBe(200);
    await runAfter();
    expect(emailOwnerHandoff).toHaveBeenCalled();
  });

  it('「잘 돼요」면 알리지 않는다 — 좋은 소식으로 운영자 메일함을 채우지 않는다', async () => {
    expect((await post({ visitorId, responseId, confirmation: 'fixed' })).status).toBe(200);
    await runAfter();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
  });

  it('읽기(GET)는 알리지 않는다 — 카드를 그리는 것만으로 메일이 나가면 안 된다', async () => {
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z' }, error: null });
    await GET(new NextRequest(`http://localhost/api/widget/${botId}/confirm?visitorId=${visitorId}&responseId=${responseId}`), context);
    await runAfter();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
  });

  it('대화를 못 찾으면 조용히 멈춘다 — 방문자의 확인은 이미 저장됐다', async () => {
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z' }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await post({ visitorId, responseId, confirmation: 'not_fixed' })).status).toBe(200);
    await runAfter();
    expect(emailOwnerHandoff).not.toHaveBeenCalled();
  });

  it('알림이 실패해도 방문자 응답은 200 이다', async () => {
    rpc.mockResolvedValue({ data: { confirmation: 'not_fixed', confirmedAt: '2026-09-16T00:00:00Z' }, error: null });
    emailOwnerHandoff.mockRejectedValue(new Error('postmark down'));
    expect((await post({ visitorId, responseId, confirmation: 'not_fixed' })).status).toBe(200);
    await expect(runAfter()).resolves.not.toThrow();
  });
});

describe('widget.js — 되돌림 카드 안에서 확인을 받는다', () => {
  const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');

  it('카드 «안»에서 끝난다 — 새 탭으로 내보내지 않는다', () => {
    // 예전에는 /feedback-confirm 을 새 탭으로 열었고 되돌림 6건에 응답이 0건이었다.
    // 그 페이지는 남아 있지만 이제 아무도 링크하지 않는다 — 되돌림 메일의 CTA 도 사이트로 간다.
    //
    // 문자열이 아니라 «링크를 만드는 코드»를 막는다 — 경로를 설명하는 주석까지 걸면
    // 왜 이렇게 됐는지를 적을 수 없다(첫 판이 실제로 제 주석에 걸렸다).
    expect(src).not.toMatch(/new URL\(\s*'\/feedback-confirm'/);
    expect(src).toContain("apiBase + '/confirm?' + LQ");
  });

  it('두 선택지와 보낸 뒤 상태를 모두 그린다', () => {
    expect(src).toContain('네, 잘 돼요');
    expect(src).toContain('아직 그대로예요');
    expect(src).toContain('해결됐다고 알려주셨어요');
    expect(src).toContain('아직이라고 알려주셨어요');
  });

  it('서버가 준 confirmation 을 그려서, 이미 답한 카드에 같은 질문을 다시 하지 않는다', () => {
    expect(src).toContain('systemCard(it.body, it.id, it.confirmation)');
    expect(src).toContain('markConfirmed');
  });

  it('응답을 기다리는 동안 잠근다 — 연타·두 카드 동시 클릭', () => {
    expect(src).toContain('if (state.confirming) return;');
  });

  it('멈춘 요청에서 빠져나온다 — 타임아웃이 없으면 확인 버튼이 영영 죽는다', () => {
    // 거부가 아니라 «지연»이면 catch 가 안 돈다. 잠금이 안 풀리면 새로고침 말고 탈출구가 없다.
    expect(src).toContain('AbortController');
    expect(src).toContain('ctl.abort()');
    expect(src).toContain('clearTimeout(timer)');
  });

  it('보내는 동안 다른 카드 버튼은 죽어 보인다 — 눌러 놓고 아무 일도 안 일어나면 안 된다', () => {
    // 잠금이 전역이라 다른 카드도 안 눌린다. 그 사실이 화면에 보여야 한다.
    expect(src).toContain('if (state.confirming) b.disabled = true;');
    expect(src).toContain('.chip:disabled');
  });
});

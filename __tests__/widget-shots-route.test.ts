import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';

// POST /api/widget/[botId]/shots — 무인증 업로드 관문. 저장소는 가짜로 두고 «무엇을 거절하나»만 본다.

const { resolveWidgetBot, checkShotRate, storeShot } = vi.hoisted(() => ({
  resolveWidgetBot: vi.fn(),
  checkShotRate: vi.fn(),
  storeShot: vi.fn(),
}));
vi.mock('@/lib/widget/http', async (orig) => ({ ...(await orig<typeof import('@/lib/widget/http')>()), resolveWidgetBot }));
vi.mock('@/lib/widget/shots', () => ({ checkShotRate, storeShot }));

const BOT = '11111111-1111-4111-8111-111111111111';
const VISITOR = '33333333-3333-4333-8333-333333333333';

async function post(body: Uint8Array | string, opts: { visitorId?: string; type?: string } = {}) {
  const { POST } = await import('@/app/api/widget/[botId]/shots/route');
  const url = `https://feedloop.test/api/widget/${BOT}/shots?visitorId=${opts.visitorId ?? VISITOR}`;
  const req = new NextRequest(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : Buffer.from(body),
    headers: { 'content-type': opts.type ?? 'image/webp', 'x-real-ip': `10.0.0.${Math.floor(Math.random() * 250)}` },
  });
  const res = await POST(req, { params: Promise.resolve({ botId: BOT }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cors: res.headers.get('access-control-allow-origin') };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveWidgetBot.mockResolvedValue({ id: BOT, status: 'active' });
  checkShotRate.mockResolvedValue(null);
  storeShot.mockResolvedValue({ ok: true, id: '77777777-7777-4777-8777-777777777777' });
});

describe('POST /shots', () => {
  it('정상 WebP → 201 {shotId} 만(이미지 URL 없음), CORS', async () => {
    const img = new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#fff' } }).webp().toBuffer());
    const r = await post(img);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ shotId: '77777777-7777-4777-8777-777777777777' });
    expect(r.cors).toBe('*');
    expect(storeShot).toHaveBeenCalledWith(expect.objectContaining({ botId: BOT, visitorId: VISITOR, info: { mime: 'image/webp', width: 1280, height: 720 } }));
  });

  it('Content-Type 을 image/webp 로 속인 PNG·HTML 은 415, 저장 안 함', async () => {
    const png = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer());
    expect((await post(png)).status).toBe(415);
    expect((await post('<html><script>alert(1)</script></html>')).status).toBe(415);
    expect(storeShot).not.toHaveBeenCalled();
  });

  it('1MB 초과 → 413 (선언 길이 없이 흘려도 읽으면서 끊는다)', async () => {
    const big = new Uint8Array(1024 * 1024 + 10);
    expect((await post(big)).status).toBe(413);
    expect(storeShot).not.toHaveBeenCalled();
  });

  it('속도 상한 → 429, 이미지를 읽기 전에', async () => {
    checkShotRate.mockResolvedValue('visitor');
    const r = await post(new Uint8Array([1, 2, 3]));
    expect(r.status).toBe(429);
    expect(storeShot).not.toHaveBeenCalled();
  });

  it('예약 단계에서 상한에 걸리면 429 (동시 요청이 조기 계수를 함께 통과한 경우)', async () => {
    storeShot.mockResolvedValue({ ok: false, limit: 'bot' });
    const img = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).webp().toBuffer());
    expect((await post(img)).status).toBe(429);
  });

  it('visitorId 가 UUID 가 아니면 400, 없는 봇이면 404', async () => {
    expect((await post(new Uint8Array([1]), { visitorId: 'nope' })).status).toBe(400);
    resolveWidgetBot.mockResolvedValue(null);
    expect((await post(new Uint8Array([1]))).status).toBe(404);
  });

  it('빈 본문 400 · 저장 실패 500', async () => {
    expect((await post(new Uint8Array(0))).status).toBe(400);
    storeShot.mockResolvedValue({ ok: false, limit: null });
    const img = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    expect((await post(img, { type: 'image/jpeg' })).status).toBe(500);
  });
});

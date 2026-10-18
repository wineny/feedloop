import { describe, it, expect, vi, afterEach } from 'vitest';

// 카카오 웹훅은 서명도 시크릿도 없이 열려 있던 유일한 수신 경로다(오픈빌더가 서명 헤더를
// 주지 않는다). `botId` 는 위젯 스니펫으로 공개되므로 아무나 POST 할 수 있었고, 들어온 건
// 메시지·인사이트가 되어 LLM 예산을 썼다 — `bump_kakao_usage` 는 계측만 하고 차단하지 않는다.
//
// 2026-09-14 에 기본을 «닫힘»으로 뒤집었다(I-34). 이 테스트가 지키는 것은 그 기본값이다.
// «켜졌을 때 제대로 도는가»는 reply-limit 테스트가 이미 증명한다.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function post(): Promise<Response> {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/kakao/webhook/[botId]/route');
  const botId = '00000000-0000-0000-0000-0000000000aa';
  const req = new NextRequest(`https://feedloop.test/api/kakao/webhook/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userRequest: { utterance: '테스트', user: { id: 'u1' } } }),
  });
  return POST(req, { params: Promise.resolve({ botId }) });
}

describe('카카오 웹훅 게이트', () => {
  it('env 가 없으면 받지 않는다 — 기본이 닫힘이어야 한다', async () => {
    vi.stubEnv('KAKAO_WEBHOOK_ENABLED', '');
    const res = await post();
    expect(res.status).toBe(404);
  });

  it('403 이 아니라 404 다 — 닫힌 문이 어디 있는지까지 알려줄 이유가 없다', async () => {
    vi.stubEnv('KAKAO_WEBHOOK_ENABLED', '');
    const res = await post();
    expect(res.status).not.toBe(403);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it.each(['false', 'TRUE', '1', 'yes', ' true'])(
    '「%s」 는 켠 것으로 치지 않는다 — 오타가 무인증 경로를 여는 일이 없어야 한다',
    async (value) => {
      vi.stubEnv('KAKAO_WEBHOOK_ENABLED', value);
      const res = await post();
      expect(res.status).toBe(404);
    },
  );

  it('닫혀 있어도 GET 은 답한다 — 받은 값을 돌려줄 뿐 DB·LLM 을 건드리지 않는다', async () => {
    vi.stubEnv('KAKAO_WEBHOOK_ENABLED', '');
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/kakao/webhook/[botId]/route');
    const botId = '00000000-0000-0000-0000-0000000000aa';
    const res = await GET(new NextRequest(`https://feedloop.test/x`), {
      params: Promise.resolve({ botId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', channel: 'kakao' });
  });
});

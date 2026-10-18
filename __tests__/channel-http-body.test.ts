import { describe, it, expect, vi } from 'vitest';
import { readBoundedJson, DEFAULT_MAX_PAYLOAD_BYTES } from '@/lib/http/body';

// 이 가드는 무인증 라우트가 «남이 보낸 본문» 을 읽기 전에 서 있는 유일한 제동이다.
// 위젯에 있던 것을 채널톡과 함께 쓰려고 옮겼는데, 옮기기 전에는 테스트가 없었다.

/** Request 흉내. text() 가 언제 불렸는지(또는 안 불렸는지) 볼 수 있어야 한다. */
function fakeRequest(opts: {
  body?: string;
  contentLength?: string | null;
  textThrows?: boolean;
}) {
  const text = vi.fn(async () => {
    if (opts.textThrows) throw new Error('stream broken');
    return opts.body ?? '';
  });
  return {
    req: {
      headers: { get: (k: string) => (k === 'content-length' ? (opts.contentLength ?? null) : null) },
      text,
    } as unknown as Request,
    text,
  };
}

describe('readBoundedJson', () => {
  it('정상 본문을 파싱해 돌려준다', async () => {
    const { req } = fakeRequest({ body: '{"a":1}' });
    expect(await readBoundedJson<{ a: number }>(req, 1000)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('선언된 크기가 상한을 넘으면 본문을 읽지도 않고 413 이다', async () => {
    const { req, text } = fakeRequest({ body: 'x', contentLength: '2000' });

    expect(await readBoundedJson(req, 1000)).toEqual({
      ok: false,
      reason: 'too_large',
      status: 413,
    });
    // 파싱 비용을 막는 게 목적이라, 읽고 나서 재는 건 늦다.
    expect(text).not.toHaveBeenCalled();
  });

  it('Content-Length 를 줄여 말해도 읽은 길이로 다시 잡는다 — 헤더는 위조된다', async () => {
    const { req } = fakeRequest({ body: 'a'.repeat(2000), contentLength: '5' });
    expect(await readBoundedJson(req, 1000)).toEqual({
      ok: false,
      reason: 'too_large',
      status: 413,
    });
  });

  it('Content-Length 가 없어도 읽은 길이로 판정한다', async () => {
    const { req } = fakeRequest({ body: 'a'.repeat(2000), contentLength: null });
    expect(await readBoundedJson(req, 1000)).toMatchObject({ reason: 'too_large' });
  });

  it('JSON 이 아니면 400 이다', async () => {
    const { req } = fakeRequest({ body: 'not json' });
    expect(await readBoundedJson(req, 1000)).toEqual({
      ok: false,
      reason: 'invalid_json',
      status: 400,
    });
  });

  it('본문을 못 읽으면 400 이고, 크기 초과와 사유를 구분한다', async () => {
    const { req } = fakeRequest({ textThrows: true });
    expect(await readBoundedJson(req, 1000)).toEqual({
      ok: false,
      reason: 'unreadable',
      status: 400,
    });
  });

  it('상한을 안 주면 위젯이 쓰던 64KB 다', async () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(64 * 1024);

    const { req } = fakeRequest({ body: `{"a":"${'x'.repeat(70 * 1024)}"}` });
    expect(await readBoundedJson(req)).toMatchObject({ reason: 'too_large' });
  });

  it('상한 경계에서는 통과한다', async () => {
    const body = `{"a":"${'x'.repeat(100 - 8)}"}`;
    expect(body).toHaveLength(100);
    const { req } = fakeRequest({ body });
    expect(await readBoundedJson(req, 100)).toMatchObject({ ok: true });
  });

  it('한글은 문자 수가 아니라 바이트로 잰다 — 단위를 섞으면 상한이 상한이 아니다', async () => {
    // 한글 40자는 UTF-8 로 120바이트다. 문자 수(48)로 재면 100 상한을 그냥 통과한다.
    const body = `{"a":"${'가'.repeat(40)}"}`;
    expect(body.length).toBeLessThan(100);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(100);

    const { req } = fakeRequest({ body });
    expect(await readBoundedJson(req, 100)).toMatchObject({ reason: 'too_large', status: 413 });
  });

  it('바이트로 재도 상한 안이면 그대로 통과한다 — 한글을 통째로 막지는 않는다', async () => {
    const body = `{"a":"${'가'.repeat(20)}"}`;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(100);

    const { req } = fakeRequest({ body });
    expect(await readBoundedJson(req, 100)).toMatchObject({ ok: true });
  });
});

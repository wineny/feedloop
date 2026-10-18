import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkKeyFormat,
  verifyKey,
  classifyFailure,
  failureMessage,
  keyLast4,
} from '@/lib/llm/key';
import { encrypt, decrypt } from '@/lib/utils/crypto';

// ⚠️ 이 파일에는 진짜 키가 한 개도 없다. 전부 형태만 흉내낸 가짜 문자열이다.
//    실키는 .env.local 밖으로 나가지 않는다 — 테스트·로그·커밋 어디에도.
const FAKE = {
  gemini: 'AIzaNOTAREALKEY0000000000000000000000000',
  anthropic: 'sk-ant-api03-NOTAREALKEY000000000000000000',
  openai: 'sk-proj-NOTAREALKEY00000000000000000000000',
} as const;

const AES = 'a'.repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('checkKeyFormat — 오탈자 1차 필터', () => {
  it('세 provider 의 정상 형태를 통과시킨다', () => {
    expect(checkKeyFormat('gemini', FAKE.gemini)).toEqual({ ok: true });
    expect(checkKeyFormat('anthropic', FAKE.anthropic)).toEqual({ ok: true });
    expect(checkKeyFormat('openai', FAKE.openai)).toEqual({ ok: true });
  });

  it('명백한 오탈자(다른 provider 접두사·빈 값·붙여넣기 공백)를 거른다', () => {
    expect(checkKeyFormat('gemini', FAKE.openai).ok).toBe(false);
    expect(checkKeyFormat('openai', FAKE.gemini).ok).toBe(false);
    expect(checkKeyFormat('anthropic', 'sk-plain-not-anthropic').ok).toBe(false);
    expect(checkKeyFormat('openai', '').ok).toBe(false);
    expect(checkKeyFormat('openai', `  ${FAKE.openai}\n`).ok).toBe(false);
    expect(checkKeyFormat('openai', 12345).ok).toBe(false);
  });

  it('길이만 다른 유효 키를 거르지 않는다 — provider 가 키 길이를 바꿔도 안 깨진다', () => {
    // 짧은 쪽과 아주 긴 쪽 둘 다. 길이를 하드코딩하면 여기서 걸린다.
    expect(checkKeyFormat('openai', 'sk-' + 'A'.repeat(20)).ok).toBe(true);
    expect(checkKeyFormat('openai', 'sk-' + 'A'.repeat(300)).ok).toBe(true);
    expect(checkKeyFormat('gemini', 'AIza' + 'B'.repeat(120)).ok).toBe(true);
    expect(checkKeyFormat('anthropic', 'sk-ant-' + 'C'.repeat(200)).ok).toBe(true);
  });
});

describe('classifyFailure / failureMessage — 사유 4분류', () => {
  it('HTTP 상태로 가른다', () => {
    expect(classifyFailure(401)).toBe('key_rejected');
    expect(classifyFailure(403)).toBe('key_rejected');
    expect(classifyFailure(404)).toBe('model_invalid');
    expect(classifyFailure(429)).toBe('quota');
    expect(classifyFailure(500)).toBe('connection');
    expect(classifyFailure(null)).toBe('connection');
  });

  it('400 + 모델 관련 본문은 모델 문제로 본다', () => {
    expect(classifyFailure(400, '{"error":{"message":"model not found"}}')).toBe('model_invalid');
    expect(classifyFailure(400, '{"error":{"type":"invalid_request"}}')).toBe('connection');
  });

  it('문구에 모델명을 실어도 에러 원문은 안 싣는다', () => {
    expect(failureMessage('model_invalid', 'gemini-nope')).toContain('gemini-nope');
    expect(failureMessage('key_rejected')).toBe('키가 거부됐어요');
    expect(failureMessage('quota')).toBe('provider 한도에 걸렸어요');
    expect(failureMessage('connection')).toBe('연결에 실패했어요');
  });
});

describe('verifyKey — 키는 헤더로만 나간다', () => {
  it('gemini 는 URL 이 아니라 x-goog-api-key 헤더에 키를 싣는다', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyKey('gemini', FAKE.gemini);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(FAKE.gemini);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE.gemini);
  });

  it('리다이렉트를 따라가지 않는다 — 키가 든 헤더가 남의 호스트로 가면 안 된다', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyKey('gemini', FAKE.gemini);
    await verifyKey('anthropic', FAKE.anthropic);
    await verifyKey('openai', FAKE.openai);

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as unknown as [string, RequestInit];
      expect(init.redirect).toBe('error');
    }
  });

  it('anthropic·openai 도 헤더로 보낸다', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyKey('anthropic', FAKE.anthropic);
    await verifyKey('openai', FAKE.openai);

    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(url).not.toContain('NOTAREALKEY');
      expect(JSON.stringify(init.headers)).toContain('NOTAREALKEY');
    }
    const anthropicHeaders = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(anthropicHeaders['anthropic-version']).toBe('2023-06-01');
  });

  it('실패해도 반환값 어디에도 키 원문이 없다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`{"error":"bad key ${FAKE.openai}"}`, { status: 401 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await verifyKey('openai', FAKE.openai);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE.openai);
    expect(JSON.stringify(result)).not.toContain('NOTAREALKEY');
    // provider 에러 원문도 새어 나오면 안 된다
    expect(JSON.stringify(result)).not.toContain('bad key');
  });

  it('실패 경로를 태워도 console 로그 인자 어디에도 키 원문이 없다', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 1) provider 가 거부한 경우
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`{"error":"key ${FAKE.gemini} rejected"}`, { status: 403 })),
    );
    await verifyKey('gemini', FAKE.gemini);

    // 2) 네트워크 자체가 실패한 경우
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect failed for ${FAKE.gemini}`);
      }),
    );
    await verifyKey('gemini', FAKE.gemini);

    const logged = JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls]);
    expect(logged).not.toContain('NOTAREALKEY');
    expect(logged).toContain('gemini');
  });
});

describe('저장 표시용', () => {
  it('마지막 4자만 남긴다', () => {
    expect(keyLast4(FAKE.openai)).toBe(FAKE.openai.slice(-4));
    expect(keyLast4(FAKE.openai)).toHaveLength(4);
  });

  it('encrypt → decrypt 왕복이 같은 문자열이다 (저장 경로가 키를 손상시키지 않는다)', () => {
    expect(decrypt(encrypt(FAKE.anthropic, AES), AES)).toBe(FAKE.anthropic);
    // 암호문에는 원문이 안 보인다
    expect(encrypt(FAKE.anthropic, AES)).not.toContain('NOTAREALKEY');
  });
});

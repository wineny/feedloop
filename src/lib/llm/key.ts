// 운영자 LLM API 키의 형식 필터·실호출 검증, 그리고 실패 사유 분류.
//
// 이 모듈이 지키는 것 하나: **키 원문은 반환값에도 로그에도 절대 안 들어간다.**
// provider 에러 본문도 싣지 않는다 — 거기에 키 조각이나 내부 정보가 섞일 수 있다.
// 밖으로 나가는 건 우리가 고른 4가지 사유와 그에 대응하는 한국어 문구뿐이다.

import { RECOMMENDED, type LlmProvider } from './models';

// 형식 1차 필터는 key-format.ts 에 있다(의존성 0 — 운영자 화면이 보내기 전에 쓴다).
// 기존 서버 호출부가 안 깨지게 여기서 다시 내보낸다.
export { checkKeyFormat, type KeyFormatResult } from './key-format';

// ── 실패 사유 4분류 ─────────────────────────────────
//
// 키 검증과 즉답 호출 실패(§B-6)가 같은 분류를 쓴다. 운영자가 화면에서 보는 문구가
// "뭘 고쳐야 하는지"를 말해야 하기 때문이다.

export type LlmFailureKind = 'key_rejected' | 'model_invalid' | 'quota' | 'connection';

/**
 * HTTP 상태와(있다면) 에러 이름으로 사유를 고른다.
 *
 * `detail` 은 **분류에만 쓰고 밖으로 내보내지 않는다.** provider 메시지를 그대로
 * 실으면 키 조각이 딸려 나갈 수 있다.
 */
export function classifyFailure(status: number | null, detail?: string): LlmFailureKind {
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 429) return 'quota';
  if (status === 404) return 'model_invalid';

  const hay = (detail ?? '').toLowerCase();
  if (status === 400 && /model/.test(hay)) return 'model_invalid';
  if (/\b(not_found_error|model_not_found|invalid_model)\b/.test(hay)) return 'model_invalid';
  if (/\b(invalid_api_key|authentication|unauthorized|permission_denied|api key)\b/.test(hay)) {
    return 'key_rejected';
  }
  if (/\b(rate_limit|quota|resource_exhausted|overloaded)\b/.test(hay)) return 'quota';
  return 'connection';
}

/** `bots.status_message` 와 운영자 화면에 그대로 쓰는 문구. 원문 에러는 안 들어간다. */
export function failureMessage(kind: LlmFailureKind, modelId?: string | null): string {
  switch (kind) {
    case 'key_rejected':
      return '키가 거부됐어요';
    case 'model_invalid':
      return modelId ? `모델 이름을 확인해 주세요: ${modelId}` : '모델 이름을 확인해 주세요';
    case 'quota':
      return 'provider 한도에 걸렸어요';
    case 'connection':
      return '연결에 실패했어요';
  }
}

// ── 실호출 검증 ─────────────────────────────────────
//
// 무과금 목록 호출을 쓴다. **키는 전부 헤더로 보낸다** — 쿼리스트링에 실으면
// URL 이 프록시·로그·에러 리포트에 그대로 남는다.

const VERIFY_TIMEOUT_MS = 8_000;

interface VerifyEndpoint {
  url: string;
  headers: Record<string, string>;
}

function verifyEndpoint(provider: LlmProvider, key: string): VerifyEndpoint {
  switch (provider) {
    case 'gemini':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': key },
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${key}` },
      };
  }
}

export type KeyVerifyResult =
  | { ok: true }
  | { ok: false; kind: LlmFailureKind; error: string };

/**
 * 키가 실제로 통하는지 provider 에 물어본다. 모델 목록 조회라 과금되지 않는다.
 *
 * 모델 이름은 여기서 검증되지 않는다 — 목록 조회는 모델을 지정하지 않기 때문이다.
 * 잘못된 모델 이름은 첫 즉답 호출에서 드러나고 §B-6 경로로 운영자에게 보인다.
 */
export async function verifyKey(provider: LlmProvider, key: string): Promise<KeyVerifyResult> {
  const { url, headers } = verifyEndpoint(provider, key);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      // 리다이렉트를 따라가지 «않는다». 따라가면 키가 담긴 Authorization·x-api-key 헤더가
      // 우리가 고르지 않은 호스트로 전달될 수 있다(DNS 탈취·provider 측 오설정).
      // 목록 조회는 원래 리다이렉트가 없으므로 따라갈 일도 없다.
      redirect: 'error',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    // 에러 객체를 로그에 싣지 않는다 — fetch 에러가 요청 헤더를 품는 런타임이 있다.
    console.error(`[llm] key verification could not reach provider: ${provider}`);
    return { ok: false, kind: 'connection', error: failureMessage('connection') };
  }

  if (res.ok) return { ok: true };

  // 본문은 분류에만 쓰고 밖으로도 로그로도 내보내지 않는다.
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    detail = '';
  }

  const kind = classifyFailure(res.status, detail);
  console.error(`[llm] key verification failed: provider=${provider} status=${res.status} kind=${kind}`);
  return { ok: false, kind, error: failureMessage(kind) };
}

/** 화면 표시용. 원문은 절대 저장·반환하지 않고 이 4자만 남긴다. */
export function keyLast4(key: string): string {
  return key.slice(-4);
}

/** 운영자가 모델을 안 골랐을 때 화면이 "(기본) …" 으로 보여줄 값. */
export function effectiveModelId(provider: LlmProvider, model: string | null): string {
  return model ?? RECOMMENDED[provider];
}

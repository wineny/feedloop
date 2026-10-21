// 키의 «형식» 1차 필터. 의존성 0 이다.
//
// key.ts 와 나눠 둔 이유: 운영자 화면(클라이언트 컴포넌트)이 붙여넣은 키를 보내기 «전에»
// 오탈자를 잡아주려면 이 함수가 필요한데, key.ts 에는 provider 로 실제 요청을 보내는
// verifyKey 가 있다. 그건 서버에서만 돌아야 하고 클라이언트 번들에 실릴 이유가 없다.
// (lib/bot/appearance.ts · lib/llm/models.ts 가 같은 이유로 의존성 0 이다)

import type { LlmProvider } from './models';

// ── 형식 1차 필터 ───────────────────────────────────
//
// 오탈자를 거르는 용도다. **길이를 하드코딩하지 않는다** — provider 가 키 길이를
// 바꾸면 멀쩡한 키가 거부되고, 그 사고는 운영자 쪽에서 원인을 알 수 없다.
// 최종 판정은 key.ts 의 verifyKey 실호출이 한다(서버 전용).

const KEY_PREFIX: Record<LlmProvider, RegExp> = {
  gemini: /^AIza[A-Za-z0-9_-]{8,}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{8,}$/,
  openai: /^sk-[A-Za-z0-9_-]{8,}$/,
};

const KEY_HINT: Record<LlmProvider, string> = {
  gemini: 'Gemini 키는 AIza 로 시작해요',
  anthropic: 'Anthropic 키는 sk-ant- 로 시작해요',
  openai: 'OpenAI 키는 sk- 로 시작해요',
};

/** `code`·`vars` 는 화면용(사전 키 `common.validation.<code>`) — `error` 는 서버 응답용 한국어 */
export type KeyFormatResult = { ok: true } | { ok: false; error: string; code: string; vars?: Record<string, string | number> };

/** 붙여넣기 사고(앞뒤 공백·줄바꿈·따옴표)와 명백한 오탈자만 거른다. */
export function checkKeyFormat(provider: LlmProvider, key: unknown): KeyFormatResult {
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, error: 'API 키를 입력해 주세요', code: 'key.empty' };
  }
  if (key !== key.trim()) {
    return { ok: false, error: 'API 키 앞뒤에 공백이나 줄바꿈이 섞여 있어요', code: 'key.whitespace' };
  }
  if (!KEY_PREFIX[provider].test(key)) {
    return { ok: false, error: `키 형식이 맞지 않아요. ${KEY_HINT[provider]}`, code: `key.format.${provider}` };
  }
  return { ok: true };
}

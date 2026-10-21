// provider 별 모델 목록과 추천 기본값.
//
// 이 모듈은 의존성이 0 이다(SDK 도 서버 클라이언트도 import 하지 않는다).
// 서버 라우트(`api/bots/[id]/llm-key`)와 운영자 선택 UI 가 같은 목록·같은 검증 규칙을
// 쓰기 위해서다 — `lib/bot/appearance.ts` 와 같은 이유이고 같은 제약이다.
//
// 모델 id 는 전부 2026-09-10 에 각 provider 공식 문서로 확인했다.
// 가격은 입력 100만 토큰 기준이며 목록 note 의 근거다.
//   gemini    ai.google.dev/gemini-api/docs/models · /pricing
//   anthropic platform.claude.com/docs/en/docs/about-claude/models/overview
//   openai    developers.openai.com/api/docs/models · /pricing
//
// 2026-09-12 추가: gemini-2.5-flash — 9/10·9/12 실측에서 「모르면 담당자 확인」 규칙을
// 9/9 지킨 모델(§I-08). 저가 모델(flash-lite)은 지식이 늘면 이 규칙을 자주 놓친다.

export type LlmProvider = 'gemini' | 'anthropic' | 'openai';

export const LLM_PROVIDERS: readonly LlmProvider[] = ['gemini', 'anthropic', 'openai'] as const;

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  gemini: 'Gemini',
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value);
}

export interface LlmModelOption {
  id: string;
  label: string;
  // 운영자가 고를 때 보는 한 줄(가격은 입력 100만 토큰 기준)은 사전 `llm.models.<id>` 에 있다 — `.` 은 `_` 로(`gemini-3_5-flash`).
}

/**
 * 선택 UI 에 뿌리는 목록. **닫힌 집합이 아니다** — provider 가 새 모델을 내면
 * 우리 배포를 기다리게 할 수 없으므로 UI 에 「직접 입력」을 함께 둔다.
 * 그래서 `validateModelId` 도 목록 밖 이름을 통과시킨다.
 */
export const MODELS: Record<LlmProvider, LlmModelOption[]> = {
  gemini: [
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  ],
  openai: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  ],
};

/**
 * 운영자가 모델을 안 골랐을 때 쓰는 값. 기준은 **빠르고 싼 쪽**이다 —
 * 위젯 즉답은 10초 예산이고 비용은 운영자에게 간다.
 * `PLATFORM_LLM_MODEL` 이 없을 때 플랫폼 폴백도 이 값으로 떨어진다.
 */
// 2026-09-12 I-08 측정: gemini-3.5-flash-lite 가 새 프롬프트에서 지식 0 사실 질문 15/15 대기 · 피드백 9/9 라
// 유지한다(2.5-flash-lite 는 피드백 8/9). 이 값은 BYOK 로 gemini 를 고르고 모델을 안 정한 운영자의 기본값이지
// 플랫폼 폴백(PLATFORM_LLM_MODEL)이 아니다.
export const RECOMMENDED: Record<LlmProvider, string> = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
};

export function modelLabel(provider: LlmProvider, id: string): string {
  return MODELS[provider].find((m) => m.id === id)?.label ?? id;
}

// ── 모델 이름 검증 ──────────────────────────────────

export const MODEL_ID_MAX = 80;

/**
 * 허용 문자 집합. 실제 모델 id 는 전부 이 안에 있다
 * (`gemini-3.5-flash-lite` · `claude-haiku-4-5-20251001` · `gpt-5.6-luna`).
 */
export const MODEL_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 이 값은 SDK 를 거쳐 provider API 의 **URL 경로**에 들어간다.
 * 그래서 «모델 이름 화이트리스트»는 안 걸되(§B-3 의 의도된 느슨함),
 * **문자 집합은 화이트리스트로 좁힌다** — 영숫자와 `. _ -` 만 허용한다.
 * 블랙리스트로 슬래시·공백만 막으면 `%2e%2e`(인코딩된 상위 경로)·`?`(쿼리 주입)·
 * `#`(프래그먼트)·`:`(스킴) 이 그대로 통과한다. 실제 모델 id 는 셋 다 이 집합 안에 있다.
 *
 * 반환 규칙:
 *  - 필드 자체가 없거나 `null` → `{ ok: true, value: null }` = "안 골랐다"(추천 기본값을 탄다)
 *  - 빈 문자열·공백만 → **거절**. "안 골랐다"와 "지웠다"를 값으로 구분하기 위해서다.
 *    화면에서 모델을 비우려면 `null` 을 보낸다
 */
export function validateModelId(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: string; code: string; vars?: Record<string, string | number> } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: '모델 이름은 문자열이어야 합니다', code: 'model.notString' };
  }
  if (value.trim() === '') {
    return { ok: false, error: '모델 이름이 비어 있습니다', code: 'model.empty' };
  }
  if (value !== value.trim()) {
    return { ok: false, error: '모델 이름 앞뒤에 공백이 있습니다', code: 'model.padded' };
  }
  if (value.length > MODEL_ID_MAX) {
    return { ok: false, error: `모델 이름은 ${MODEL_ID_MAX}자까지 입력할 수 있습니다`, code: 'model.tooLong', vars: { max: MODEL_ID_MAX } };
  }
  if (!MODEL_ID_RE.test(value)) {
    return {
      ok: false,
      error: '모델 이름에는 영문·숫자와 . _ - 만 쓸 수 있습니다',
      code: 'model.chars',
    };
  }
  return { ok: true, value };
}

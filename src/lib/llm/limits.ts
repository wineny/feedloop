// 일일 즉답 상한의 «판정» 부분. 의존성 0 이다.
//
// usage.ts 와 나눠 둔 이유: 운영자 화면(클라이언트 컴포넌트)이 "지금 상한이 몇인지"를
// 그려야 하는데, usage.ts 는 bumpUsage 때문에 @/lib/supabase 를 끌어온다.
// 서버 전용 모듈이 클라이언트 번들에 딸려 들어가지 않게 순수한 것만 여기 둔다.
// (lib/bot/appearance.ts 가 같은 이유로 의존성 0 이다)

/**
 * ⚠️ 2026-09-20 결정(ny) — 플랫폼 폴백 모델을 Haiku 4.5 → **Claude Sonnet 5** 로 올린다.
 *    근거는 속도가 아니라 «지어냄»이다 — 지식 밖 사실 질문 6회에서 Haiku 는 2번 지어냈고
 *    (I-08 사고와 같은 유형) Sonnet 은 0번, 6/6 을 담당자에게 넘겼다. 지연은 거의 같다
 *    (지식 6.8K 실은 실측 중앙값 Haiku 2.2초 · Sonnet 2.5초, 위젯 10초 예산에 여유).
 *    ⚠️ 「생각 끄기」는 오히려 느렸다(3.9초) — 본문을 더 길게 쓴다. 기본 그대로 둔다.
 *    입력 단가는 2배($1 → $2 / 1M)라 아래 최악값 셈도 두 배로 읽을 것.
 *
 * ⚠️ 2026-09-13 결정(ny) — 키 없음 상한을 30 → **100** 으로 올렸다. **모델은 이 파일이 아니라 Vercel env
 *    (`PLATFORM_LLM_PROVIDER=anthropic` + `PLATFORM_LLM_MODEL`)가 정한다** — 화면이 말하는 이름은
 *    이제 `PLATFORM_MODEL_LABEL` 한 곳뿐이지만(2026-09-20 에 네 곳에서 모았다) 그 상수도 «이름»일 뿐이라
 *    여전히 env 교체 «뒤에» 이 코드를 배포해야 하고, 교체 여부는 `/api/health` 의
 *    `runtime.platform_llm_provider` + `platform_llm_model_sha8` 로 확인한다(Haiku = `09d0ceca`).
 *    Sonnet 5 단가($2/$10 per MTok)면 일반 사용(지식 6.8K자·답변 150토큰)은 건당 약 22원이라
 *    하루 100건이 봇당 2,200원쯤이고, **최악값**(지식 상한 8만 자 스터핑 × 100건)은 봇당 하루 약 $6 이다
 *    — Haiku 때의 두 배다. 그래서 계정당 봇 개수 상한(아래 `MAX_BOTS_PER_USER`)이 같이 있다.
 *
 *    운영자 키(BYOK)는 **한도 없음**으로 바꿨다(2026-09-13 ny 결정). 한때 provider 무관 300 이었다.
 *
 * ⚠️ 2026-09-10 공식 가격 확인 결과, 각 provider **추천 모델**의 입력 단가는
 *    gemini-3.5-flash-lite $0.30 · gpt-5.6-luna $0.20 · claude-haiku-4-5 $1.00 (1M 토큰)이다.
 *    이 표는 그대로 유효하다 — provider 를 가르는 필드 자체는 남겨뒀다(BYOK 상한을 나중에
 *    다시 나눌 수 있게). 조정하려면 이 상수 한 줄이면 된다(마이그레이션 불필요).
 */
/**
 * 키 없는 봇이 타는 플랫폼 폴백 모델의 **화면 이름**.
 *
 * 🔴 실제 모델은 이 상수가 «아니라» Vercel env(`PLATFORM_LLM_PROVIDER` + `PLATFORM_LLM_MODEL`)가 정한다.
 *    여긴 화면이 말하는 이름일 뿐이라 **env 를 바꾸면 여기도 같이 바꿔야 한다** — 안 바꾸면 화면이 거짓말한다.
 *    순서는 언제나 «env 먼저, 이 코드 나중»이고, 교체 여부는 `/api/health` 의
 *    `runtime.platform_llm_provider` + `platform_llm_model_sha8` 로 확인한다.
 *
 * 2026-09-20: 이 이름이 화면 네 곳에 글자로 흩어져 있어 한 곳으로 모았다. 모으기 전에는
 * env 를 바꿀 때마다 네 곳을 빠짐없이 찾아야 했고, 하나만 놓쳐도 그 화면만 옛 모델을 말했다.
 */
export const PLATFORM_MODEL_LABEL = 'Claude Sonnet 5';

export const DEFAULT_LIMITS = {
  /** 키 없음 = 우리 플랫폼 키(모델 이름은 `PLATFORM_MODEL_LABEL`)로 도는 무료분 */
  noKey: 100,
  /**
   * 운영자 키가 있으면 **한도 없음**(2026-09-13 ny 결정: 「각자 키를 넣으면 무제한으로 풀어줘도 된다」).
   * 요금이 운영자 자기 키로 나가므로 우리가 뚜껑을 씌울 이유가 없다. `daily_reply_limit` 예외는 여전히 이긴다.
   * Infinity 는 JSON 으로 못 나가므로 API 는 `null` 로 내보낸다(llm-key GET) — 화면은 `null` = 한도 없음.
   */
  withKey: Number.POSITIVE_INFINITY,
} as const;

/** `resolveLimit` 이 보는 것. `BotConfig`(handler.ts)가 이 필드들을 그대로 싣는다. */
export interface LimitInputs {
  dailyReplyLimit?: number | null;
  llmApiKeyEncrypted?: string | null;
  llmProvider?: string | null;
}

/**
 * 오늘 이 봇이 자동 답변할 수 있는 최대 건수.
 * `daily_reply_limit` 이 있으면 provider·키 유무와 **무관하게** 그 값이 이긴다
 * (데모 봇 2000 예외가 이 경로로 산다).
 */
export function resolveLimit(bot: LimitInputs): number {
  if (bot.dailyReplyLimit != null) return bot.dailyReplyLimit;
  if (!bot.llmApiKeyEncrypted) return DEFAULT_LIMITS.noKey;
  return DEFAULT_LIMITS.withKey;
}

/** 화면·JSON 용. 한도 없음(Infinity)은 `null` 로 나간다. */
export function limitForDisplay(limit: number): number | null {
  return Number.isFinite(limit) ? limit : null;
}

/**
 * 운영자가 키를 «빼면» 돌아가는 하루 상한. 키 제거 확인 문구가 이 값을 쓴다(I-26).
 *
 * 숫자를 문구에 박지 않는다 — 상한 예외(`daily_reply_limit`)가 걸린 봇은 키가 있든 없든 그 예외가
 * 이기므로 「무료 하루 100건으로 돌아가요」는 그 운영자에게 거짓말이다. 예외가 없으면 키 없음 무료분이다.
 * `dailyLimit` 은 llm-key GET 이 주는 화면용 값(`null` = 한도 없음)과 같은 모양이다.
 */
export function limitAfterKeyRemoval(state: { dailyLimit: number | null; dailyLimitOverridden: boolean }): number {
  if (state.dailyLimitOverridden && state.dailyLimit !== null) return state.dailyLimit;
  return DEFAULT_LIMITS.noKey;
}

/**
 * 선증가 후판정 한 묶음. `bumpUsage` 결과와 상한을 견줘 "지금 불러도 되는가"를 답한다.
 * 계측 실패(`null`)는 초과와 같게 다룬다.
 */
export function isOverLimit(attempts: number | null, limit: number): boolean {
  if (attempts === null) return true;
  return attempts > limit;
}

/**
 * 계정당 등록 가능한 서비스(봇) 수. 플랫폼 폴백 지출의 «승수»를 막는 값이다
 * (봇 하나의 최악값 × 봇 개수가 하루 청구액이 되므로 — 위 `DEFAULT_LIMITS` 주석 참고).
 *
 * ⚠️ 판정은 `api/bots` POST 가 하고, 이 파일은 그 값을 담아 두기만 한다.
 *    여기 둔 이유는 랜딩 「확장」 섹션이 같은 숫자를 그려야 하는데,
 *    라우트 파일에서 가져오면 `next-auth`·`@/lib/supabase` 가 랜딩의 모듈 그래프에 딸려 오기 때문이다.
 *    이 파일은 의존성 0 이라 어느 쪽에서 가져가도 안전하다.
 */
export const MAX_BOTS_PER_USER = 10;

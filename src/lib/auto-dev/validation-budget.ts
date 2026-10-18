import { AsyncLocalStorage } from 'node:async_hooks';

export interface GenerationBudget {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reservedUsd: number;
  deadline: number;
  onReserve?: (budget: GenerationBudget) => Promise<void>;
}

export const generationBudget = new AsyncLocalStorage<GenerationBudget>();

// Pinned operator price table; unknown model IDs fail closed. USD / million tokens.
const PRICES: Record<string, [number, number]> = {
  // 엔진 기본 모델(`FEEDLOOP_FIX_MODEL` 미설정 시). 공식 가격 $5/$25 per MTok.
  // 🔴 이게 빠져 있어서 프로덕션 자동 PR 이 `budget_unverifiable` 로 100% 멈춰 있었다 —
  // 코드 기본값이 가격표에 없는 모델이었다. **기본값을 바꾸면 여기도 반드시 같이 바꿀 것.**
  // 2026-09-20: 기본을 sonnet-5 → opus-5 로 올렸다(ny: 심사자가 써볼 때 수정안 품질이 중요).
  // 단가가 정확히 2.5배라 아래 달러 상한도 같은 비율로 올렸다.
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-5-20250929': [3, 15],
  'claude-haiku-4-5-20251001': [1, 5],
};

export function reserveGeneration(b: GenerationBudget, prompt: string, maxTokens: number): void {
  if (![b.calls, b.inputTokens, b.outputTokens, b.reservedUsd, b.deadline].every(n => Number.isFinite(n) && n >= 0)) {
    throw new Error('budget_unverifiable');
  }
  if (!knownFixModel(b.model) || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('budget_unverifiable');
  }
  const price = PRICES[b.model];

  // UTF-8 bytes conservatively bound input tokens, including fixed message framing.
  const input = Buffer.byteLength(prompt, 'utf8') + 1024;
  const cost = (input * price[0] + maxTokens * price[1]) / 1e6;
  if (Date.now() >= b.deadline) throw new Error('deadline_exceeded');
  if (
    // 1-pass + 2-pass + 3-pass(I-24 재시도 1회) + 수리 재시도 2회 = 5. 아래 입력·달러 상한도 이 다섯 번이 실측 크기로
    // 다 들어가게 맞춰 두었다(테스트 「realistic sizes」). 호출 수가 실효 천장이다.
    b.calls >= 5 ||
    // ⚠️ 여기 `input` 은 토큰이 아니라 UTF-8 «바이트»다(위에서 토큰의 보수적 상한으로 쓴다).
    // 한글 주석·문자열이 많은 레포에선 실제 토큰의 1.5~3배로 과다 계산된다.
    // 40,000 이면 실제 레포에서 2-pass 가 늘 걸렸다 — 후보 1개 + 이웃 3개 원본만
    // 32,773 바이트인데 1-pass 가 이미 16,231 을 쓴다(널널투어 실측).
    // 실제 지출 천장은 아래 `reservedUsd > 0.25` 가 계속 맡는다.
    // 120,000 → 400,000 (2026-09-16, I-24): 2-pass 에 레포 파일 목록(≈12KB)이 들어가고 3-pass 가 원본 2개를 더 실어
    // 한 번 더 돈다 — 널널투어 셈으로 16K + 46K + 77K = 139K. 수리는 그 프롬프트에 이전 패치 전문(JSON)을 다시 실어
    // 회당 ≈110K 라 2회면 359K. 200,000 이던 때는 3-pass 뒤 수리 1회에서 막혔다(ny 결정으로 올림).
    b.inputTokens + input > 400_000 ||
    // 1-pass 1,024 + 2-pass 24,000 + 3-pass 24,000 + 수리 재시도 3,000×2 = 55,024 이 들어가야 한다.
    // (2-pass 가 16,000 이던 때 20,000 으로 두면 24 토큰이 모자라 강한 경로의 재시도가 통째로
    // 막혔다 — 테스트가 잡았다. 2-pass 를 올리면 이 값도 같은 셈으로 올린다.)
    // 32,000 → 56,000 (2026-09-16, I-24): 3-pass 는 2-pass 를 한 번 더 도는 것이라 24,000 이 한 번 더 든다.
    // 32,000 이던 때는 3-pass 의 두 번째 2-pass 가 예약 단계에서 «항상» budget_exhausted 였다(테스트가 잡았다).
    // 실제 지출 천장은 아래 달러 상한이 계속 맡는다.
    b.outputTokens + maxTokens > 56_000 ||
    // 예약은 «실사용»이 아니라 max_tokens 기준 최악값이다 — 실제 청구는 보통 훨씬 적다
    // (측정된 성공 1회 ≈ $0.16). 이 값이 run 한 번이 쓸 수 있는 돈의 실효 천장이다.
    // 0.40 → 0.50 (2026-09-16): 2-pass 출력 24,000 은 예약만으로 $0.24 라, 원본 60KB 짜리 2-pass 가
    // 1-pass 몫과 합쳐 0.40 을 넘어 «시작도 못 하고» budget_exhausted 가 됐다. 실제 청구는 여전히 그 아래다.
    // 0.50 → 0.90 → 1.50 (2026-09-16, I-24): 3-pass 재시도는 2-pass 예약을 한 번 더 쌓는다. 널널투어 실측 크기로
    // 1-pass(16KB) 0.045 + 2-pass(45KB) 0.332 + 3-pass(76KB) 0.394 = 0.771, 수리(110KB·3,000) 0.252×2 = 1.275.
    // 0.90 이던 때는 3-pass 뒤 수리 1회에서 막혀 「호출 5회」 주석이 거짓이었다(리뷰 지적, ny 결정으로 올림).
    // 실제 청구는 여전히 그 훨씬 아래(측정 성공 1회 ≈ $0.16)다 — 예약은 max_tokens 기준 최악값이다.
    // 1.50 → 3.75 (2026-09-20, opus-5): 단가가 sonnet 의 정확히 2.5배($5/$25 vs $2/$10)라
    // 위 실측 셈이 그대로 2.5배가 된다 — 1.275 × 2.5 = 3.19. 상한만 그대로 두면 3-pass 도중
    // budget_exhausted 로 멈춘다(모델을 올려놓고 예산을 안 올리면 «더 나빠진다»).
    // 호출 5회·입력 400,000 바이트·출력 56,000 토큰 상한은 모델과 무관해 그대로다.
    b.reservedUsd + cost > 3.75
  ) {
    throw new Error('budget_exhausted');
  }

  b.calls++;
  b.inputTokens += input;
  b.outputTokens += maxTokens;
  b.reservedUsd += cost;
}

export function knownFixModel(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

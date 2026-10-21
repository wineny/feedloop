// 머지 없이 닫힌 PR 의 「왜」 — 자동 PR 정확도의 계측 재료.
//
// `closed_at` 은 GitHub 상태를 보고 자동으로 찍힌다(loop-closed.ts). 그러나 닫힌 이유는
// GitHub 가 모른다 — 경로를 지어냈는지, 실재 파일을 건드렸으나 인과가 틀렸는지(PR #6),
// 그냥 중복이었는지(PR #4)는 사람만 안다. 그래서 사유는 **사람이 「수정 PR」 화면에서 고른다**
// (2026-09-10 결정). 자동 추론은 사유 자체가 환각일 수 있어 뺐다.
//
// 우버 팀 사례의 「가시성」 항목을 따른 것이다 — 강제 상한이 아니라 판단 재료를 쌓는다.
// 사유가 쌓이면 어떤 실패가 반복되는지 보이고, 그게 다음 방어(경로 대조·임포트 그라운딩 …)의 근거가 된다.

export const CLOSE_REASONS = [
  'hallucinated_path',
  'wrong_causality',
  'duplicate',
  'superseded',
  'other',
] as const;

export type CloseReason = (typeof CLOSE_REASONS)[number];

export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  hallucinated_path: '없는 경로·심볼을 지어냄',
  wrong_causality: '인과가 틀린 수정',
  duplicate: '중복 PR',
  superseded: '다른 PR 로 대체됨',
  other: '기타',
};

/** 화면 셀렉트에 붙는 한 줄 설명. 어떤 사고가 여기 해당하는지 예로 알려준다. */
export const CLOSE_REASON_HINT: Record<CloseReason, string> = {
  hallucinated_path: '존재하지 않는 파일·함수·번역 키를 참조해 빌드가 깨지거나 쓸모없는 파일이 생김 (PR #1·#5 형)',
  wrong_causality: '실재 파일을 고쳤지만 증상과 무관하거나 도달 불가능한 코드 (PR #6 형)',
  duplicate: '같은 문제로 이미 PR 이 있었음 (PR #4 형)',
  superseded: '사람이 직접 고쳤거나 다른 PR 이 같은 문제를 해결함',
  other: '위에 없는 이유 — 메모에 적어두세요',
};

export const CLOSE_NOTE_MAX = 500;

export function isCloseReason(v: unknown): v is CloseReason {
  return typeof v === 'string' && (CLOSE_REASONS as readonly string[]).includes(v);
}

export type CloseReasonPatch =
  | { ok: true; close_reason: CloseReason | null; close_note: string | null }
  | { ok: false; error: string; code: string; vars?: Record<string, string | number> };

/**
 * PATCH 본문 검증. `close_reason: null` 은 「미분류로 되돌림」이다.
 * 메모는 사유 없이 혼자 있을 수 없다 — 사유가 null 이면 메모도 지운다.
 */
export function parseCloseReasonPatch(body: unknown): CloseReasonPatch {
  if (!body || typeof body !== 'object') return { ok: false, error: '잘못된 요청 형식입니다', code: 'badRequest' };
  const b = body as { close_reason?: unknown; close_note?: unknown };

  if (!('close_reason' in b)) return { ok: false, error: 'close_reason 이 필요합니다', code: 'closeReason.required' };
  if (b.close_reason !== null && !isCloseReason(b.close_reason)) {
    return {
      ok: false,
      error: `close_reason 은 ${CLOSE_REASONS.join(', ')} 중 하나거나 null 이어야 합니다`,
      code: 'closeReason.invalid',
      vars: { allowed: CLOSE_REASONS.join(', ') },
    };
  }
  const reason = b.close_reason as CloseReason | null;

  let note: string | null = null;
  if (b.close_note !== undefined && b.close_note !== null) {
    if (typeof b.close_note !== 'string') return { ok: false, error: 'close_note 는 문자열이어야 합니다', code: 'closeReason.noteNotString' };
    const trimmed = b.close_note.trim();
    if (trimmed.length > CLOSE_NOTE_MAX) {
      return { ok: false, error: `close_note 는 ${CLOSE_NOTE_MAX}자 이하여야 합니다`, code: 'closeReason.noteTooLong', vars: { max: CLOSE_NOTE_MAX } };
    }
    note = trimmed || null;
  }

  return { ok: true, close_reason: reason, close_note: reason ? note : null };
}

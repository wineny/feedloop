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

// 화면 문구(사유 이름·한 줄 설명)는 사전 `monitor.closeReason.<코드>.label|hint` 에 있다.

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

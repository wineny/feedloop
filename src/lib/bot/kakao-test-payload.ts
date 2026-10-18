// 오픈빌더 스킬 화면의 「스킬서버로 전송」 테스트 요청 판별.
//
// 이 버튼은 실제 사용자 발화가 아니라 JSON 미리보기의 고정 플레이스홀더를 그대로 보낸다.
// 그걸 messages 에 저장하면 대시보드에 더미가 쌓이므로, 연결 확인만 하고 저장은 건너뛴다.

export interface KakaoSkillPayload {
  userRequest?: {
    utterance?: string;
    params?: Record<string, unknown>;
    block?: { id?: string; name?: string };
    user?: { id?: string; type?: string };
  };
}

// 오픈빌더가 채워 넣는 자리표시자 문자열. 실제 발화·블록명과 겹칠 여지는 사실상 없다.
const TEST_PLACEHOLDERS = new Set(['발화 내용', '블록 이름', '사용자 ID', '봇 이름']);

export function isOpenBuilderTest(payload: KakaoSkillPayload): boolean {
  const req = payload.userRequest;
  if (!req) return false;

  // 테스트 JSON 에만 들어 있는 파라미터 — 가장 확실한 신호
  if (req.params?.ignoreMe === 'true') return true;

  if (TEST_PLACEHOLDERS.has(req.utterance?.trim() ?? '')) return true;
  if (TEST_PLACEHOLDERS.has(req.block?.name?.trim() ?? '')) return true;
  if (TEST_PLACEHOLDERS.has(req.user?.id?.trim() ?? '')) return true;

  return false;
}

// 「고른 모델」을 「보낼 모델」로 접는 규칙. 의존성 0 이다.
//
// <select> 에는 실제 모델 id 말고 두 개의 특수 상태가 있다 — 「자동」(빈 문자열)과
// 「직접 입력…」(CUSTOM_MODEL). 그 둘을 서버가 아는 값(`string | null`)으로 접는 일을
// 화면마다 다시 쓰면 한쪽만 어긋난다. 등록 화면·설정 탭·폼 스키마가 이 하나를 본다.
//
// (lib/llm/models.ts · lib/llm/key-format.ts 와 같은 이유로 의존성이 0 이다 —
//  서버 라우트와 클라이언트 컴포넌트가 같이 읽는다)

/** 「직접 입력」을 고른 상태. 실제 모델 이름과 겹칠 수 없는 값이어야 한다. */
export const CUSTOM_MODEL = '__custom__';

/**
 * 서버로 보낼 모델 값.
 * `null` = "안 골랐다" — 추천 기본값(`RECOMMENDED`)을 탄다는 뜻이다.
 * 「직접 입력」인데 칸이 비었으면 역시 `null` 로 접는다(빈 문자열은 라우트가 거절한다).
 */
export function draftModelValue(modelChoice: string, customModel: string): string | null {
  if (modelChoice === CUSTOM_MODEL) return customModel.trim() || null;
  return modelChoice || null;
}

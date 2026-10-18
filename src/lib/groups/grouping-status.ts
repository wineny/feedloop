// 자동 묶기 상태 — 운영자 화면이 그리는 모양. 의존성 0.
//
// `auto-grouping.ts` 는 service_role 클라이언트를 쥔 서버 모듈이라 클라이언트 컴포넌트가
// 거기서 무엇이든 «값»을 하나 가져오는 순간 그 그래프가 브라우저 번들에 들어온다.
// 타입만 여기 두고 화면은 여기서만 import 한다.

export interface GroupingStatus {
  /** 아직 안 묶인 묶기 대상(bug·ux·feature_request) 인사이트 수. */
  pending: number;
  /** 가장 이른 예정 시각. 없으면 null. */
  dueAt: string | null;
  /** 지금 묶는 중인가(잠금이 살아 있는 봇이 하나라도). */
  running: boolean;
  /** 가장 최근 자동 묶기 «성공» 시각. */
  lastGroupedAt: string | null;
}

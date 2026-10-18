import type { PickedShotData } from '@/lib/widget/picked-shot';

// 피드백 화면이 다루는 인사이트 한 건. GET /api/classify 의 행 모양과 같다.
// group_id·messages.source 는 2026-09-06 에 추가돼 예전 데모 데이터에는 없을 수 있다 — 옵셔널.

export interface Insight {
  id: string;
  category: string;
  summary: string;
  sentiment: string;
  follow_up_needed: boolean;
  created_at: string;
  message_id: string;
  group_id?: string | null;
  // I-05 — 위젯 즉답이 꼬리질문 답을 기존 인사이트 갱신으로 흡수할 때 쌓인다.
  // 2026-09-13 에 추가돼 예전 행에는 빈 배열/NULL 일 수 있다 — 옵셔널.
  source_message_ids?: string[];
  updated_at?: string | null;
  messages: {
    body: string;
    author_name: string;
    chat_id: number;
    source?: string | null;
    detected_at: string;
  } | null;
  /** 방문자가 화면에서 짚은 요소 + 찍은 화면(I-55). 운영자 라우트만 싣는다 */
  picked?: PickedShotData | null;
  /** 분류를 누가 확정했나 — Jev(결정 전용 모델, 확신 0.7 이상) 아니면 LLM. 2026-10-09 추가라 예전 행엔 없다 */
  classified_by?: 'jev' | 'llm' | null;
  /** Jev 의 카테고리 확신(0~1). LLM 이 확정했으면 null */
  classify_confidence?: number | null;
}

/** 대시보드 /api/groups 가 주는 묶음 요약 중 이 화면이 쓰는 부분 */
export interface GroupRef {
  id: string;
  title: string;
  insightCount: number;
  pr: { url: string; number: number; mergedAt: string | null } | null;
}

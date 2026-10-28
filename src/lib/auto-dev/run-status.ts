/**
 * 진행 중인 자동개발 실행 상태. DB 의 활성 유니크 인덱스(`auto_dev_active_group`)와 같은 집합이다 —
 * 엔진이 리스를 쥔 채 행이 사라지면 결과 저장이 실패하고 GitHub 에 브랜치·PR 이 고아로 남는다.
 * 봇 삭제(api/bots/[id])와 데모 비우기(lib/demo/reset)가 이 상태를 보고 거부한다.
 */
export const ACTIVE_RUN_STATUSES = ['running', 'in_progress'] as const;

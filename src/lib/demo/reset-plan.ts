// 데모 봇 비우기(scripts/reset-demo.ts)의 표 목록과 순서. 순수 데이터라 테스트가 schema.sql 과 대조한다
// (__tests__/demo-reset-plan.test.ts). 새 마이그레이션이 bots 를 참조하는 표를 더하면 그 테스트가
// 「지울지 남길지」를 정하라고 실패한다.
//
// ny 결정(2026-10-27): 비우기만 한다 — 다시 채우지 않는다. 봇 설정(지식·위젯 모양·상품·환불 한도·
// PayPal 연결·승인자)은 그대로 두고, 방문자가 만든 흔적과 그 뒤에 따라온 기록만 지운다.
// 실행 로직은 ./reset.ts(runReset), CLI 는 scripts/reset-demo.ts.

import { ACTIVE_RUN_STATUSES } from '@/lib/auto-dev/run-status';

/** 직접 DELETE 는 전부 이 열로 데모 봇 한 대에 묶는다(CASCADE 자식은 부모를 따라 지워진다). 다른 봇 행은 건드리지 않는다. */
export const BOT_SCOPE_COLUMN = 'bot_id';

/**
 * 지우는 순서 그대로. 자식이 부모보다 앞에 온다 — 지울 표끼리의 FK 는 모두 「뒤에 오는 표」를 가리킨다.
 * 특히 responses.trigger_message_id → messages 는 ON DELETE 가 없어(NO ACTION) responses 가 먼저여야 한다.
 */
export const DEMO_RESET_DELETE: readonly { table: string; what: string }[] = [
  { table: 'payment_actions', what: 'refund / dispute write-ahead rows and approvals' },
  { table: 'paypal_orders', what: 'PayPal orders (the money ledger)' },
  { table: 'paypal_webhook_events', what: 'stored PayPal webhook events' },
  { table: 'payment_verifications', what: 'payments verified inside a conversation' },
  { table: 'widget_shots', what: 'widget screenshots (storage objects removed first)' },
  { table: 'handoff_email_deliveries', what: 'owner handoff email notifications' },
  { table: 'responses', what: 'bot / operator replies' },
  { table: 'insight_message_sources', what: 'message → insight links' },
  { table: 'classification_recovery_cycles', what: 'classification retry log' },
  { table: 'auto_dev_runs', what: 'auto-dev runs and their PR records' },
  { table: 'insights', what: 'classified insights' },
  { table: 'insight_groups', what: 'insight groups' },
  { table: 'messages', what: 'visitor messages' },
  { table: 'conversations', what: 'visitor conversations' },
  { table: 'bot_usage', what: 'daily AI call counters' },
];

/** bot_id 가 없어 직접 못 고르는 자식. 부모를 지우면 ON DELETE CASCADE 로 같이 사라진다. */
export const DEMO_RESET_CASCADE: readonly { table: string; parent: string; fk: string }[] = [
  { table: 'payment_announcements', parent: 'payment_actions', fk: 'action_id' },
  { table: 'response_confirmation_history', parent: 'responses', fk: 'response_id' },
  { table: 'auto_dev_attempts', parent: 'auto_dev_runs', fk: 'run_id' },
];

/** 남기는 표. 봇 설정이거나(앞 4개), 전역이거나, 다시 만들어지는 내부 상태다. */
export const DEMO_RESET_KEEP: readonly string[] = [
  'bots', // 지식·위젯 모양·환불 한도·PayPal 연결·웹훅 id 가 전부 이 행의 열이다
  'products',
  'bot_members',
  'users',
  'accounts',
  'sessions',
  // 그룹 묶기 동시성 카운터(revision). 지우면 0 으로 돌아가 진행 중인 묶기 작업이 옛 revision 으로 커밋할 수 있다.
  'grouping_revisions',
  'cooldown_state', // 텔레그램 시절 봇 단위 쿨다운. 웹 데모 봇은 안 쓴다
  // 봇과 무관한 전역 표
  'feedbacks',
  'classifications',
  'action_logs',
  'draft_pr_gate_locks',
];

/** 이 상태의 행이 있으면 --yes 를 거부한다. 진행 중인 PR 생성·환불 실행 중간에 기록을 지우면 안 된다. */
export const IN_FLIGHT = {
  autoDevRunStatuses: ACTIVE_RUN_STATUSES,
  autoDevPublicationStatuses: ['pending'],
  paymentActionStatuses: ['executing', 'unknown'],
} as const;

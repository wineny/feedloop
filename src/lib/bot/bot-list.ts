// What the /bots list may show about a bot the viewer does NOT own (stage 3, 6/6).
//
// An approver (bot_members — the hackathon demo bot's judges) operates the bot's inbox and decides
// refunds. They never see its knowledge text, API-key tail, GitHub token/app details or the owner's
// account id: those belong to the owner's settings screens. The list therefore reads approver rows
// with a separate, short column list and maps them through `toApproverView`, which only ever copies
// the fields named here — a wider row (a test, a future column) cannot leak through it.

/** Columns read for an approver row. Identity, status and the three "is feedback arriving" timestamps. */
export const APPROVER_BOT_COLUMNS =
  'id, service_name, service_url, service_description, status, display_name, widget_connected_at, channel_connected_at, last_active_at, created_at';

export interface ApproverBotView {
  id: string;
  service_name: string;
  service_url: string | null;
  service_description: string | null;
  status: string;
  display_name: string | null;
  widget_connected_at: string | null;
  channel_connected_at: string | null;
  last_active_at: string | null;
  created_at: string;
}

const APPROVER_FIELDS: (keyof ApproverBotView)[] = [
  'id',
  'service_name',
  'service_url',
  'service_description',
  'status',
  'display_name',
  'widget_connected_at',
  'channel_connected_at',
  'last_active_at',
  'created_at',
];

/** Fields that must never reach a non-owner, whatever the row carries. Checked by the test, not at runtime. */
export const OWNER_ONLY_FIELDS = [
  'user_id',
  'knowledge_text',
  'knowledge_faq',
  'llm_provider',
  'llm_model',
  'llm_key_last4',
  'llm_key_failed_at',
  'llm_api_key_encrypted',
  'daily_reply_limit',
  'github_repo_url',
  'github_token_last4',
  'github_token_failed_at',
  'github_token_broad',
  'github_installation_id',
  'github_installation_login',
  'github_installation_lost_at',
  'paypal_client_id',
  'paypal_secret_encrypted',
  'paypal_secret_last4',
  'greeting',
  'operator_display_name',
  'pr_mode',
] as const;

/** Copies only the approver-safe fields; everything else on the row is dropped. */
export function toApproverView(row: Record<string, unknown>): ApproverBotView {
  const view: Record<string, unknown> = {};
  for (const key of APPROVER_FIELDS) view[key] = row[key] ?? null;
  view.id = String(row.id ?? '');
  view.service_name = String(row.service_name ?? '');
  view.status = String(row.status ?? 'pending');
  view.created_at = String(row.created_at ?? '');
  return view as unknown as ApproverBotView;
}

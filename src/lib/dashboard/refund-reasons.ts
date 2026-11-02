// Refund reasons on the dashboard — why customers asked for their money back, sorted by where the reason goes:
//   bug / ux         → `fix`         (a fix PR)
//   feature_request  → `feature`     (a spec)
//   praise / cs / …  → `other`       (price, expectations — visible here, nothing to build)
//   no insight found → `unclassified`
//
// Pure — the route (`/api/dashboard`), the screen and the tests share it. No Node imports: the client imports the types.
// Nothing new is classified here. A refund reason becomes an insight right after the refund turn
// (`classifyRefundReason` → `settleInsight` → `applyInsightWrite`); this only reads which insight that was.

import { ledgerConversationHref } from '@/lib/paypal/ledger';

export type RefundBucket = 'fix' | 'feature' | 'other' | 'unclassified';

export interface RefundReasonItem {
  /** `group:<id>` · `insight:<id>` · `reason:<normalized text>` */
  key: string;
  /** Group title → insight summary → what the customer said. null = no reason text and no insight. */
  label: string | null;
  count: number;
  bucket: RefundBucket;
  /**
   * The fix PR (external, only a `https://github.com/<owner>/<repo>/pull/<n>` URL) when the group/insight has one,
   * else the newest refund's conversation, else null.
   */
  href: string | null;
  external: boolean;
  /** Refund requests of this reason in the last 24 h (`t > now − 24 h`). */
  recent24h: number;
  /** Spike: see `SPIKE_MIN_24H` / `SPIKE_RATIO`. Only ever true on `top` items. */
  spike: boolean;
}

export interface RefundReasons {
  /** Every refund request: every status, with or without a conversation or a reason (`refundReasons` comment). */
  total: number;
  buckets: Record<RefundBucket, number>;
  /** Up to 3, most frequent first; ties → newer first. */
  top: RefundReasonItem[];
}

export const EMPTY_REFUND_REASONS: RefundReasons = {
  total: 0,
  buckets: { fix: 0, feature: 0, other: 0, unclassified: 0 },
  top: [],
};

export const REFUND_REASONS_TOP = 3;

/** A reason is a spike when it has at least this many refunds in the last 24 h … */
export const SPIKE_MIN_24H = 3;
/** … and at least this many times its daily average over the 7 days before that (`(now−8d, now−24h] / 7`). */
export const SPIKE_RATIO = 2;
const DAY_MS = 24 * 60 * 60_000;

/** One `payment_actions` row (kind = 'refund'). */
export interface RefundSource {
  id: string;
  conversation_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface RefundInsightSource {
  id: string;
  message_id: string | null;
  source_message_ids: string[] | null;
  group_id: string | null;
  category: string;
  summary: string;
  created_at: string;
}

/**
 * A message of a refund's conversation. `messages` only holds what the visitor sent (bot answers live in
 * `responses`), so the latest one at/before the refund is the turn that asked for it.
 */
export interface RefundMessageSource {
  id: string;
  conversation_id: string | null;
  created_at: string;
}

export interface RefundRunSource {
  insight_id: string | null;
  group_id: string | null;
  status: string;
  pr_url: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface RefundGroupSource {
  id: string;
  title: string;
}

export function refundBucket(category: string | null | undefined): RefundBucket {
  if (category === 'bug' || category === 'ux') return 'fix';
  if (category === 'feature_request') return 'feature';
  if (category == null) return 'unclassified';
  return 'other';
}

/** trim, lowercase, collapse whitespace — "I bought the wrong plan " and "i bought  the wrong plan" are one reason. */
export function normalizeRefundReason(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** How long after a refund an insight of the same conversation may still be its classification (fallback only). */
export const REFUND_INSIGHT_WINDOW_MS = 10 * 60_000;

/** Only a GitHub pull request URL is linked out. Anything else falls back to the conversation. */
const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export function isGithubPrUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && GITHUB_PR_URL.test(url);
}

/**
 * The insight a refund turned into.
 *
 * Exact link first: the refund turn is the latest visitor message of the conversation at/before the refund
 * (`payment_actions.created_at`). The reason is classified against that message (`applyInsightWrite(…, messageId)`),
 * so its insight has `message_id` = that message — or, when the reason `extend`ed an earlier insight of the same
 * conversation, that message in `source_message_ids` (the earlier insight keeps its own `created_at`).
 *
 * Fallback only when nothing links exactly (e.g. the turn message is missing): the earliest insight of the
 * conversation created within `REFUND_INSIGHT_WINDOW_MS` at/after the refund. Never an older insight — that is
 * some earlier, unrelated report.
 */
export function matchRefundInsight<T extends Pick<RefundInsightSource, 'message_id' | 'source_message_ids' | 'created_at'>>(
  refundAt: string,
  conversationMessages: readonly Pick<RefundMessageSource, 'id' | 'created_at'>[],
  conversationInsights: readonly T[],
): T | null {
  const at = Date.parse(refundAt);
  let turn: Pick<RefundMessageSource, 'id' | 'created_at'> | null = null;
  for (const m of conversationMessages) {
    const t = Date.parse(m.created_at);
    if (t <= at && (turn === null || t > Date.parse(turn.created_at))) turn = m;
  }
  if (turn) {
    const turnId = turn.id;
    const exact =
      conversationInsights.find((i) => i.message_id === turnId) ??
      conversationInsights.find((i) => (i.source_message_ids ?? []).includes(turnId));
    if (exact) return exact;
  }
  let nearest: T | null = null;
  for (const insight of conversationInsights) {
    const t = Date.parse(insight.created_at);
    if (t < at || t - at > REFUND_INSIGHT_WINDOW_MS) continue;
    if (nearest === null || t < Date.parse(nearest.created_at)) nearest = insight;
  }
  return nearest;
}

interface Accumulator {
  item: RefundReasonItem;
  newestAt: number;
  times: number[];
}

export function refundReasons(
  {
    refunds,
    messages,
    insights,
    runs,
    groups,
  }: {
    refunds: readonly RefundSource[];
    messages: readonly RefundMessageSource[];
    insights: readonly RefundInsightSource[];
    runs: readonly RefundRunSource[];
    groups: readonly RefundGroupSource[];
  },
  topLimit = REFUND_REASONS_TOP,
  now: number = Date.now(),
): RefundReasons {
  const conversationByMessage = new Map<string, string>();
  const messagesByConversation = new Map<string, RefundMessageSource[]>();
  for (const m of messages) {
    if (!m.conversation_id) continue;
    conversationByMessage.set(m.id, m.conversation_id);
    const list = messagesByConversation.get(m.conversation_id) ?? [];
    list.push(m);
    messagesByConversation.set(m.conversation_id, list);
  }

  // An insight belongs to a conversation when its own message or any source message (an `extend`) is in it.
  const insightsByConversation = new Map<string, RefundInsightSource[]>();
  for (const insight of insights) {
    const conversations = new Set<string>();
    for (const id of [insight.message_id, ...(insight.source_message_ids ?? [])]) {
      const conversation = id ? conversationByMessage.get(id) : undefined;
      if (conversation) conversations.add(conversation);
    }
    for (const conversation of conversations) {
      const list = insightsByConversation.get(conversation) ?? [];
      list.push(insight);
      insightsByConversation.set(conversation, list);
    }
  }

  // A PR counts only when it was made and not closed without merging — the same rule as the feedback list —
  // and only a GitHub pull request URL is linked out.
  const prByInsight = new Map<string, string>();
  const prByGroup = new Map<string, string>();
  const newestRunsFirst = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of newestRunsFirst) {
    if (run.status !== 'completed' || !isGithubPrUrl(run.pr_url) || run.closed_at) continue;
    if (run.insight_id && !prByInsight.has(run.insight_id)) prByInsight.set(run.insight_id, run.pr_url);
    if (run.group_id && !prByGroup.has(run.group_id)) prByGroup.set(run.group_id, run.pr_url);
  }
  const titleByGroup = new Map(groups.map((g) => [g.id, g.title]));

  const buckets: Record<RefundBucket, number> = { fix: 0, feature: 0, other: 0, unclassified: 0 };
  const items = new Map<string, Accumulator>();
  // Every refund request counts — every status (pending, executing, executed, failed, rejected, expired): a rejected
  // or failed request still carries the customer's reason, and the reason is what this card is about, not the money.
  // A row with no conversation (or no reason) counts too, as unclassified — the total is every refund request.
  const counted = [...refunds].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  for (const refund of counted) {
    const conversation = refund.conversation_id;
    const insight = conversation
      ? matchRefundInsight(refund.created_at, messagesByConversation.get(conversation) ?? [], insightsByConversation.get(conversation) ?? [])
      : null;
    const bucket = refundBucket(insight?.category);
    buckets[bucket] += 1;

    const key = insight?.group_id
      ? `group:${insight.group_id}`
      : insight
        ? `insight:${insight.id}`
        : `reason:${normalizeRefundReason(refund.reason)}`;
    const conversationHref = refund.conversation_id ? ledgerConversationHref(refund.conversation_id) : null;
    const prUrl = insight
      ? (prByInsight.get(insight.id) ?? (insight.group_id ? prByGroup.get(insight.group_id) : undefined) ?? null)
      : null;

    const existing = items.get(key);
    if (existing) {
      // Refunds arrive newest first: the first one set label/bucket/conversation. A PR found later still wins.
      existing.item.count += 1;
      existing.times.push(Date.parse(refund.created_at));
      if (!existing.item.external && prUrl) existing.item = { ...existing.item, href: prUrl, external: true };
      else if (existing.item.href === null && conversationHref) existing.item.href = conversationHref;
      continue;
    }
    const groupTitle = insight?.group_id ? titleByGroup.get(insight.group_id) : undefined;
    const rawReason = refund.reason?.trim() || null;
    items.set(key, {
      newestAt: Date.parse(refund.created_at),
      times: [Date.parse(refund.created_at)],
      item: {
        key,
        label: groupTitle || insight?.summary || rawReason,
        count: 1,
        bucket,
        href: prUrl ?? conversationHref,
        external: prUrl !== null,
        recent24h: 0,
        spike: false,
      },
    });
  }

  const top = [...items.values()]
    .sort((a, b) => b.item.count - a.item.count || b.newestAt - a.newestAt || a.item.key.localeCompare(b.item.key))
    .slice(0, topLimit)
    .map((a) => {
      const recent24h = a.times.filter((t) => t > now - DAY_MS).length;
      const baseline = a.times.filter((t) => t > now - 8 * DAY_MS && t <= now - DAY_MS).length;
      const spike = recent24h >= SPIKE_MIN_24H && recent24h >= SPIKE_RATIO * (baseline / 7);
      return { ...a.item, recent24h, spike };
    });

  return { total: counted.length, buckets, top };
}

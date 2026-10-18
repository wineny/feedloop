interface InsightLink { id: string; message_id: string; source_message_ids?: string[] | null; group_id: string | null }
interface RunLink { id: string; insight_id: string | null; group_id: string | null }
interface Delivery { auto_dev_run_id: string | null; conversation_id: string | null; response_type: string; sent_at: string; delivered_at: string | null }

/** A conversation can contain unrelated issues and reports made after a notification. */
export function messageDelivery(
  message: { id: string; conversation_id: string | null; detected_at: string },
  insights: InsightLink[], runs: RunLink[], responses: Delivery[],
): { returnedAt: string | null; returnQueuedAt: string | null } {
  const linkedInsights = insights.filter(i => i.message_id === message.id || i.source_message_ids?.includes(message.id));
  const runIds = new Set(runs.filter(r => linkedInsights.some(i => r.insight_id === i.id || (i.group_id !== null && r.group_id === i.group_id))).map(r => r.id));
  const related = responses.filter(r => message.conversation_id && r.conversation_id === message.conversation_id && r.response_type === 'loop_closed' && r.auto_dev_run_id && runIds.has(r.auto_dev_run_id) && Date.parse(r.sent_at) >= Date.parse(message.detected_at));
  // The message must predate delivery. A queued card predating a later report is not that report's receipt.
  const returnedAt = related.filter(r => r.delivered_at && Date.parse(r.delivered_at) >= Date.parse(message.detected_at))
    .map(r => r.delivered_at!).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  const returnQueuedAt = returnedAt ? null : related.filter(r => !r.delivered_at && Date.parse(r.sent_at) >= Date.parse(message.detected_at))
    .map(r => r.sent_at).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  return { returnedAt, returnQueuedAt };
}

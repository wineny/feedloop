/** Recovery uses the production widget prompt/parser with original-time conversation context. */
import { getServiceRoleClient } from '@/lib/supabase';
import { getBotConfigFromDB } from '@/lib/bot/core';
import { callLlm, extractResult } from '@/lib/bot/handler';
import { getSystemPrompt } from '@/lib/bot/prompts';
import { GROUNDING_REMINDER, applyHoldingPolicy } from '@/lib/bot/holding';
import { getRecentTurns } from '@/lib/bot/conversations';
import { buildInsightRefMap, buildWidgetUserTurn, formatExtendableSection, formatRecentContext, listExtendableInsights, RECENT_TURNS } from '@/lib/bot/reply-context';
import { planInsightWrite } from '@/lib/bot/db';
import { formatContextForPrompt } from '@/lib/widget/context';
import { isChipOnlyText, hintLine, isWidgetHint } from '@/lib/widget/chips';
import { bumpUsage, isOverLimit, resolveLimit } from '@/lib/llm/usage';
import { refineCategoryWithJev, type ClassificationMetadata } from './jev';
import { normalizeCategory, normalizeSentiment } from './taxonomy';

export function prepareRecoveryCase(p: {
  profile: Parameters<typeof getSystemPrompt>[0];
  timeline: Parameters<typeof formatRecentContext>[0];
  refMap: Parameters<typeof formatExtendableSection>[0];
  messageId: string; text: string; context?: unknown; widget_hint?: string | null;
}) {
  return { system: getSystemPrompt(p.profile), user: buildWidgetUserTurn({
    recent: formatRecentContext(p.timeline, p.messageId, p.profile.serviceName),
    extendable: formatExtendableSection(p.refMap),
    text: [p.text, formatContextForPrompt(p.context)].filter(Boolean).join('\n'),
    hintLine: hintLine(isWidgetHint(p.widget_hint) ? p.widget_hint : null), reminder: GROUNDING_REMINDER,
  }), chipOnly: isChipOnlyText(p.text), missingHistoricalHint: p.widget_hint == null };
}
export function parseRecoveryResult(raw: string, refMap: Parameters<typeof planInsightWrite>[0]['refMap'], text: string, botId?: string) {
  const parsed = applyHoldingPolicy(extractResult(raw), botId);
  return { parsed, plan: planInsightWrite({ insight: parsed.insight, extends: parsed.extends, refMap, text, chipOnly: isChipOnlyText(text) }) };
}

interface RecoveryMessage {
  id: string; bot_id: string; body: string; context: unknown; conversation_id: string | null;
  detected_at: string; classification_lease: string; widget_hint?: string | null;
}
export interface RecoveryResult {
  classified: number; noInsight: number; failed: number; exhausted: number; pending: number;
  results: Record<string, number>; deferred: boolean; missingHistoricalHint: number;
}
export async function runClassificationRecovery(botIds: string[], deadlineMs = Date.now() + 240_000): Promise<RecoveryResult> {
  const db = getServiceRoleClient();
  const result: RecoveryResult = { classified: 0, noInsight: 0, failed: 0, exhausted: 0, pending: 0, results: {}, deferred: false, missingHistoricalHint: 0 };
  for (let n = 0; n < 50; n++) {
    if (Date.now() >= deadlineMs - 1000) { result.deferred = true; break; }
    const claim = await db.rpc('pipeline_claim_message', { p_bot_ids: botIds });
    if (claim.error) throw new Error(claim.error.message);
    const message = (claim.data as RecoveryMessage[] | null)?.[0];
    if (!message) break;
    try {
      if (message.widget_hint == null) result.missingHistoricalHint++;
      let insight: ({ category: string; summary: string; sentiment: string; follow_up_needed: boolean } & Partial<ClassificationMetadata>) | null = null;
      let extendId: string | null = null;
      if (!isChipOnlyText(message.body)) {
        const config = await getBotConfigFromDB(message.bot_id);
        if (!config.llmApiKeyEncrypted && isOverLimit(await bumpUsage(message.bot_id), resolveLimit(config))) throw new Error('usage_limit');
        const [timeline, extendables] = message.conversation_id ? await Promise.all([
          getRecentTurns(message.conversation_id, RECENT_TURNS + 1, message.detected_at),
          listExtendableInsights(message.conversation_id, message.detected_at),
        ]) : [[], []];
        const refs = buildInsightRefMap(extendables);
        if (Date.now() >= deadlineMs) throw new Error('deadline_exhausted');
        const prepared = prepareRecoveryCase({ profile: config.serviceProfile, timeline, refMap: refs,
          messageId: message.id, text: message.body, context: message.context, widget_hint: message.widget_hint });
        const raw = await callLlm(config, prepared.system, prepared.user,
          { timeoutMs: Math.min(60_000, deadlineMs - Date.now()), recordKeyFailure: false });
        if (!raw) throw new Error('model_failed');
        const { parsed, plan } = parseRecoveryResult(raw, refs, message.body, message.bot_id);
        if (!parsed.parsed) throw new Error('invalid_model_output');
        if (plan.action === 'update') extendId = plan.id;
        if (parsed.insight) insight = { ...parsed.insight, category: normalizeCategory(parsed.insight.category),
          sentiment: normalizeSentiment(parsed.insight.sentiment), follow_up_needed: parsed.escalate === true };
        if (plan.action === 'insert' && insight) insight = await refineCategoryWithJev(message.body, insight);
      }
      const saved = await db.rpc('pipeline_settle_insight', {
        p_bot_id: message.bot_id, p_message_id: message.id, p_insight: insight,
        p_extend_id: extendId, p_lease: message.classification_lease,
      });
      if (saved.error) throw new Error(saved.error.message);
      if (saved.data?.id) {
        result.classified++;
        if (insight) result.results[insight.category] = (result.results[insight.category] ?? 0) + 1;
      } else result.noInsight++;
    } catch (error) {
      result.failed++;
      // Store bounded stable reasons, not provider payloads or user data.
      const reason = error instanceof Error && ['usage_limit', 'deadline_exhausted', 'model_failed', 'invalid_model_output'].includes(error.message)
        ? error.message : 'recovery_failed';
      const failed = await db.rpc('pipeline_fail_message', { p_bot_id: message.bot_id, p_message_id: message.id,
        p_lease: message.classification_lease, p_reason: reason });
      if (failed.error) throw new Error(`recovery_state_failed: ${failed.error.message}`);
    }
  }
  const [pending, exhausted] = await Promise.all([
    db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', botIds).in('classification_state', ['pending', 'failed', 'processing']),
    db.from('messages').select('id', { count: 'exact', head: true }).in('bot_id', botIds).eq('classification_state', 'exhausted'),
  ]);
  if (pending.error || exhausted.error) throw new Error('recovery_counts_failed');
  result.pending = pending.count ?? 0; result.exhausted = exhausted.count ?? 0;
  return result;
}

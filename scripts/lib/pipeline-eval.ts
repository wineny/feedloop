import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { getSystemPrompt } from '../../src/lib/bot/prompts';
import { extractResult } from '../../src/lib/bot/handler';
import { applyHoldingPolicy, GROUNDING_REMINDER } from '../../src/lib/bot/holding';
import { buildInsightRefMap, buildWidgetUserTurn, formatExtendableSection, formatRecentContext, type ExtendableInsight } from '../../src/lib/bot/reply-context';
import { planInsightWrite } from '../../src/lib/bot/db';
import { chipOnlyLine, hintLine, isChipOnlyText, type WidgetHint } from '../../src/lib/widget/chips';
import { sanitizeWidgetContext, formatContextForPrompt } from '../../src/lib/widget/context';
import type { TimelineItem } from '../../src/lib/bot/conversations';
import { parseRealtime, score, type EvalCase, type Outcome } from './classify-eval';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const PROFILE = { botName: '피드백봇', botTone: '친근하고 간결하게', serviceName: '이 서비스', serviceUrl: '', serviceDescription: '베타 테스트 중인 웹 서비스', serviceCompany: '', targetUsers: '베타 테스터', serviceFeatures: [], loginMethod: '', faq: [], knowledge: '' };
export interface PipelineCase extends EvalCase {
  history?: Array<{ kind: TimelineItem['kind']; body: string }>;
  existing?: ExtendableInsight[];
  hint?: WidgetHint;
  context?: unknown;
  provenance?: 'human' | 'model' | 'unknown';
  expectedWrite?: 'insert' | 'update' | 'skip';
  expectedTarget?: string;
}
export function prepareCase(c: PipelineCase, phase: 'baseline' | 'candidate' = 'candidate') {
  const refMap = buildInsightRefMap(c.existing ?? []);
  const chipOnly = isChipOnlyText(c.text);
  const timeline = (c.history ?? []).map((t, i) => ({ ...t, id: `turn-${i}`, at: '2026-09-13T00:00:00Z' })) as TimelineItem[];
  return { system: getSystemPrompt(PROFILE), prompt: buildWidgetUserTurn({ recent: formatRecentContext(timeline, null, PROFILE.serviceName), extendable: formatExtendableSection(refMap), text: [c.text.trim(), phase === 'candidate' ? formatContextForPrompt(c.context) : ''].filter(Boolean).join('\n'), hintLine: chipOnly ? chipOnlyLine(c.hint) : hintLine(c.hint), reminder: GROUNDING_REMINDER }), refMap, chipOnly, sanitizedContext: sanitizeWidgetContext(c.context) };
}
export function parseCase(c: PipelineCase, raw: string, callIndex: number) {
  const prepared = prepareCase(c);
  const result = applyHoldingPolicy(extractResult(raw));
  if (prepared.chipOnly) { result.insight = null; result.extends = null; }
  const write = planInsightWrite({ insight: result.insight, extends: result.extends, refMap: prepared.refMap, chipOnly: prepared.chipOnly });
  return { ...parseRealtime(c, JSON.stringify(result), callIndex), ...(result.parsed === false ? { status: 'parse' as const } : {}), write, response: result.response, sanitizedContext: prepared.sanitizedContext };
}
/** Bytes are a conservative token upper bound; wrapper allowance is explicit, not a chars/4 estimate. */
export function reservation(system: string, prompt: string, maxOutputTokens = 1400) {
  const inputUpperBound = Buffer.byteLength(system + prompt, 'utf8') + 512;
  const reservedUsd = inputUpperBound / 1e6 + maxOutputTokens * 5 / 1e6;
  return { inputUpperBound, maxOutputTokens, reservedUsd };
}
export function budgetState(file: string, manifestHash: string) {
  const rows: Array<Record<string, unknown>> = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(r => JSON.parse(r)) : [];
  const reserved = new Map<string, number>(); const settled = new Map<string, number>();
  for (const r of rows) {
    if (r.manifestHash !== manifestHash) throw new Error('budget manifest mismatch');
    if (typeof r.id === 'string' && r.settled == null && typeof r.reservedUsd === 'number' && Number.isFinite(r.reservedUsd) && r.reservedUsd > 0 && !reserved.has(r.id)) reserved.set(r.id, r.reservedUsd);
    else if (typeof r.settled === 'string' && r.id == null && reserved.has(r.settled) && !settled.has(r.settled) && typeof r.actualUsd === 'number' && Number.isFinite(r.actualUsd) && r.actualUsd >= 0 && r.actualUsd <= reserved.get(r.settled)!) settled.set(r.settled, r.actualUsd);
    else throw new Error('invalid budget ledger');
  }
  return { reserved, settled, charged: [...reserved].reduce((sum, [id, usd]) => sum + (settled.get(id) ?? usd), 0) };
}
export function settleCall(file: string, id: string, actualUsd: number, manifestHash: string) {
  const state = budgetState(file, manifestHash);
  if (!Number.isFinite(actualUsd) || actualUsd < 0 || !state.reserved.has(id) || state.settled.has(id) || actualUsd > state.reserved.get(id)!) throw new Error('invalid actual usage; reservation retained');
  appendFileSync(file, JSON.stringify({ settled: id, actualUsd, manifestHash }) + '\n', { flush: true });
}
export function reserveCall(file: string, entry: { id: string; reservedUsd: number; manifestHash: string }) {
  const state = budgetState(file, entry.manifestHash);
  if (state.reserved.has(entry.id)) throw new Error('call already reserved; reconcile receipt before retry');
  if (!Number.isFinite(entry.reservedUsd) || entry.reservedUsd <= 0 || state.reserved.size >= 200 || state.charged + entry.reservedUsd > 3) throw new Error('evaluation budget exhausted');
  appendFileSync(file, JSON.stringify(entry) + '\n', { flush: true });
}
export function provenanceScores(outcomes: Outcome[]) {
  return Object.fromEntries(['human', 'model', 'unknown'].map(p => [p, score(outcomes.filter(o => (o.c.provenance ?? 'unknown') === p))]));
}

export function writeScore(outcomes: Outcome[]) {
  const eligible = outcomes.filter(o => o.c.expectedWrite != null);
  const hits = eligible.filter(o => {
    if (o.status !== 'ok' && o.status !== 'no-insight') return false;
    const write = (o as Outcome & { write?: { action: string; id?: string } }).write;
    return write?.action === o.c.expectedWrite && (o.c.expectedWrite !== 'update' || write?.id === o.c.expectedTarget);
  });
  return { hit: hits.length, total: eligible.length, failedIds: eligible.filter(o => !hits.includes(o)).map(o => o.c.id) };
}

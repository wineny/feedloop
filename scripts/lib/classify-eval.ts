// Audit-only helpers. Production prompts, parsers, normalizers and policy remain authoritative.
import { generateText } from 'ai';
import { resolveModel } from '../../src/lib/llm/provider';
import { extractResult } from '../../src/lib/bot/handler';
import { CATEGORIES, SENTIMENTS, normalizeCategory, normalizeSentiment } from '../../src/lib/classify/taxonomy';
import { groupAction } from '../../src/lib/groups/policy';

export type PathMode = 'realtime' | 'batch';
export type Transport = 'sdk' | 'legacy-rest';
export interface EvalCase {
  id: string;
  text: string;
  category?: string | null;
  sentiment?: string | string[] | null;
  boundary?: string;
  [key: string]: unknown;
}
export interface Prediction { category: string; sentiment: string; summary: string }
export type OutcomeStatus = 'ok' | 'no-insight' | 'parse' | 'schema' | 'omitted' | 'api' | 'timeout' | 'empty';
export interface Outcome {
  c: EvalCase;
  got: Prediction | null;
  status: OutcomeStatus;
  rawCategory: unknown;
  rawSentiment: unknown;
  callIndex: number;
}
export interface CallOptions { model: string; path: PathMode; transport: Transport }
export interface CallRecord {
  raw: string | null;
  failure: 'api' | 'timeout' | 'empty' | null;
  httpStatus: number | null;
  elapsedMs: number;
  usage: { inputTokens?: number; outputTokens?: number } | null;
}

export const timeoutFor = (path: PathMode) => path === 'batch' ? 60_000 : 10_000;

/** The same generation options as callLlm, without model resolution or DB failure bookkeeping. */
export async function sdkCallOptions(options: CallOptions, _key: string, system: string, prompt: string) {
  return {
    model: (await resolveModel({ botId: 'classification-eval' })).model,
    system,
    prompt,
    maxRetries: 0,
    timeout: timeoutFor(options.path),
  };
}

/** Error messages/bodies/URLs may contain credentials. Only allowlisted facts leave this function. */
export function safeCallFailure(error: unknown): Pick<CallRecord, 'failure' | 'httpStatus'> {
  const e = error as { name?: unknown; statusCode?: unknown; cause?: { name?: unknown } } | null;
  const names = [e?.name, e?.cause?.name];
  const timedOut = names.some(n => typeof n === 'string' && /Timeout|Abort/.test(n));
  return {
    failure: timedOut ? 'timeout' : 'api',
    httpStatus: typeof e?.statusCode === 'number' && Number.isInteger(e.statusCode) && e.statusCode >= 100 && e.statusCode <= 599 ? e.statusCode : null,
  };
}

export async function callModel(options: CallOptions, key: string, system: string, prompt: string): Promise<CallRecord> {
  const start = Date.now();
  try {
    let raw: string;
    let usage: CallRecord['usage'] = null;
    if (options.transport === 'sdk') {
      const result = await generateText(await sdkCallOptions(options, key, system, prompt));
      raw = result.text;
      usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    } else {
      // Historical REST temperature:0 comparison. A bounded timeout is new and explicitly recorded.
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(timeoutFor(options.path)),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 },
        }),
      });
      if (!res.ok) return { raw: null, failure: 'api', httpStatus: res.status, elapsedMs: Date.now() - start, usage };
      const body = await res.json();
      raw = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      usage = { inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount };
    }
    return { raw, failure: raw.trim() ? null : 'empty', httpStatus: null, elapsedMs: Date.now() - start, usage };
  } catch (error) {
    return { raw: null, ...safeCallFailure(error), elapsedMs: Date.now() - start, usage: null };
  }
}

export function failedOutcome(c: EvalCase, status: OutcomeStatus, callIndex: number): Outcome {
  return { c, got: null, status, rawCategory: null, rawSentiment: null, callIndex };
}

/** extractResult imports lazy DB helpers; neither callLlm nor any DB helper is called here. */
export function parseRealtime(c: EvalCase, raw: string, callIndex: number): Outcome {
  const result = extractResult(raw);
  if (!result.insight) return failedOutcome(c, 'no-insight', callIndex);
  const insight = result.insight;
  const got = {
    category: normalizeCategory(insight.category),
    sentiment: normalizeSentiment(insight.sentiment),
    summary: typeof insight.summary === 'string' ? insight.summary : '',
  };
  // Missing/wrong-type summary cannot be stored as the intended text row. Do not award a label hit.
  const status = result.parsed === false ? 'parse' : typeof insight.summary !== 'string' ? 'schema' : 'ok';
  return { c, got, status, rawCategory: result.parsed === false ? null : insight.category ?? null, rawSentiment: result.parsed === false ? null : insight.sentiment ?? null, callIndex };
}

export function validateCases(value: unknown): asserts value is { cases: EvalCase[]; [key: string]: unknown } {
  const rows = (value as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('set must contain a nonempty cases array');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error('case ids must be nonempty and unique');
    ids.add(row.id);
    if (typeof row.text !== 'string' || !row.text.trim()) throw new Error('each case needs nonempty text');
    if (row.category != null && !(CATEGORIES as readonly unknown[]).includes(row.category)) throw new Error('case category is outside taxonomy');
    const sentiments = row.sentiment == null ? [] : Array.isArray(row.sentiment) ? row.sentiment : [row.sentiment];
    if ((Array.isArray(row.sentiment) && !sentiments.length) || sentiments.some((s: unknown) => !(SENTIMENTS as readonly unknown[]).includes(s))) throw new Error('case sentiment is outside taxonomy');
    if (row.boundary != null && typeof row.boundary !== 'string') throw new Error('case boundary must be a string');
  }
}

export const fraction = (hit: number, total: number) => ({ hit, total, percent: total ? 100 * hit / total : null });

export function score(outcomes: Outcome[]) {
  const labeled = outcomes.filter(o => o.c.category != null);
  const sentimentLabeled = outcomes.filter(o => o.c.sentiment != null);
  const eligibleAction = (o: Outcome) => o.status === 'ok' || o.status === 'no-insight';
  const actionOf = (o: Outcome) => o.status === 'no-insight' ? 'none' : o.got ? groupAction(o.got.category) : null;
  const categoryHit = labeled.filter(o => o.status === 'ok' && o.got?.category === o.c.category).length;
  const sentimentHit = sentimentLabeled.filter(o => o.status === 'ok' && o.got && (Array.isArray(o.c.sentiment) ? o.c.sentiment.includes(o.got.sentiment) : o.c.sentiment === o.got.sentiment)).length;
  const expectedPr = labeled.filter(o => groupAction(o.c.category!) === 'pr');
  const expectedNonPr = labeled.filter(o => groupAction(o.c.category!) !== 'pr');
  const wrongPr = expectedNonPr.filter(o => eligibleAction(o) && actionOf(o) === 'pr').length;
  const missedPr = expectedPr.filter(o => !eligibleAction(o) || actionOf(o) !== 'pr').length;
  const failures: Record<string, number> = {};
  for (const o of outcomes) failures[o.status] = (failures[o.status] ?? 0) + 1;
  const confusion: Record<string, number> = {};
  for (const o of labeled) {
    const predicted = o.status === 'ok' ? o.got!.category : `[${o.status}]`;
    if (predicted !== o.c.category) {
      const key = `${o.c.category} → ${predicted}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
  }
  return {
    cases: outcomes.length,
    category: fraction(categoryHit, labeled.length),
    sentiment: fraction(sentimentHit, sentimentLabeled.length),
    action: fraction(labeled.filter(o => eligibleAction(o) && actionOf(o) === groupAction(o.c.category!)).length, labeled.length),
    wrongPr: fraction(wrongPr, expectedNonPr.length),
    missedPr: fraction(missedPr, expectedPr.length),
    bugUxConfusions: labeled.filter(o => o.status === 'ok' && ((o.c.category === 'bug' && o.got?.category === 'ux') || (o.c.category === 'ux' && o.got?.category === 'bug'))).length,
    rawCategoryCoverage: fraction(outcomes.filter(o => o.status === 'ok' && (CATEGORIES as readonly unknown[]).includes(o.rawCategory)).length, outcomes.length),
    rawSentimentCoverage: fraction(outcomes.filter(o => o.status === 'ok' && (SENTIMENTS as readonly unknown[]).includes(o.rawSentiment)).length, outcomes.length),
    normalizedCoverage: fraction(outcomes.filter(o => o.status === 'ok' && o.got).length, outcomes.length),
    normalizedCategoryChanges: outcomes.filter(o => o.status === 'ok' && o.got?.category !== o.rawCategory).length,
    failures,
    confusion,
  };
}

export function slicedScores(outcomes: Outcome[]) {
  const by = (getKey: (c: EvalCase) => string) => {
    const groups = new Map<string, Outcome[]>();
    for (const o of outcomes) { const key = getKey(o.c); groups.set(key, [...(groups.get(key) ?? []), o]); }
    return Object.fromEntries([...groups].map(([k, rows]) => [k, score(rows)]));
  };
  return { source: by(c => c.id.split(':')[0]), boundary: by(c => c.boundary || '(none)'), category: by(c => c.category || '(unlabeled)') };
}

export function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

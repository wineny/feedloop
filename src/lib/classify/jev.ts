import { TAXONOMY_BLOCK, CATEGORIES, SENTIMENTS, normalizeCategory, normalizeSentiment, type Category, type Sentiment } from './taxonomy';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 3_000;

export const CATEGORY_CRITERIA: Record<Category, string> = {
  bug: 'Does something that should work not work as intended?',
  ux: 'Does it work but feel inconvenient or confusing?',
  feature_request: 'Does the user want a capability this app does not have now?',
  cs: 'Is it a question that ends once it is answered?',
  praise: 'Is it praise or thanks?',
  other: 'None of the above?',
};

export const SENTIMENT_CRITERIA: Record<Sentiment, string> = {
  positive: 'satisfaction, thanks',
  neutral: 'a calm report or question',
  negative: 'dissatisfaction, disappointment or difficulty shows',
};

export function buildJevRequest(text: string) {
  return {
    model: JEV_MODEL,
    state: text.trim(),
    questions: {
      category: { type: 'choice', instructions: `${TAXONOMY_BLOCK}\n\nWhat is the category of this user message?`, criteria: CATEGORY_CRITERIA },
      sentiment: { type: 'choice', instructions: 'What is the sentiment of this user message?', criteria: SENTIMENT_CRITERIA },
      follow_up: { type: 'noul', instructions: 'Does a person need to take over? Even a question that ends once answered counts when the service knowledge cannot answer it.' },
    },
  };
}

export interface JevParsed {
  category: Category;
  rawCategory: unknown;
  sentiment: Sentiment;
  rawSentiment: unknown;
  categoryConfidence: number | null;
  categoryProbabilities: Record<string, number> | null;
  followUp: number | null;
  modelVersion: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 응답이 약속한 모양이 아니면 null — 호출부가 'schema' 실패로 센다. */
export function parseJevResponse(raw: string): JevParsed | null {
  let body: { model?: unknown; answers?: Record<string, Record<string, unknown> | undefined> };
  try { body = JSON.parse(raw); } catch { return null; }
  const cat = body?.answers?.category;
  const sen = body?.answers?.sentiment;
  if (!cat || typeof cat.choice !== 'string' || !CATEGORIES.some((c) => c === cat.choice)
    || !sen || typeof sen.choice !== 'string' || !SENTIMENTS.some((s) => s === sen.choice)) return null;
  if (cat.confidence != null && (num(cat.confidence) === null || (cat.confidence as number) < 0 || (cat.confidence as number) > 1)) return null;
  const probs = cat.probabilities && typeof cat.probabilities === 'object' ? (cat.probabilities as Record<string, number>) : null;
  return {
    category: normalizeCategory(cat.choice),
    rawCategory: cat.choice,
    sentiment: normalizeSentiment(sen.choice),
    rawSentiment: sen.choice,
    categoryConfidence: num(cat.confidence),
    categoryProbabilities: probs,
    followUp: num(body.answers?.follow_up?.noul),
    modelVersion: typeof body.model === 'string' ? body.model : null,
  };
}

export interface ClassificationMetadata {
  classified_by: 'jev' | 'llm';
  classify_confidence: number | null;
}

/** Jev only refines category. All other fields remain the reply model's decision. */
export async function refineCategoryWithJev<T extends { category: string }>(
  text: string, llmInsight: T,
): Promise<T & ClassificationMetadata> {
  const fallback = { ...llmInsight, classified_by: 'llm' as const, classify_confidence: null };
  const key = process.env.JEV_API_KEY;
  if (!key) return fallback;
  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildJevRequest(text)),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('http');
    const parsed = parseJevResponse(await response.text());
    if (!parsed) throw new Error('schema');
    const confident = parsed.categoryConfidence !== null && parsed.categoryConfidence >= 0.7;
    return { ...llmInsight, category: confident ? parsed.category : llmInsight.category,
      classified_by: confident ? 'jev' : 'llm', classify_confidence: parsed.categoryConfidence };
  } catch {
    // Never log the visitor's text, provider payload, or credentials.
    console.warn('[jev] category refinement failed; keeping LLM classification');
    return fallback;
  }
}

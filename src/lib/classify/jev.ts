import { TAXONOMY_BLOCK, CATEGORIES, SENTIMENTS, normalizeCategory, normalizeSentiment, type Category, type Sentiment } from './taxonomy';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 3_000;

export const CATEGORY_CRITERIA: Record<Category, string> = {
  bug: '작동해야 할 것이 의도대로 안 되는가?',
  ux: '작동은 하는데 불편하거나 헷갈리는가?',
  feature_request: '지금 이 앱에 없는 능력을 원하는가?',
  cs: '답만 주면 끝나는 질문인가?',
  praise: '칭찬·감사인가?',
  other: '위 어디에도 아닌가?',
};

export const SENTIMENT_CRITERIA: Record<Sentiment, string> = {
  positive: '만족·감사',
  neutral: '담담한 제보나 질문',
  negative: '불만·실망·곤란함이 드러남',
};

export function buildJevRequest(text: string) {
  return {
    model: JEV_MODEL,
    state: text.trim(),
    questions: {
      category: { type: 'choice', instructions: `${TAXONOMY_BLOCK}\n\n이 유저 메시지의 category 는?`, criteria: CATEGORY_CRITERIA },
      sentiment: { type: 'choice', instructions: '이 유저 메시지의 sentiment 는?', criteria: SENTIMENT_CRITERIA },
      follow_up: { type: 'noul', instructions: '사람이 이어받아야 하는가? 답만 주면 끝나는 질문이라도 서비스 지식이 없어 답을 못 줄 내용이면 그렇다.' },
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

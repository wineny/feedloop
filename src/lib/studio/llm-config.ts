// Server-only settings for Refund Studio's agent. The key never reaches the browser (no NEXT_PUBLIC_ prefix).
//
// Production uses only STUDIO_ANTHROPIC_API_KEY — a key made for this feature, with a monthly spend limit set in the
// Anthropic Console, so a public demo cannot run up the bot's own LLM bill. Local development may fall back to the
// platform key in .env.local.

export const STUDIO_DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Models the route will call. The first is the default. */
export const STUDIO_MODELS = [STUDIO_DEFAULT_MODEL, 'claude-haiku-5-5'];

export function studioLlmKey(): string | undefined {
  const dedicated = process.env.STUDIO_ANTHROPIC_API_KEY?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === 'production') return undefined;
  return process.env.PLATFORM_ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}

export const studioAgentEnabled = (): boolean => Boolean(studioLlmKey());

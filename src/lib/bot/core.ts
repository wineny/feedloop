// grammy Bot 인스턴스 — 멀티봇 지원 (DB 설정 로드 + 캐시)

import { Bot, webhookCallback } from 'grammy';
import { handleMessage, type BotConfig } from './handler';
import type { ServiceProfile } from './prompts';
import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt } from '@/lib/utils/crypto';
import { renderKnowledge, type FaqItem } from './knowledge';

// ── 설정 캐시 ─────────────────────────────────────

const configCache = new Map<string, { config: BotConfig; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5분

// ── Bot 인스턴스 캐시 ────────────────────────────

const botInstances = new Map<string, Bot>();

// ── DB에서 봇 설정 로드 ──────────────────────────

export async function getBotConfigFromDB(botId: string): Promise<BotConfig> {
  const cached = configCache.get(botId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const db = getServiceRoleClient();
  const { data: bot, error } = await db
    .from('bots')
    // 지식 2컬럼과 BYOK 4컬럼을 «같은 select 에» 얹는다. 위젯 POST 는 메시지마다
    // 이 config 를 부르므로(messages/route.ts) 상한·provider 판정에 필요한 값을
    // 따로 읽으면 메시지당 DB 왕복이 하나 는다. 같은 행이라 컬럼만 더하면 비용이 0 이고,
    // 아래 5분 캐시가 그대로 덮어준다. resolveModel/resolveLimit 은 DB 를 다시 읽지 않고
    // 이 BotConfig 를 인자로 받는다(계획 §A-2).
    // ⚠️ 한 줄 문자열 리터럴이어야 한다. '…' + '…' 로 나누면 supabase-js 가 컬럼 타입을
    //    추론하지 못해 반환값이 GenericStringError 로 떨어진다(2026-09-10 실측).
    .select('service_name, service_description, service_url, mention_patterns, feedback_keywords, cooldown_interval_sec, cooldown_max_daily, knowledge_text, knowledge_faq, daily_reply_limit, llm_api_key_encrypted, llm_provider, llm_model, llm_key_failed_at')
    .eq('id', botId)
    .single();

  if (error || !bot) {
    console.error(`[bot] DB config load failed for ${botId}:`, error);
    throw new Error(`Bot not found: ${botId}`);
  }

  const faq: FaqItem[] = Array.isArray(bot.knowledge_faq) ? bot.knowledge_faq : [];

  const profile: ServiceProfile = {
    botName: bot.service_name,
    botTone: '친근하고 편한 한국어. 이모지 적당히.',
    serviceName: bot.service_name,
    serviceUrl: bot.service_url || '',
    serviceDescription: bot.service_description || '',
    serviceCompany: '',
    targetUsers: '베타 테스터',
    serviceFeatures: [],
    loginMethod: '',
    faq,
    knowledge: renderKnowledge(bot.knowledge_text, faq),
  };

  const config: BotConfig = {
    botId,
    mentionPatterns: bot.mention_patterns || [],
    feedbackKeywords: bot.feedback_keywords || {
      negative: ['불편', '어려워', '안돼', '버그', '오류'],
      positive: ['좋아', '편해', '최고'],
      question: ['어떻게', '뭐야', '왜', '방법'],
    },
    serviceProfile: profile,
    cooldownIntervalSec: bot.cooldown_interval_sec ?? 30,
    cooldownMaxDaily: bot.cooldown_max_daily ?? 50,
    dailyReplyLimit: bot.daily_reply_limit ?? null,
    llmApiKeyEncrypted: bot.llm_api_key_encrypted ?? null,
    llmProvider: bot.llm_provider ?? null,
    llmModel: bot.llm_model ?? null,
    // 실패 표시. callLlm 이 «성공했을 때» 이 값이 있을 때만 지운다(평소 왕복 0).
    llmKeyFailedAt: bot.llm_key_failed_at ?? null,
  };

  configCache.set(botId, { config, expiresAt: Date.now() + CACHE_TTL });
  return config;
}

// ── Bot 인스턴스 가져오기 (캐시 or 생성) ─────────

export async function getBotInstance(botId: string): Promise<Bot> {
  const existing = botInstances.get(botId);
  if (existing) return existing;

  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('bots')
    .select('bot_token_encrypted')
    .eq('id', botId)
    .single();

  if (error || !data) {
    throw new Error(`Bot not found: ${botId}`);
  }

  const token = decrypt(data.bot_token_encrypted);
  if (!token) {
    throw new Error(`Token decryption failed for bot: ${botId}`);
  }

  const bot = createBot(token, botId);
  botInstances.set(botId, bot);
  return bot;
}

// ── 캐시 무효화 ──────────────

export function invalidateBotCache(botId: string) {
  botInstances.delete(botId);
  configCache.delete(botId);
}

// ── 봇 인스턴스 생성 ────────────────────────────────

export function createBot(token: string, botId?: string) {
  const bot = new Bot(token);

  bot.on('message:text', async (ctx) => {
    try {
      const config = botId
        ? await getBotConfigFromDB(botId)
        : getBotConfig();
      await handleMessage(ctx, config);
    } catch (err) {
      console.error('[bot] handler error:', err);
    }
  });

  bot.catch((err) => {
    console.error('[bot] unhandled error:', err);
  });

  return bot;
}

// ── 테스트용 기본 설정 (env fallback) ────────────

function getBotConfig(): BotConfig {
  const profile: ServiceProfile = {
    botName: process.env.BOT_SERVICE_NAME || '피드백봇',
    botTone: '친근하고 편한 한국어. 이모지 적당히.',
    serviceName: process.env.BOT_SERVICE_NAME || '서비스',
    serviceUrl: process.env.BOT_SERVICE_URL || '',
    serviceDescription: process.env.BOT_SERVICE_DESCRIPTION || '베타 테스트 중인 서비스',
    serviceCompany: process.env.BOT_SERVICE_COMPANY || '',
    targetUsers: process.env.BOT_TARGET_USERS || '베타 테스터',
    serviceFeatures: (process.env.BOT_SERVICE_FEATURES || '').split(',').filter(Boolean),
    loginMethod: process.env.BOT_LOGIN_METHOD || '',
    faq: [],
    // env 폴백 봇은 DB 행이 없다 — 지식도 없다. 빈 문자열이면 프롬프트에서
    // 「## 답변 지식」 섹션 자체가 안 생긴다(prompts.ts).
    knowledge: '',
  };

  return {
    botId: process.env.BOT_ID || 'dev-bot',
    mentionPatterns: (process.env.BOT_MENTION_PATTERNS || '').split(',').filter(Boolean),
    feedbackKeywords: {
      negative: (process.env.BOT_KW_NEGATIVE || '불편,어려워,안돼,버그,오류,느려,이상해').split(','),
      positive: (process.env.BOT_KW_POSITIVE || '좋아,편해,최고,잘돼,깔끔').split(','),
      question: (process.env.BOT_KW_QUESTION || '어떻게,뭐야,왜,언제,어디,방법,하는법').split(','),
    },
    serviceProfile: profile,
    cooldownIntervalSec: 30,
    cooldownMaxDaily: 50,
    // 키가 없으니 플랫폼 폴백 경로를 탄다(상한 100). resolveModel/resolveLimit 이 이 값을 본다.
    dailyReplyLimit: null,
    llmApiKeyEncrypted: null,
    llmProvider: null,
    llmModel: null,
    llmKeyFailedAt: null,
  };
}

// ── Webhook 핸들러 (Next.js API route용) ────────────

export function createWebhookHandler(bot: Bot) {
  return webhookCallback(bot, 'std/http');
}

// ── Polling 시작 (개발 모드) ────────────────────────

export async function startPolling(bot: Bot) {
  console.log('[bot] Starting polling mode...');
  await bot.start({
    onStart: () => console.log('[bot] Polling started. Listening for messages...'),
  });
}

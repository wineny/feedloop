// 개발 모드 진입점 — long polling
// 실행: npm run bot:dev

import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env' });
import { createBot, startPolling } from '../src/lib/bot/core';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('[bot-dev] TELEGRAM_BOT_TOKEN이 .env.local에 없습니다.');
  process.exit(1);
}

console.log('[bot-dev] Bot token found. Initializing...');
const bot = createBot(token);

startPolling(bot).catch((err) => {
  console.error('[bot-dev] Fatal error:', err);
  process.exit(1);
});

// graceful shutdown
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

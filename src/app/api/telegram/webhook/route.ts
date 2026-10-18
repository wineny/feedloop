// Telegram Webhook — Vercel 배포용 API route

import { NextRequest, NextResponse } from 'next/server';
import { createBot, createWebhookHandler } from '@/lib/bot/core';

// LLM 호출 + DB 저장 + after() 의 자동 묶기(90초 조용한 시간 + 묶기 예산 100초).
export const maxDuration = 300;

const token = process.env.TELEGRAM_BOT_TOKEN;

let handler: ((req: Request) => Promise<Response>) | null = null;

function getHandler() {
  if (handler) return handler;
  if (!token) {
    console.error('[webhook] TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const bot = createBot(token);
  handler = createWebhookHandler(bot);
  return handler;
}

export async function POST(req: NextRequest) {
  const webhookHandler = getHandler();
  if (!webhookHandler) {
    return NextResponse.json({ error: 'Bot not configured' }, { status: 500 });
  }

  try {
    const response = await webhookHandler(req);
    return response;
  } catch (err) {
    console.error('[webhook] Error:', err);
    return NextResponse.json({ ok: true }); // Telegram expects 200
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: !!token,
    google_api: !!process.env.GOOGLE_API_KEY,
    bot_id: process.env.BOT_ID || 'not set',
    supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
}

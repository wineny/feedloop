// 멀티봇 Telegram Webhook — 동적 라우팅
// POST /api/telegram/webhook/{botId}

import { NextRequest, NextResponse } from 'next/server';
import { getBotInstance } from '@/lib/bot/core';
import { webhookCallback } from 'grammy';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;

  try {
    const bot = await getBotInstance(botId);
    const handler = webhookCallback(bot, 'std/http');
    return await handler(req);
  } catch (err) {
    console.error(`[webhook/${botId}] Error:`, err);
    // Telegram expects 200 to stop retrying
    return NextResponse.json({ ok: true });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;
  return NextResponse.json({ status: 'ok', botId });
}

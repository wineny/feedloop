// 봇 설정 › API 키 — 운영자 LLM API 키와 모델을 읽고·바꾸고·지운다.
//
// 이 라우트가 지키는 것 두 가지.
//  1) **키 원문은 어떤 응답에도 안 나간다.** 저장은 AES-256-GCM 암호문으로, 화면에는 마지막 4자만.
//     한 번 저장된 키를 되읽는 경로는 만들지 않는다 — 만들면 세션 탈취 한 번이 키 유출이 된다.
//  2) 소유자 확인(`resolveOwnedBots`)을 거친다. 남의 봇에 키를 심으면 그 사람 돈으로 우리 위젯이 돈다.
//
// 저장·삭제 뒤 `invalidateBotCache` 를 부른다. 5분 캐시를 기다리게 하면
// "키를 바꿨는데 옛 키로 계속 실패한다"가 된다.

import { NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { invalidateBotCache } from '@/lib/bot/core';
import { encrypt } from '@/lib/utils/crypto';
import { isLlmProvider, validateModelId, type LlmProvider } from '@/lib/llm/models';
import { checkKeyFormat, verifyKey, keyLast4, effectiveModelId, failureReasonText } from '@/lib/llm/key';
import { resolveLimit } from '@/lib/llm/usage';
import { limitForDisplay } from '@/lib/llm/limits';

export const dynamic = 'force-dynamic';

// ── 키 검증 속도 제한 ───────────────────────────────
//
// PATCH 한 번이 provider 로 «바깥 요청»을 하나 낸다. 로그인만 하면 누구나 부를 수 있으므로,
// 막지 않으면 이 라우트가 provider 를 향한 키 대입 시도의 통로가 된다 —
// 우리 서버 IP 로 나가서 시도자는 가려지고, 실패 사유 4분류가 그대로 판별 신호가 된다.
// 사람이 키를 등록·교체하는 속도는 분당 5회를 넘지 않는다.
//
// 인메모리라 인스턴스마다 따로 센다(lib/widget/http.ts 의 IP 제한과 같은 한계).
// 완벽한 방벽이 아니라 «자동화된 반복»의 비용을 올리는 장치다.
const VERIFY_LIMIT_PER_MIN = 5;
const verifyHits = new Map<string, number[]>();

function verifyRateExceeded(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;

  const hits = (verifyHits.get(userId) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  verifyHits.set(userId, hits);

  // 맵이 무한정 자라지 않게 가끔 청소한다.
  if (verifyHits.size > 5000) {
    for (const [key, times] of verifyHits) {
      if (times.every((t) => t <= cutoff)) verifyHits.delete(key);
    }
  }

  return hits.length > VERIFY_LIMIT_PER_MIN;
}

const SELECT =
  'id, llm_provider, llm_model, llm_api_key_encrypted, llm_key_last4, llm_key_verified_at, llm_key_failed_at, llm_key_failed_reason, daily_reply_limit';

interface BotKeyRow {
  id: string;
  llm_provider: string | null;
  llm_model: string | null;
  llm_api_key_encrypted: string | null;
  llm_key_last4: string | null;
  llm_key_verified_at: string | null;
  llm_key_failed_at: string | null;
  llm_key_failed_reason: string | null;
  daily_reply_limit: number | null;
}

/**
 * 화면이 받는 모양. **`llm_api_key_encrypted` 는 여기에 들어가지 않는다** —
 * 암호문이라도 내보내지 않는다. 있다/없다만 `hasKey` 로 알린다.
 */
function present(bot: BotKeyRow) {
  const provider = isLlmProvider(bot.llm_provider) ? bot.llm_provider : null;
  return {
    provider,
    model: bot.llm_model,
    // 운영자가 모델을 안 골랐을 때 화면이 "(기본) …" 으로 보여줄 값
    effectiveModel: provider ? effectiveModelId(provider, bot.llm_model) : null,
    hasKey: Boolean(bot.llm_api_key_encrypted),
    keyLast4: bot.llm_key_last4,
    verifiedAt: bot.llm_key_verified_at,
    failedAt: bot.llm_key_failed_at,
    // 4분류 고정 문구. provider 에러 원문은 여기 들어오지 않는다(20260910_02).
    failedReason: failureReasonText(bot.llm_key_failed_reason, provider ? effectiveModelId(provider, bot.llm_model) : bot.llm_model),
    // 화면의 상한 안내 문구가 이 값을 쓴다. 숫자를 문자열에 박으면
    // 데모 봇(2000)이나 anthropic 운영자에게 거짓말을 하게 된다.
    // null = 한도 없음(운영자 키). Infinity 는 JSON 에 실리지 않는다.
    dailyLimit: limitForDisplay(
      resolveLimit({
        dailyReplyLimit: bot.daily_reply_limit,
        llmApiKeyEncrypted: bot.llm_api_key_encrypted,
        llmProvider: bot.llm_provider,
      }),
    ),
    // 이 봇에 상한 «예외»가 걸려 있으면(데모 봇 2000) 키를 넣어도 상한이 안 바뀐다.
    // 화면이 「키를 넣으면 한도 없이 답해요」라고 말하면 거짓말이 되므로 알려준다.
    dailyLimitOverridden: bot.daily_reply_limit != null,
  };
}

async function loadBot(id: string): Promise<BotKeyRow | null> {
  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .select(SELECT)
    .eq('id', id)
    .single();
  return error || !data ? null : (data as unknown as BotKeyRow);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: '봇을 찾을 수 없습니다' }, { status: 404 });

  return NextResponse.json(present(bot));
}

/**
 * 두 가지 요청을 받는다.
 *
 *  - **키 등록·교체**: `{ provider, key, model? }` — 형식 필터 → provider 에 실제로 물어보고 → 저장
 *  - **모델만 변경**: `{ model }` — 키가 이미 있는 봇에서 키를 다시 묻지 않는다(§B-3).
 *    `model: null` 이면 추천 기본값으로 되돌린다
 *
 * provider 를 바꾸면 모델 선택을 초기화한다. 남겨두면 gemini 모델 id 가 anthropic 키로
 * 나가 첫 호출에서 죽고, 운영자는 "모델을 안 건드렸는데 왜"가 된다.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
  }

  const bot = await loadBot(id);
  if (!bot) return NextResponse.json({ error: '봇을 찾을 수 없습니다' }, { status: 404 });

  const hasModelField = 'model' in body;
  const modelParsed = validateModelId(hasModelField ? body.model : undefined);
  if (!modelParsed.ok) return NextResponse.json({ error: modelParsed.error }, { status: 400 });

  const wantsKey = 'key' in body && body.key !== null;

  // ── 모델만 변경
  if (!wantsKey) {
    if (!hasModelField) {
      return NextResponse.json({ error: '변경할 항목이 없습니다' }, { status: 400 });
    }
    if (!bot.llm_api_key_encrypted) {
      return NextResponse.json(
        { error: '먼저 API 키를 등록해 주세요. 모델 설정은 등록한 키에 딸린 값이에요' },
        { status: 400 },
      );
    }
    // 모델을 바꾸는 것은 「고쳐봤다」는 뜻이다. 지난 실패 표시를 지워 다음 호출이 다시 판정하게 한다
    // (호출 성공마다 지우면 메시지당 DB 왕복이 하나 는다 — 위젯 POST 는 메시지마다 이 경로를 탄다).
    return await save(id, {
      llm_model: modelParsed.value,
      llm_key_failed_at: null,
      llm_key_failed_reason: null,
    });
  }

  // ── 키 등록·교체
  if (!isLlmProvider(body.provider)) {
    return NextResponse.json(
      { error: 'provider 는 gemini, anthropic, openai 중 하나여야 합니다' },
      { status: 400 },
    );
  }
  const provider: LlmProvider = body.provider;

  const format = checkKeyFormat(provider, body.key);
  if (!format.ok) return NextResponse.json({ error: format.error }, { status: 400 });
  const key = body.key as string;

  // 형식이 맞는 «뒤»에 센다. 오탈자로 한 번 틀린 것까지 한도에 넣으면 사람이 손해를 본다.
  if (verifyRateExceeded(auth.userId)) {
    return NextResponse.json(
      { error: '키 확인을 너무 자주 시도했어요. 잠시 후 다시 시도해 주세요' },
      { status: 429 },
    );
  }

  // 실제로 통하는 키인지 provider 에 물어본다(무과금 목록 조회).
  // 실패하면 **DB 에 아무것도 남기지 않는다** — 반쯤 저장된 키는 첫 방문자 앞에서 죽는다.
  const verified = await verifyKey(provider, key);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error, kind: verified.kind }, { status: 400 });
  }

  // provider 가 바뀌었는데 모델을 안 보냈으면 기존 모델을 끌고 가지 않는다.
  const providerChanged = bot.llm_provider !== provider;
  const nextModel = hasModelField ? modelParsed.value : providerChanged ? null : bot.llm_model;

  return await save(id, {
    llm_provider: provider,
    llm_api_key_encrypted: encrypt(key),
    llm_key_last4: keyLast4(key),
    llm_key_verified_at: new Date().toISOString(),
    // 새 키를 검증했으니 지난 실패는 해소다. 배지가 계속 떠 있으면 안 된다.
    llm_key_failed_at: null,
    llm_key_failed_reason: null,
    llm_model: nextModel,
  });
}

/**
 * 키를 지우고 플랫폼 폴백으로 되돌린다. 상한도 무료분(100)으로 내려간다.
 *
 * `llm_model` 도 함께 지운다 — 운영자 모델 선택은 **운영자 키에 딸린 설정**이지
 * 우리 플랫폼 폴백에 적용될 값이 아니다.
 * `llm_provider` 는 남긴다. 화면이 "지난번에 고른 것"을 기억하는 용도이고,
 * 키가 없으면 `resolveModel` 이 이 값을 보지 않는다.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return await save(id, {
    llm_api_key_encrypted: null,
    llm_key_last4: null,
    llm_key_verified_at: null,
    llm_key_failed_at: null,
    llm_key_failed_reason: null,
    llm_model: null,
  });
}

async function save(id: string, values: Record<string, unknown>) {
  const { data, error } = await getServiceRoleClient()
    .from('bots')
    .update(values)
    .eq('id', id)
    .select(SELECT)
    .single();

  if (error || !data) {
    // error.message 를 그대로 내보내지 않는다 — update 값에 암호문이 섞여 있다.
    console.error(`[llm-key] save failed for ${id}:`, error?.message);
    return NextResponse.json({ error: '저장하지 못했습니다' }, { status: 500 });
  }

  invalidateBotCache(id);
  return NextResponse.json(present(data as unknown as BotKeyRow));
}

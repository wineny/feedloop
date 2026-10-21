// 봇 설정 › 채널톡 연결.
//
// 원칙 4(자격증명은 한 방향으로만 흐른다)가 이 파일의 설계 전부다.
// 액세스 키·시크릿은 「입력 → 검증 → 암호화 → DB」 로만 가고, 어떤 응답·로그에도 되돌아
// 나오지 않는다. 검증 실패도 채널톡이 준 status 와 한 줄만 옮긴다.
//
// 명시적 예외 1건 — **웹훅 토큰**. 고객이 채널톡 설정 화면에 붙여넣을 URL 이라 되돌려
// 줘야 한다. 대신 소유자 인증 GET 으로만 나가고, 언제든 회전할 수 있고, 그 권한은
// 「그 봇에 메시지 쓰기」 하나다.

import { NextRequest, NextResponse } from 'next/server';
import { resolveOwnedBots } from '@/lib/auth/ownership';
import {
  buildDeskUrl,
  validateChannelInput,
  validateVerifyTokenInput,
} from '@/lib/bot/channel-registration';
import { verifyCredentials } from '@/lib/channel/client';
import { generateWebhookToken } from '@/lib/channel/verify';
import { getServiceRoleClient } from '@/lib/supabase';
import { decrypt, encrypt } from '@/lib/utils/crypto';

export const dynamic = 'force-dynamic';

/** 키·시크릿·토큰 암호문은 여기 없다. 목록에 없는 컬럼은 실수로도 못 나간다. */
const SAFE_SELECT = 'id, channel_slug, channel_id, channel_bot_name, channel_connected_at';

function baseUrl(req: NextRequest): string {
  if (process.env.WEBHOOK_BASE_URL) return process.env.WEBHOOK_BASE_URL;
  // 프록시 뒤(Vercel)에서는 x-forwarded-proto 가 https 로 온다. 로컬은 http 다.
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${req.headers.get('host')}`;
}

function webhookUrlFor(req: NextRequest, botId: string, token: string): string {
  return `${baseUrl(req)}/api/channel/webhook/${botId}/${token}`;
}

interface ChannelBotRow {
  id: string;
  channel_slug: string | null;
  channel_id: string | null;
  channel_bot_name: string | null;
  channel_connected_at: string | null;
}

async function loadBot(id: string, extra = ''): Promise<Record<string, unknown> | null> {
  const { data } = await getServiceRoleClient()
    .from('bots')
    .select(extra ? `${SAFE_SELECT}, ${extra}` : SAFE_SELECT)
    .eq('id', id)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

// ── 연결 · 갱신 ────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // 입구는 한 번에 하나다(`lib/connect/exclusive.ts`). 위젯이 이미 받고 있으면 여기서 끊는다.
  //
  // 채널톡 키를 «확인하기 전»에 본다 — 어차피 거절할 요청으로 남의 채널톡 API 를 두드릴
  // 이유가 없고, 운영자가 방금 붙여넣은 평문 키를 한 번 더 들고 다닐 이유도 없다.
  // 화면은 이미 잠겨 있으므로(`connect/page.tsx`) 여기 닿는 건 주소를 직접 친 경우다.
  const widgetGuard = await loadBot(id, 'widget_connected_at');
  if (widgetGuard?.widget_connected_at) {
    return NextResponse.json(
      { error: '이 서비스는 웹 위젯으로 받고 있어요. 「서비스에 연결」에서 위젯을 먼저 해제해 주세요' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
  }

  const parsed = validateChannelInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const values = parsed.values;

  // 저장 전에 키가 실제로 통하는지 본다. 안 통하는 키를 넣어 두면 되돌림이 조용히 실패한다.
  // 실패 응답에는 채널톡이 준 status 와 한 줄만 싣는다 — 우리가 보낸 키는 절대 되비추지 않는다.
  const check = await verifyCredentials(values.access_key, values.access_secret);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.message, status: check.status },
      { status: 400 },
    );
  }

  // 이미 발급된 토큰이 있으면 그대로 둔다. 이름만 고쳤는데 URL 이 바뀌면 채널톡에 등록된
  // 웹훅이 조용히 죽는다 — 회전은 운영자가 명시적으로 누를 때만 한다(POST ?action=rotate).
  const existing = await loadBot(id, 'channel_webhook_token_encrypted, pr_mode');
  const storedToken = (existing?.channel_webhook_token_encrypted as string | null) ?? null;

  let token = '';
  if (storedToken) {
    try {
      token = decrypt(storedToken);
    } catch {
      token = '';
    }
  }

  let tokenEncrypted = storedToken;
  if (!token) {
    token = generateWebhookToken();
    tokenEncrypted = encrypt(token);
  }

  // 채널톡을 붙이는 순간 자동 PR 을 내린다(계획 U4). 웹훅 토큰이 새면 익명 POST 가
  // 인사이트 → 묶음 → 크론을 거쳐 **사람 없이 PR** 까지 간다. 토큰은 URL 경로에 있어
  // 요청 로그에 남는 값이라 「안 샐 것이다」에 기댈 수 없다.
  // 조용히 내리지 않고 응답으로 알린다 — 운영자가 켜 둔 설정을 우리가 바꾼 것이다.
  const prModeChanged = existing?.pr_mode === 'auto';

  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      channel_access_key_encrypted: encrypt(values.access_key),
      channel_access_secret_encrypted: encrypt(values.access_secret),
      channel_webhook_token_encrypted: tokenEncrypted,
      channel_slug: values.channel_slug,
      channel_id: values.channel_id,
      channel_bot_name: values.bot_name,
      ...(prModeChanged ? { pr_mode: 'approve' } : {}),
    })
    .eq('id', id);

  if (error) {
    console.error(`[channel/${id}] save failed:`, error.message);
    return NextResponse.json({ error: '저장하지 못했습니다' }, { status: 500 });
  }

  return NextResponse.json({
    configured: true,
    channel_slug: values.channel_slug,
    channel_bot_name: values.bot_name,
    webhookUrl: webhookUrlFor(req, id, token),
    deskUrl: buildDeskUrl(values.channel_slug, null),
    prModeChanged,
  });
}

// ── 현재 설정 ──────────────────────────────────────

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const bot = (await loadBot(
    id,
    'channel_access_key_encrypted, channel_webhook_token_encrypted, channel_webhook_verify_token_encrypted',
  )) as
    | (ChannelBotRow & {
        channel_access_key_encrypted: string | null;
        channel_webhook_token_encrypted: string | null;
        channel_webhook_verify_token_encrypted: string | null;
      })
    | null;

  if (!bot) {
    return NextResponse.json({ error: '봇을 찾을 수 없습니다' }, { status: 404 });
  }

  let token = '';
  if (bot.channel_webhook_token_encrypted) {
    try {
      token = decrypt(bot.channel_webhook_token_encrypted);
    } catch {
      token = '';
    }
  }

  return NextResponse.json({
    configured: Boolean(bot.channel_access_key_encrypted),
    channel_slug: bot.channel_slug,
    channel_id: bot.channel_id,
    channel_bot_name: bot.channel_bot_name,
    // 원칙 4 의 명시적 예외. 키·시크릿에는 이 예외가 없다.
    webhookUrl: token ? webhookUrlFor(req, id, token) : null,
    deskUrl: buildDeskUrl(bot.channel_slug, null),
    connected: Boolean(bot.channel_connected_at),
    // 값은 절대 안 나간다. 「대조 중인가」만 — 화면이 해제 버튼을 보일지 정하는 데 쓴다.
    verifyTokenSet: Boolean(bot.channel_webhook_verify_token_encrypted),
  });
}

// ── 토큰 회전 · 웹훅 토큰(?token=) 저장 ──────────────
//
// 둘 다 «연결된 뒤» 에만 뜻이 있는 동작이라 한 핸들러에 둔다. PATCH 에 얹지 않은 이유:
// PATCH 는 키·시크릿을 다시 요구한다. 채널톡의 웹훅 토큰은 우리 주소를 채널톡에 등록한 «뒤에»
// 보이는 값이라, 그걸 넣으려고 키를 다시 치게 하면 아무도 안 넣는다.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'rotate' && action !== 'verify_token') {
    return NextResponse.json({ error: '지원하지 않는 동작입니다' }, { status: 400 });
  }

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const bot = (await loadBot(id, 'channel_access_key_encrypted')) as
    | { channel_access_key_encrypted: string | null }
    | null;
  if (!bot?.channel_access_key_encrypted) {
    return NextResponse.json({ error: '먼저 채널톡을 연결해 주세요' }, { status: 400 });
  }

  if (action === 'verify_token') return saveVerifyToken(req, id);

  const token = generateWebhookToken();
  // 채널톡 `?token=` 대조값도 함께 비운다. 주소를 새로 만들면 운영자는 채널톡에 웹훅을 다시
  // 등록하고, 채널톡은 그때 새 토큰을 발급한다 — 옛 값을 남기면 그 순간부터 모든 요청이
  // 본문 읽기 전 404 로 떨어지는데 `channel_last_error` 도 안 찍혀 화면 어디에도 신호가 없다(리뷰 MEDIUM).
  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      channel_webhook_token_encrypted: encrypt(token),
      channel_webhook_verify_token_encrypted: null,
    })
    .eq('id', id);

  if (error) {
    console.error(`[channel/${id}] token rotate failed:`, error.message);
    return NextResponse.json({ error: '주소를 새로 만들지 못했습니다' }, { status: 500 });
  }

  // 옛 토큰은 이 순간부터 404 다. 화면이 「채널톡에 새 주소를 다시 넣어야 한다」고 말한다.
  return NextResponse.json({ webhookUrl: webhookUrlFor(req, id, token), rotated: true, verifyTokenSet: false });
}

/**
 * 채널톡이 `?token=` 으로 붙여 보내는 웹훅 토큰을 저장한다(빈 값이면 해제).
 * 원칙 4 그대로다 — 암호화해 넣고, 응답에는 「대조 중인가」 만 싣는다.
 */
async function saveVerifyToken(req: NextRequest, id: string) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다' }, { status: 400 });
  }

  const parsed = validateVerifyTokenInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { error } = await getServiceRoleClient()
    .from('bots')
    .update({
      channel_webhook_verify_token_encrypted: parsed.value ? encrypt(parsed.value) : null,
    })
    .eq('id', id);

  if (error) {
    console.error(`[channel/${id}] verify token save failed:`, error.message);
    return NextResponse.json({ error: '웹훅 토큰을 저장하지 못했습니다' }, { status: 500 });
  }

  return NextResponse.json({ verifyTokenSet: Boolean(parsed.value) });
}

// ── 연결 해제 — 익명화 (U6, 2026-09-10 확정) ──────────
//
// 사람을 특정하는 값만 지운다. 남기는 것은 가명 식별자(external_user_id·channel_person_id)와
// 메시지 본문이다. 식별자를 지우면 재연결 시 같은 사람에게 되돌림이 두 번 가고
// 「어느 제보가 어느 PR 이 됐나」 이력이 끊긴다. 본문은 인사이트·묶음·PR 의 근거라
// 지우면 루프 기록 자체가 깨진다. 완전 삭제도 유지도 아닌 중간을 고른 이유가 이것이다.

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await resolveOwnedBots(id);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const db = getServiceRoleClient();

  // 1) 자격증명 3개를 지운다. 이 시점부터 웹훅은 404 고 전송도 안 된다.
  //    channel_connected_at 도 함께 비운다 — 안 그러면 연결 화면이 키도 없이 「연결됐어요」라고 말한다.
  const { error: botError } = await db
    .from('bots')
    .update({
      channel_access_key_encrypted: null,
      channel_access_secret_encrypted: null,
      channel_webhook_token_encrypted: null,
      channel_webhook_verify_token_encrypted: null,
      channel_connected_at: null,
    })
    .eq('id', id);

  if (botError) {
    console.error(`[channel/${id}] disconnect failed:`, botError.message);
    return NextResponse.json({ error: '연결을 해제하지 못했습니다' }, { status: 500 });
  }

  // 2) 연락처를 지우고 대화를 닫는다. 실명·연락처는 연결이 끊긴 뒤 보관할 이유가 없다.
  const { error: convError } = await db
    .from('conversations')
    .update({ contact_name: null, contact_email: null, contact_phone: null, status: 'closed' })
    .eq('bot_id', id)
    .eq('source', 'channel');

  // 3) 작성자 이름을 NULL 로 비운다(화면은 NULL 이면 출처별 호칭 「채널톡 이용자」를 보인다). 본문은 건드리지 않는다.
  const { error: msgError } = await db
    .from('messages')
    .update({ author_name: null })
    .eq('bot_id', id)
    .eq('source', 'channel');

  if (convError || msgError) {
    // 자격증명은 이미 지워져 새 데이터는 안 들어온다. 남은 PII 가 있다는 사실을 삼키지 않는다.
    console.error(`[channel/${id}] anonymize incomplete:`, convError?.message ?? msgError?.message);
    return NextResponse.json(
      { error: '연결은 끊었지만 일부 기록을 익명화하지 못했습니다. 다시 시도해 주세요' },
      { status: 500 },
    );
  }

  return NextResponse.json({ configured: false, anonymized: true });
}

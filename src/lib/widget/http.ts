// 위젯 공개 API 의 공통 관문 — CORS · 봇 검증 · 속도 제한 · 분류 힌트.
//
// 이 경로는 무인증이다. 아무 사이트에서나 fetch 로 때릴 수 있으므로
// 들어오는 값을 전부 의심하고, 봇이 실제로 존재하는지부터 확인한다.

import { NextRequest, NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { readBoundedJson } from '@/lib/http/body';
import { localeFromRequest } from '@/i18n/server-locale';
import { serverT } from '@/i18n/server-messages';

export const MAX_BODY_CHARS = 2000;

/**
 * 요청 본문 전체의 상한. 무인증 경로라 아무나 때릴 수 있고,
 * text(2000자) 와 별개로 context 에 수 MB 를 실어 보낼 수 있다 —
 * 저장은 상한에 걸려 안전해도 파싱 비용은 그대로 든다(실측: 5MB 가 200 으로 통과).
 * context 는 마스킹·상한을 거치면 수 KB 라 64KB 면 넉넉하다.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * 본문을 읽기 전에 크기부터 본다. 판정은 `readBoundedJson` 이 하고, 여기서는 그 결과를
 * **CORS 헤더가 붙은 위젯 응답**으로 옮기기만 한다 — 위젯은 남의 사이트에서 불리므로
 * 에러도 CORS 를 달고 나가야 브라우저가 상태 코드를 읽을 수 있다.
 *
 * 채널톡 웹훅이 같은 가드를 필요로 해서 판정 부분만 `@/lib/http/body` 로 옮겼다.
 * 문구·상태 코드·헤더는 종전과 같다.
 */
export async function readJsonBody<T>(
  req: NextRequest,
): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  const result = await readBoundedJson<T>(req, MAX_PAYLOAD_BYTES);
  if (result.ok) return { ok: true, value: result.value };

  const code = result.reason === 'too_large' ? 'body_too_large' : 'bad_format';
  return { ok: false, response: widgetError(req, code, result.status) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// 위젯은 임의의 고객 사이트에 붙는다. origin 화이트리스트는 P2 로 미뤘다(설계 §10).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function widgetJson(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { ...CORS_HEADERS, ...extraHeaders } });
}

/**
 * 위젯 오류 응답: `{ error: <코드>, message: <방문자 언어 문구> }`.
 * 위젯(public/widget.js)은 코드가 자기 표에 있으면 그 문구를, 없으면 `message` 를 보여 준다.
 * 언어는 `?locale=` → Accept-Language → en (옛 widget.js 가 캐시에 남아 `?locale` 이 없을 때도 맞게).
 * 코드는 `messages/<locale>/errors.json` 의 `widget.<code>`.
 */
export function widgetError(req: Request, code: string, status: number, values?: Record<string, string | number>) {
  const message = serverT(localeFromRequest(req, 'widget'), 'errors.widget')(code, values);
  return widgetJson({ error: code, message }, status);
}

/** 프리플라이트. 모든 위젯 라우트가 이걸 export 한다. */
export function widgetOptions() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ── 봇 ─────────────────────────────────────────────

export interface WidgetBot {
  id: string;
  service_name: string;
  status: string;
  // 봇 설정 › 위젯 모양 (20260906_03_widget_appearance.sql). 전부 NULL 허용.
  display_name: string | null;
  status_text: string | null;
  greeting: string | null;
  profile_image_url: string | null;
  operator_display_name: string | null;
  // 위젯 색상 (20260910_06_widget_colors.sql). NULL 이면 위젯 CSS 폴백(코랄·잉크).
  accent_color: string | null;
  visitor_bubble_color: string | null;
  // 첫 화면 「자주 묻는 질문」 칩 (20260911_01_widget_starter_questions.sql).
  // 폴백 재료인 knowledge_faq 는 «여기 없다» — 이 헬퍼는 config 말고도 messages·contact
  // 세 무인증 라우트가 함께 쓴다. 비공개 FAQ 답변(최대 50×1,000자)을 그 경로들의
  // 메모리로 끌어올 이유가 없고, 나중에 누가 봇 객체를 그대로 응답에 실으면
  // 그 순간 봇 지식이 통째로 공개된다. config 라우트가 필요할 때만 따로 읽는다.
  starter_questions: unknown;
  // 시작 질문이 비었을 때 FAQ 로 채울지 (20260911_02). false 면 첫 화면에 질문 줄이 안 뜬다.
  starter_faq_fallback: boolean | null;
}

/** 봇이 존재하고 멈춰 있지 않은지. 없으면 404 로 끝낸다. */
export async function resolveWidgetBot(botId: string): Promise<WidgetBot | null> {
  if (!isUuid(botId)) return null;

  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('bots')
    .select(
      'id, service_name, status, display_name, status_text, greeting, profile_image_url, operator_display_name, accent_color, visitor_bubble_color, starter_questions, starter_faq_fallback',
    )
    .eq('id', botId)
    .single();

  // 없는 봇이면 PGRST116 이라 조용히 null 이 맞다. 그 외 오류는 반드시 남긴다 —
  // 컬럼 하나가 없으면 쿼리 전체가 실패해 이 함수가 null 을 주고, 위젯은 그걸
  // 「없는 봇」으로 읽어 스스로를 화면에서 지운다(widget.js loadConfig 의 404 분기).
  // 마이그레이션을 코드보다 늦게 적용하면 라이브 사이트에서 위젯이 사라지는데,
  // 이 로그가 없으면 왜 사라졌는지 알 길이 없다.
  if (error && error.code !== 'PGRST116') {
    console.error('[widget] 봇 조회 실패', { botId, code: error.code, message: error.message });
  }

  if (!data || data.status === 'paused') return null;
  return data;
}

// ── 분류 힌트 ───────────────────────────────────────
//
// 칩 목록·힌트 문장은 lib/widget/chips.ts 한 곳에 있다(의존성 0 이라 운영자
// 미리보기도 같은 걸 쓴다). 기존 import 경로를 살려두려고 여기서 다시 내보낸다.

export {
  STARTER_QUESTION_HINT,
  WIDGET_CHIPS,
  WIDGET_HINTS,
  hintLine,
  isWidgetHint,
  type WidgetHint,
} from './chips';

// ── 속도 제한 ───────────────────────────────────────
//
// 방문자 기준과 봇 기준은 DB 로 정확히 센다(서버리스라 인스턴스가 갈려도 유효).
// IP 기준은 인메모리라 인스턴스마다 따로 센다 — 완전하지 않지만
// 한 인스턴스에 몰아치는 단순 폭주는 막는다. 정밀한 IP 제한은 P2.

const VISITOR_LIMIT_PER_MIN = 20;
const IP_LIMIT_PER_MIN = 60;

/**
 * 봇 하나가 한 시간에 받을 수 있는 «위젯» 발화 수. (심사 §7 T10 — 계획 §11 이
 * 「수용」으로 적어두고 2026-09-12 에 「안 넣는다」로 정했던 위험을 닫는다)
 *
 * 왜 봇 단위가 따로 필요한가. 방문자 20/분·IP 60/분 은 **한 명**을 재는 자다.
 * `visitorId` 는 위젯이 스스로 만드는 값이라 새로 뽑으면 그만이고, IP 는 인메모리라
 * 인스턴스가 갈리면 다시 0 부터 센다. 그래서 익명 POST 로 플랫폼 키 무료분
 * (하루 100건 · `DEFAULT_LIMITS.noKey`)을 **분 단위로** 태울 수 있었다 —
 * 그러면 그날 뒤늦게 온 진짜 방문자는 종일 답을 못 받는다.
 *
 * 왜 60인가. 무료분 100건보다 **낮게** 둔다(60 < 100). 이게 사는 건 「하루 무료분을 분
 * 단위로 태우는 경로」다 — 소진까지 **최소 두 시간**을 벌어준다. 그 이상은 아니다:
 * 두 시간째의 41번째 발화에서는 일일 예산 100 이 먼저 걸린다. 「먼저 걸리는 쪽이 항상
 * 이 게이트」는 첫 한 시간에만 참이다. 위쪽으로는, 봇 하나에 시간당 60건이면 실제
 * 서비스의 위젯 발화량으로는 아주 많은 편이라 정상 트래픽은 안 막는다.
 * 값을 바꿀 때는 `DEFAULT_LIMITS.noKey` 와의 관계(이 값 < 무료분)를 유지할 것.
 */
export const WIDGET_BOT_HOURLY_LIMIT = 60;

const ipHits = new Map<string, number[]>();

/**
 * 요청을 보낸 쪽의 IP. **플랫폼이 직접 채우는 헤더를 먼저 믿는다.**
 *
 * `x-forwarded-for` 는 클라이언트가 실어 보낼 수 있는 값이다. 그걸 먼저 읽으면,
 * 앞단이 그 헤더를 지우지 않고 «뒤에 덧붙이는» 구성일 때 공격자가 첫 항목을 매 요청
 * 바꿔 IP 상한을 통째로 빠져나간다. 무인증 라우트(위젯·데모 추적)의 유일한 관문이라
 * 그 한 칸이 크다.
 *
 * `x-vercel-forwarded-for` 와 `x-real-ip` 는 앞단이 채우고 클라이언트가 못 덮는다.
 * 둘 다 없는 로컬 개발에서만 예전처럼 `x-forwarded-for` 로 내려간다.
 */
export function clientIp(req: NextRequest): string {
  const trusted = req.headers.get('x-vercel-forwarded-for') ?? req.headers.get('x-real-ip');
  if (trusted) return trusted.trim();
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

function ipRateExceeded(req: NextRequest): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const cutoff = now - 60_000;

  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);

  // 맵이 무한정 자라지 않게 가끔 청소한다.
  if (ipHits.size > 5000) {
    for (const [key, times] of ipHits) {
      if (times.every((t) => t <= cutoff)) ipHits.delete(key);
    }
  }

  return hits.length > IP_LIMIT_PER_MIN;
}

async function visitorRateExceeded(botId: string, visitorId: string): Promise<boolean> {
  const db = getServiceRoleClient();
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('bot_id', botId)
    .eq('external_user_id', visitorId)
    .gte('detected_at', since);

  return (count ?? 0) >= VISITOR_LIMIT_PER_MIN;
}

/**
 * 봇 단위 시간당 상한. 방문자 계수와 **같은 방식**(DB 계수)이다 — 인메모리로 두면
 * 서버리스 인스턴스마다 따로 세서 봇 하나가 인스턴스 수만큼 상한을 받게 된다.
 * 마이그레이션 없이 기존 `messages` 행을 그대로 센다.
 *
 * `messages.source='web'` 으로 좁힌다. 카카오·채널톡 발화도 같은 `bot_id` 로 쌓이는데
 * 그걸 같이 세면 다른 입구의 트래픽이 위젯을 막는다(그 입구들은 각자 자기 상한을 쓴다).
 * `conversations` 임베드가 아니라 **컬럼을 직접** 본다 — 임베드는 스키마 캐시가 어긋나면
 * 조회가 통째로 실패하고, 이 함수는 실패를 통과로 읽으므로 상한이 조용히 꺼진다.
 * 채널톡 계수(`channelRateExceeded`)가 같은 이유로 같은 모양이다.
 *
 * 세는 것은 `messages` 행이므로 발화를 남기는 두 라우트(`messages`·`escalate`)만 카운터를
 * 올린다. `contact`·`confirm` 은 올리지 않되 **막히기는 한다** — 상한에 걸린 봇에서
 * 익명 쓰기를 더 받을 이유가 없고, 그 둘은 LLM 을 안 불러 예산을 태우지도 않는다.
 *
 * 계수가 실패하면 **막지 않는다**(fail open). 오류 응답이든 던지는 실패(네트워크 예외)든
 * 같다 — 던지는 쪽을 안 잡으면 호출부의 `Promise.all` 이 거부돼 라우트가 500 이 되고,
 * 그건 「막지 않는다」가 아니라 제보를 버리는 것이다. 방문자 계수와 같은 선택이고,
 * 뒤에 일일 예산(`withReplyBudget`)이 fail-closed 로 버티고 있어 지갑은 여전히 닫혀 있다.
 */
async function botRateExceeded(botId: string): Promise<boolean> {
  try {
    const db = getServiceRoleClient();
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('bot_id', botId)
      .eq('source', 'web')
      .gte('detected_at', since);

    if (error) {
      console.error('[widget] 봇 시간당 계수 실패', { botId, code: error.code, message: error.message });
      return false;
    }
    return (count ?? 0) >= WIDGET_BOT_HOURLY_LIMIT;
  } catch (err) {
    console.error('[widget] 봇 시간당 계수가 던졌다', {
      botId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

/** 어느 상한에 걸렸는지. 호출부가 상한마다 다르게 대응할 수 있게 갈라 둔다. */
export type WidgetRateLimit = 'ip' | 'visitor' | 'bot';

export type WidgetRateVerdict =
  | { ok: true }
  | { ok: false; limit: WidgetRateLimit; response: NextResponse };

/**
 * 쓰기 요청의 속도 판정. **어느 상한인지까지** 알려준다.
 *
 * `messages` 라우트가 이걸 직접 쓴다 — 봇 상한은 «답을 막는» 상한이지 «제보를 버리는»
 * 상한이 아니라서(`llm/usage.ts` 의 같은 원칙), 저장까지 마친 뒤 LLM 만 건너뛰어야 한다.
 * 429 로 끊으면 분당 1건만 보내도 남의 봇을 시간 단위로 침묵시킬 수 있다.
 * 나머지 세 라우트는 저장할 발화가 없어 `checkWriteRate` 로 그대로 429 를 낸다.
 */
export async function checkWidgetWriteRate(
  req: NextRequest,
  botId: string,
  visitorId: string,
): Promise<WidgetRateVerdict> {
  if (ipRateExceeded(req)) {
    return {
      ok: false,
      limit: 'ip',
      response: widgetError(req, 'rate_limited', 429),
    };
  }
  // 두 계수는 서로 모르는 값이라 나란히 던진다 — 위젯 예산이 10초라 왕복을 겹쳐 아낀다.
  const [visitorExceeded, botExceeded] = await Promise.all([
    visitorRateExceeded(botId, visitorId),
    botRateExceeded(botId),
  ]);
  if (visitorExceeded) {
    return {
      ok: false,
      limit: 'visitor',
      response: widgetError(req, 'too_fast', 429),
    };
  }
  if (botExceeded) {
    return {
      ok: false,
      limit: 'bot',
      response: widgetError(req, 'bot_busy', 429),
    };
  }
  return { ok: true };
}

/** 쓰기 요청 앞에 건다. 통과하면 null, 막히면 429 응답을 돌려준다. */
export async function checkWriteRate(
  req: NextRequest,
  botId: string,
  visitorId: string,
): Promise<NextResponse | null> {
  const verdict = await checkWidgetWriteRate(req, botId, visitorId);
  return verdict.ok ? null : verdict.response;
}

/**
 * 읽기 요청 앞에 건다. **IP 상한만** 본다.
 *
 * 무인증 GET 도 공짜는 아니다 — `/confirm` 의 GET 은 RPC 를 한 번 돌린다. 그런데 이 경로엔
 * 저장되는 발화가 없어 봇·방문자 계수(둘 다 `messages` 행을 센다)가 애초에 안 움직인다.
 * 봇 상한을 여기 걸면 읽기가 쓰기 트래픽 때문에 막히므로 걸지 않는다.
 */
export function checkReadRate(req: NextRequest): NextResponse | null {
  if (ipRateExceeded(req)) {
    return widgetError(req, 'rate_limited', 429);
  }
  return null;
}

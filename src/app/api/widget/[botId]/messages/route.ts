// 웹 위젯 대화 API — 무인증, CORS 개방.
// POST: 방문자가 보낸 메시지 저장 + AI 즉답
// GET:  타임라인 증분 (위젯이 폴링한다)

import { NextRequest, after } from 'next/server';

// 늦은 답 최대 30초(LLM_TIMEOUT_MS) + after() 의 자동 묶기(90초 조용한 시간 + 묶기 100초 예산).
// 묶기 마감은 요청 시작 기준(reqStartedAt + GROUPING_DEADLINE_FROM_START_MS)으로 넘긴다 — 늦은 답이
// 30초를 먹은 뒤에도 대기+묶기가 이 안에 든다. 기본값에 기대지 않는다.
export const maxDuration = 300;
import { getBotConfigFromDB } from '@/lib/bot/core';
import { callLlm, extractResult, recordLlmFailure, type BotConfig, type LlmResult } from '@/lib/bot/handler';
import { getSystemPrompt } from '@/lib/bot/prompts';
// 결제 경로(설계 v2 §2). 봇에 PayPal 이 연결돼 있고 라우터(규칙, LLM 없음)가 「결제 얘기」라고
// 하면 callLlm 대신 결제 에이전트(generateText + tools)로 간다. callLlm 은 카카오·텔레그램도
// 쓰므로 건드리지 않는다 — 갈라지는 자리는 이 라우트 하나다.
import { resolveModel, type ResolvedModel } from '@/lib/llm/provider';
import { resolvePayPalBot } from '@/lib/paypal/bot';
import type { PayPalClient } from '@/lib/paypal/client';
import { hasOpenPaymentAction } from '@/lib/paypal/actions';
import { NO_PAYMENT_ROUTE, routePayment } from '@/lib/paypal/router';
import { paymentAgentPrompt, paymentAgentSystemPrompt, runPaymentAgent } from '@/lib/paypal/agent';
import { PAYMENT_AGENT_FALLBACK, PAYMENT_NOTICES, type ReplyNotices } from '@/lib/paypal/notices';
import { PAYMENT_AGENT_RESPONSE_TYPE } from '@/lib/paypal/response-types';
import { appOrigin } from '@/lib/paypal/checkout';
import { supabasePaymentsStore } from '@/lib/paypal/store';
import { createVisitorTools, formatProductList } from '@/lib/paypal/visitor-tools';
// HOLDING_NOTICE 는 AI 가 답을 못 낸 경우(출력이 깨졌거나, 근거가 없어 스스로 넘겼거나)의
// 안내다. 문구가 holding.ts 한 곳에서 오는 이유: 프롬프트가 시키는 문장과 서버가 쓰는 문장이
// 갈라지면 방문자는 같은 상황에서 두 가지 말을 듣는다.
// SLOW_NOTICE 와 마찬가지로 **저장하지 않는다** — 저장하면 나중에 사람이 보낸 진짜 답장과
// 말풍선이 둘로 남는다. 이번 응답의 notice 로만 나간다.
// 단 하나의 예외가 «늦은 답» 경로다: 응답(SLOW_NOTICE)이 이미 나간 뒤라 notice 를 실을 곳이 없고
// 남은 통로가 폴링뿐이다. 그때는 HOLDING_MESSAGE 를 'ai' 답변으로 저장한다(아래 late 분기 주석).
import {
  GROUNDING_REMINDER,
  HOLDING_MESSAGE,
  HOLDING_NOTICE,
  applyHoldingPolicy,
  ensureEscalationInsight,
} from '@/lib/bot/holding';
import { refineCategoryWithJev } from '@/lib/classify/jev';
import { applyInsightWrite, planInsightWrite, type InsightWriteReceipt } from '@/lib/bot/db';
import { scheduleAutoGrouping, shouldScheduleAutoGrouping } from '@/lib/groups/auto-grouping';
import {
  REPLY_GROUPS_LIMIT,
  buildGroupRefMap,
  formatKnownIssuesSection,
  listRecentGroups,
  resolveKnownIssue,
} from '@/lib/groups/existing-match';
import {
  RECENT_TURNS,
  buildInsightRefMap,
  buildWidgetUserTurn,
  formatExtendableSection,
  formatRecentContext,
  listExtendableInsights,
} from '@/lib/bot/reply-context';
import {
  upsertConversation,
  saveWebMessage,
  touchConversation,
  saveConversationResponse,
  getRecentTurns,
  getTimeline,
  markConversationEscalated,
  needsEscalation,
} from '@/lib/bot/conversations';
import { chipOnlyLine, isChipOnlyText } from '@/lib/widget/chips';
import { collapseWhitespace } from '@/lib/text';
import {
  MAX_BODY_CHARS,
  checkWidgetWriteRate,
  hintLine,
  isUuid,
  isWidgetHint,
  readJsonBody,
  resolveWidgetBot,
  widgetError,
  widgetJson,
  widgetOptions,
} from '@/lib/widget/http';
import { getServiceRoleClient } from '@/lib/supabase';
import { markWidgetConnected } from '@/lib/widget/connected';
import { formatContextForPrompt, sanitizeWidgetContext } from '@/lib/widget/context';
import { settleMessageShot } from '@/lib/widget/shots';
import { withReplyBudget } from '@/lib/llm/usage';
import { emailOwnerNewConversation } from '@/lib/email/notify';

/** Origin 헤더 저장 상한. 차단이 아니라 사후 판별용이라 넉넉히 자르기만 한다(§B-7). */
const MAX_ORIGIN_CHARS = 200;

// 타임아웃은 «두 겹»이고 안쪽이 바깥보다 길어야 한다.
//
// VISITOR_WAIT_MS — 방문자가 대기 문구 없이 기다리는 시간. 이걸 넘기면 SLOW_NOTICE 를 먼저
//   보내고, 답은 뒤늦게 저장돼 위젯의 다음 폴링(5초)에 뜬다.
// LLM_TIMEOUT_MS — provider 요청 자체의 상한(SDK timeout). 「늦은 답」 경로가 살아 있으려면
//   이 값이 VISITOR_WAIT_MS 보다 커야 한다. 2026-09-23 실측: 둘을 같은 10초로 두자 10초가 되는 순간
//   provider 요청이 끊겨 callLlm 이 null 이 되고, 늦은 답은 영영 오지 않았다 — 방문자는 「바로 답
//   드릴게요」만 보고 아무것도 못 받았다(이틀간 위젯 13건 중 6건). Sonnet 5 운영 프롬프트 지연은
//   2.6~10.9초라 자주 걸린다. 30초는 maxDuration(300) 안이고 비용 상한 역할도 그대로 한다.
const VISITOR_WAIT_MS = 10_000;
const LLM_TIMEOUT_MS = 30_000;
// 자동 묶기(대기 최대 180초 + 실행 100초)의 마감. 요청 시작 기준이어야 한다 — scheduleAutoGrouping 의
// 기본값은 «묶기 시작» + 280초라, 늦은 답이 30초를 먹은 뒤면 최악 310초로 maxDuration 을 넘긴다
// (넘기면 release 가 안 돌아 잠금이 고아가 된다. 150초 뒤 저절로 풀리긴 한다).
const GROUPING_DEADLINE_FROM_START_MS = 290_000;
const SLOW_NOTICE = '말씀 잘 받았어요! 확인하고 바로 답 드릴게요 🙌';
// 오늘 자동 답변 예산을 다 쓴 경우. **「담당자 확인 필요」과 섞지 않는다** —
// 지식이 모자란 게 아니라 예산이 끝난 것이고, 운영자가 할 일도 다르다(키 등록·상한 조정).
// 이것도 저장하지 않는다.
const LIMIT_NOTICE = '말씀 잘 받았어요! 오늘은 자동 답변이 어려워 팀이 직접 읽고 답 드릴게요 🙌';
// 봇 시간당 상한에 걸린 경우. 제보는 저장됐고 자동 답변만 건너뛴다.
// LIMIT_NOTICE 와 가르는 이유: 저쪽은 **오늘**이 끝난 것이고(운영자가 키를 넣거나 상한을
// 올려야 풀린다) 이쪽은 한 시간이면 저절로 풀린다. 「오늘은 어려워」라고 하면 거짓말이 된다.
// 이것도 저장하지 않는다.
const RATE_NOTICE = '말씀 잘 받았어요! 지금 문의가 몰려 자동 답변은 잠시 쉬고 있어요. 팀이 직접 읽고 답 드릴게요 🙌';
// 기존 경로의 안내 네 가지 + 늦은 답 실패 때 저장하는 답변. 결제 경로는 같은 자리마다 영어 문장
// (lib/paypal/notices.ts)을 쓴다 — 아래 `notices` 가 경로별로 고른다. 한국어 문구 자체는 그대로다.
const DEFAULT_NOTICES: ReplyNotices = {
  slow: SLOW_NOTICE,
  rate: RATE_NOTICE,
  limit: LIMIT_NOTICE,
  holding: HOLDING_NOTICE,
  holdingMessage: HOLDING_MESSAGE,
};

export const OPTIONS = widgetOptions;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;
  const reqStartedAt = Date.now();

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError('봇을 찾을 수 없습니다', 404);

  const body = await readJsonBody<{
    visitorId?: unknown;
    text?: unknown;
    hint?: unknown;
    context?: unknown;
  }>(req);
  if (!body.ok) return body.response;
  const payload = body.value;

  const { visitorId, text } = payload;
  // 첫 화면 칩으로 시작한 메시지는 분류 힌트가 같이 온다. 모르는 값은 조용히 버린다.
  const hint = isWidgetHint(payload.hint) ? payload.hint : null;
  if (!isUuid(visitorId)) return widgetError('visitorId 형식이 올바르지 않습니다', 400);
  if (typeof text !== 'string' || text.trim() === '') {
    return widgetError('메시지가 비어 있습니다', 400);
  }
  if (text.length > MAX_BODY_CHARS) {
    return widgetError(`메시지는 ${MAX_BODY_CHARS}자까지 보낼 수 있어요`, 400);
  }

  // 봇 시간당 상한은 **여기서 끊지 않는다.** 그건 답을 막는 상한이지 제보를 버리는 상한이
  // 아니다(`llm/usage.ts` 의 일일 예산과 같은 원칙). 429 로 끊으면 분당 1건만 보내도
  // 남의 봇을 시간 단위로 침묵시킬 수 있다 — 저장까지 마친 뒤 LLM 만 건너뛴다(아래 rateHold).
  // 방문자·IP 상한은 종전대로 즉시 429 다. 그 둘은 한 사람을 재는 자라 같은 위험이 없다.
  const rate = await checkWidgetWriteRate(req, botId, visitorId);
  if (!rate.ok && rate.limit !== 'bot') return rate.response;
  const rateHold = !rate.ok;

  // 기술 맥락(페이지 URL·브라우저·콘솔 에러·짚은 요소). 무인증 경로라 모양·크기를 전부 여기서 강제하고,
  // URL 쿼리와 에러 문구의 토큰·이메일은 저장 전에 가린다. 속도제한 «뒤»에 — 정규식 마스킹은 CPU 를 쓴다
  const context = sanitizeWidgetContext(payload.context);

  // 「의견 남기기」 칩 라벨 그대로면 «시작 신호»이지 제보가 아니다(chips.ts 주석 참고).
  // 저장 본문을 라벨로 정규화한다 — 배치 분류의 exact 제외 목록이 먹으려면 앞뒤 공백이
  // 섞인 사본이 DB 에 남으면 안 된다.
  const chipOnly = isChipOnlyText(text);
  const bodyText = chipOnly ? collapseWhitespace(text) : text.trim();

  const conversation = await upsertConversation({
    botId,
    source: 'web',
    externalUserId: visitorId,
  });
  if (!conversation) return widgetError('대화를 열지 못했습니다', 500);

  const messageId = await saveWebMessage({
    widgetHint: hint,
    botId,
    conversationId: conversation.id,
    visitorId,
    text: bodyText,
    authorName: conversation.contact_name ?? undefined,
    context,
    origin: req.headers.get('origin')?.slice(0, MAX_ORIGIN_CHARS) ?? null,
  });
  // 저장이 안 된 제보에 답하면 방문자는 접수된 줄 알고 운영자는 영영 못 본다(I-23 —
  // 2026-09-13 Supabase Gateway Timeout 실측: messages 0 · 고아 인사이트 · AI 답장은 도착).
  // 503 을 돌려 위젯이 문장·힌트를 입력창에 복구하고 [보내기] 를 다시 누를 수 있게 한다.
  // 정식 카운터 둘은 소모되지 않았다 — 방문자 속도제한은 messages 행을 세고(행이 없다),
  // 일일 답변 예산(withReplyBudget)은 아래에서 올린다. 인메모리 IP 상한(checkWidgetWriteRate)만
  // 이미 올랐는데 되돌리지 않는다 — 장애 중 같은 IP 의 재시도가 60/분을 먹는 건 오히려 맞다.
  if (!messageId) {
    return widgetError('잠시 후 다시 보내주세요', 503);
  }

  // 「화면에서 선택하기」 스크린샷(I-55). **같은 봇·같은 방문자·아직 안 붙은** 것만 붙는다 — 남의 shotId 를
  // 실어 남의 화면을 자기 제보로 끌어오는 경로 차단. 못 붙이면 context 에서 조용히 뗀다(없던 것처럼).
  // 운영자 화면은 message_id 로 이미지를 찾으므로 여기 실패가 남의 이미지를 보여주는 일은 없다.
  await settleMessageShot({ botId, visitorId, messageId, context });


  // ── AI 즉답. 카카오 웹훅과 같은 프롬프트·파서를 쓴다.
  //
  // 이 라우트는 «무인증»이다. 누구나 때릴 수 있고, BYOK 를 붙인 뒤로는 그 비용이
  // 운영자 지갑에서 나간다. 그래서 LLM 을 부르기 «전에» 원자적으로 카운터를 올리고
  // 넘으면 안 부른다(withReplyBudget). 메시지는 위에서 이미 저장됐다(아니면 503 으로
  // 끊었다) — 상한은 답을 막는 장치이지 피드백을 버리는 장치가 아니다.
  //
  // 설정·최근 대화·갱신 후보를 «한 번에» 읽는다. 셋 다 LLM 호출 앞에 필요하고 서로
  // 독립이라 직렬로 두면 왕복 셋이 즉답 앞에 그대로 쌓인다.
  // 맥락 조회가 실패해도 즉답은 나간다 — 맥락은 답을 좋게 하는 재료이지 전제가 아니다.
  // 같은 묶음에 last_message_at 갱신을 싣는다 — 메시지가 «저장된 뒤»라 여기서 찍어야 유령 대화가
  // 안 생기고(I-29 근본 원인), 독립 왕복이라 즉답 앞에 직렬 지연을 더하지 않는다. touchConversation 은
  // 실패를 로그로 끝내지만, 형제들처럼 .catch 를 둔다 — 여기서 거부되면 Promise.all 이 통째로 거부돼
  // «이미 저장된» 메시지에 답을 못 한다(I-23 과 같은 모양의 사고).
  // F1 — 「이미 접수된 문제」 목록도 같은 묶음에서 읽는다. 왕복 하나가 늘지만 «직렬»로는
  // 안 늘어난다. 실패하면 빈 목록 — 대조가 안 될 뿐 즉답은 종전대로 나간다.
  // 결제 경로 재료 둘도 같은 묶음이다 — 「봇에 PayPal 연결됨?」과 「이 대화에 열린 환불 건?」.
  // 둘 다 실패하면 결제 경로를 안 타고 기존 경로로 간다(답은 나간다). 결제 얘기였다면 사람이
  // 받은편지함에서 이어받는다.
  const [loadedConfig, timeline, extendables, knownGroups, , paypalBot, hasOpenAction] = await Promise.all([
    getBotConfigFromDB(botId).catch((err): BotConfig | null => {
      console.error(`[widget/${botId}] config load failed:`, err);
      return null;
    }),
    // 「최근 대화」 재료는 **마지막** N턴이어야 한다. getTimeline 은 오름차순 200건이라
    // 긴 대화에서는 가장 «오래된» 200턴을 준다 — 화면 폴링에는 맞고 프롬프트에는 정반대다.
    // 현재 메시지가 이미 저장돼 있어 한 칸을 차지하므로 하나를 더 읽는다.
    getRecentTurns(conversation.id, RECENT_TURNS + 1).catch((err) => {
      console.error(`[widget/${botId}] recent turns load failed:`, err);
      return [];
    }),
    listExtendableInsights(conversation.id).catch((err) => {
      console.error(`[widget/${botId}] extendable load failed:`, err);
      return [];
    }),
    listRecentGroups(botId, { limit: REPLY_GROUPS_LIMIT, joinableOnly: true }).catch((err) => {
      console.error(`[widget/${botId}] known groups load failed:`, err);
      return [];
    }),
    touchConversation(conversation.id).catch((err) => {
      console.error(`[widget/${botId}] touch failed:`, err);
    }),
    resolvePayPalBot(botId).catch((err) => {
      console.error(`[widget/${botId}] paypal bot lookup failed:`, err instanceof Error ? err.message : err);
      return null;
    }),
    hasOpenPaymentAction(conversation.id).catch((err) => {
      console.error(`[widget/${botId}] open payment action lookup failed:`, err instanceof Error ? err.message : err);
      return false;
    }),
  ]);
  const config = loadedConfig; // const 여야 아래 클로저에서 좁혀진다

  // 결제 경로 판정. 칩만 누른 턴은 «시작 신호»라 결제 얘기일 수 없다. PayPal 이 안 붙은 봇은
  // 라우터를 아예 안 돈다 — 그 봇의 「환불」은 평범한 CS 질문이고 기존 경로가 지식으로 답한다.
  const paymentRoute = !chipOnly && paypalBot?.ok
    ? routePayment({ text: bodyText, recentTurns: timeline, currentMessageId: messageId, hasOpenAction })
    : NO_PAYMENT_ROUTE;
  if (paymentRoute.route) console.log(`[widget/${botId}] payment route: ${paymentRoute.reason}`);
  // 결제 에이전트의 답은 'ai' 가 아니라 'payment_agent' 로 저장한다. 위젯엔 같은 말풍선이지만,
  // 라우터가 「직전 답이 결제 에이전트」를 이 값으로 알아본다(다음 턴 "abc@x.com" 이 결제 경로에 남는 근거).
  const replyResponseType = paymentRoute.route ? PAYMENT_AGENT_RESPONSE_TYPE : 'ai';
  // 결제 경로의 방문자 문구는 전부 영어다(설계 §10) — 느림·시간당 상한·일일 예산·설정 없음·늦은 답 실패까지.
  // 에이전트가 답을 못 내는 경우만이 아니라 에이전트를 «못 부른» 경우도 결제 얘기였으면 영어로 안내한다.
  const notices = paymentRoute.route ? PAYMENT_NOTICES : DEFAULT_NOTICES;

  // 새 대화 알림 — 이 대화의 «첫 진짜 메시지»면 봇 소유자에게 메일 한 통(2026-09-23 ny 결정).
  // 칩만 누른 턴은 말이 아니라 신호라 건너뛰고, 그 뒤 처음 적은 말이 첫 메시지다. 여기 판정은
  // 최근 턴 기준의 «사전 거름»이고, 발송기가 DB 에서 처음부터 다시 확인한다(상한도 그쪽).
  // 즉답과 독립이라 after() 로 — 메일이 늦거나 실패해도 답은 나간다.
  // «앞선» 턴만 센다 — 두 탭에서 거의 동시에 보낸 첫 말 둘이 서로를 보고 둘 다 물러나면 메일이 0통이다.
  const currentAt = timeline.find((t) => t.id === messageId)?.at ?? null;
  const hasEarlierRealTurn = timeline.some(
    (t) =>
      t.kind === 'user' &&
      t.id !== messageId &&
      !isChipOnlyText(t.body) &&
      (currentAt === null || t.at < currentAt),
  );
  if (!chipOnly && !hasEarlierRealTurn) {
    after(
      emailOwnerNewConversation({ botId, conversationId: conversation.id, messageId, firstMessage: bodyText }).then(
        (outcome) => {
          if (!outcome.sent && outcome.reason !== 'not_first' && outcome.reason !== 'not_configured') {
            console.warn(`[widget/${botId}] new-conversation mail not sent: ${outcome.reason}`);
          }
        },
      ),
    );
  }

  // 모델에게 보여줄 갱신 후보. 응답의 `extends` 를 대조할 때도 «이 맵»을 쓴다 —
  // 프롬프트에 없던 제보를 갱신하는 경로가 생기지 않는다.
  const refMap = buildInsightRefMap(extendables);
  // 모델이 고른 묶음을 대조할 때도 «이 맵»을 쓴다 — 프롬프트에 없던 묶음의 진행 상황을
  // 답하는 경로가 생기지 않는다(`extends` 와 같은 규칙).
  const groupRefMap = buildGroupRefMap(knownGroups);
  const userTurn = buildWidgetUserTurn({
    // 라벨 이름은 봇 설정이 아니라 bot 행에서 가져온다. 설정 로드가 실패해도 맥락은 실린다.
    recent: formatRecentContext(timeline, messageId, bot.service_name),
    extendable: formatExtendableSection(refMap),
    knownIssues: formatKnownIssuesSection(groupRefMap),
    text: [bodyText, formatContextForPrompt(context)].filter(Boolean).join('\n'),
    // 칩만 누른 턴은 「우선 고려할 분류」가 아니라 되묻기 지시를 받는다.
    hintLine: chipOnly ? chipOnlyLine(hint) : hintLine(hint),
    reminder: GROUNDING_REMINDER,
  });

  /**
   * 정시·지연 두 경로가 «같은» 쓰기를 한다. 예전에는 각자 `saveInsight` 를 불렀는데,
   * 갱신 분기가 생긴 뒤로 한쪽만 고치면 늦게 온 답만 조각을 만든다.
   */
  let insertedCategory: string | null = null;
  const settleInsight = async (result: LlmResult): Promise<InsightWriteReceipt | null> => {
    if (!chipOnly && result.parsed !== true) return null;
    const plan = planInsightWrite({
      insight: result.insight,
      extends: result.extends,
      refMap,
      chipOnly,
      text: bodyText,
    });
    // 모델이 목록에 없는 ref 를 낸 경우. 동작은 새 행(insert) 그대로이고 흔적만 남긴다 —
    // 얼마나 자주 지어내는지를 알아야 프롬프트를 고칠지 판단할 수 있다.
    // 본문은 안 찍는다(방문자 입력이다). ref 와 후보 수면 재현에 충분하다.
    if (plan.action === 'insert' && plan.reason === 'unknown_ref') {
      console.warn(
        `[reply-context] unknown extends ref bot=${botId} ref=${String(result.extends).slice(0, 64)} 후보=${refMap.size}`,
      );
    }
    const insight = plan.action === 'insert' && result.insight
      ? await refineCategoryWithJev(bodyText, result.insight) : result.insight;
    if (plan.action === 'insert') insertedCategory = insight?.category ?? null;
    return applyInsightWrite(botId, messageId, insight, result.escalate === true, plan);
  };

  /**
   * 인사이트가 생겼거나 갱신됐으면 자동 묶기(I-10)를 건다. 90초 조용해진 뒤 묶는다 —
   * 그 안에 온 보충 턴은 `extend_insight` 로 이 인사이트에 붙어야 하기 때문이다.
   * 대기는 봇당 한 요청(대기자)만 하고 나머지는 RPC 한 번으로 끝난다. `after()` 안에서만
   * 돈다(응답은 이미 나갔다). 실패는 로그로만 — 제보는 저장됐고 운영자에겐 [지금 묶기]가 있다.
   */
  const groupAfterSettle = async (result: LlmResult, receipt: InsightWriteReceipt | null): Promise<void> => {
    if (!shouldScheduleAutoGrouping({ insightId: receipt?.id ?? null, category: insertedCategory ?? result.insight?.category ?? null, source: 'web' })) return;
    try {
      await scheduleAutoGrouping(botId, { deadlineMs: reqStartedAt + GROUPING_DEADLINE_FROM_START_MS });
    } catch (err) {
      console.error(`[widget/${botId}] auto grouping failed:`, err instanceof Error ? err.message : err);
    }
  };

  /**
   * 결제 에이전트 턴. 결과는 기존 LlmResult 모양으로 돌려 아래 저장·늦은 답·배지 코드를 그대로 탄다.
   *
   * 실패(키·provider·타임아웃)는 던지지 않고 «영어 고정 문장 + escalate» 로 돌린다 — 기존 경로의
   * null 폴백은 한국어 안내(HOLDING_NOTICE)라 결제 화면엔 맞지 않고, escalate 가 받은편지함 배지를
   * 켜 사람이 이어받게 한다. 키 실패 4분류 기록은 callLlm 과 같은 함수(recordLlmFailure)로 남긴다.
   *
   * 도구는 방문자 도구 4개(lib/paypal/visitor-tools.ts)뿐이다 — 이 (봇, 대화) 에 묶인 래퍼라
   * 모델이 남의 주문·남의 봇·상품표에 없는 금액을 말할 길이 없다. 툴킷 원형은 주지 않는다.
   * 상품 목록은 프롬프트에 싣는다(create_checkout 의 product_id 를 모델이 고르게).
   */
  const replyWithPaymentAgent = async (cfg: BotConfig, paypalClient: PayPalClient): Promise<LlmResult> => {
    let resolved: ResolvedModel | null = null;
    try {
      const store = supabasePaymentsStore();
      // 상품표를 못 읽어도 환불 대화는 되어야 한다 — 빈 목록이면 프롬프트에서 그 블록만 빠진다.
      const products = await store.listActiveProducts(botId).catch((err) => {
        console.error(`[widget/${botId}] product list failed:`, err instanceof Error ? err.message : err);
        return [];
      });
      resolved = await resolveModel(cfg);
      const outcome = await runPaymentAgent({
        model: resolved.model,
        tools: createVisitorTools({
          botId,
          conversationId: conversation.id,
          store,
          paypal: paypalClient,
          origin: appOrigin,
        }),
        system: paymentAgentSystemPrompt({ serviceName: bot.service_name, productList: formatProductList(products) }),
        prompt: paymentAgentPrompt({
          text: bodyText,
          recentTurns: timeline,
          currentMessageId: messageId,
          serviceName: bot.service_name,
        }),
      });
      if (outcome.text === null) {
        console.warn(
          `[widget/${botId}] payment agent ended without text: steps=${outcome.steps} finish=${outcome.finishReason}`,
        );
      }
      return {
        response: outcome.text ?? PAYMENT_AGENT_FALLBACK,
        insight: null,
        escalate: outcome.text === null,
        extends: null,
        matchesExistingGroup: null,
        parsed: true,
      };
    } catch (err) {
      await recordLlmFailure(cfg, resolved, err);
      return {
        response: PAYMENT_AGENT_FALLBACK,
        insight: null,
        escalate: true,
        extends: null,
        matchesExistingGroup: null,
        parsed: true,
      };
    }
  };

  // `rateHold` 면 LLM 을 아예 부르지 않는다. 일일 예산도 올리지 않는다 —
  // 부르지 않은 호출을 시도로 세면 시간당 상한이 일일 예산을 대신 태운다.
  // 결제 경로도 같은 예산 안이다 — 도구 루프는 메시지당 provider 호출이 최대 4번이라 더 비싸다.
  // paypalBot.ok 는 paymentRoute.route 의 전제라 여기서 다시 좁히기만 한다(TS 가 둘의 관계를 모른다).
  const paypalClient = paypalBot?.ok ? paypalBot.bot.client : null;
  const budget = config && !rateHold
    ? await withReplyBudget(botId, config, (): Promise<LlmResult> =>
        paymentRoute.route && paypalClient ? replyWithPaymentAgent(config, paypalClient) : (async () => {
          // 같은 예산을 SDK 안쪽까지 밀어 넣는다. 아래 Promise.race 는 «기다리기»만
          // 멈출 뿐 provider 요청은 계속 돈다 — 그 요청도 결국 운영자 돈이고,
          // 끝날 때까지 서버리스 함수가 정리되지 못한다.
          // 유저 입력 «뒤»에 근거 규칙을 한 줄 붙인다. 시스템 프롬프트에만 있는 규칙은
          // 저가 모델(키 없는 봇의 플랫폼 폴백)이 자주 놓친다 — 2026-09-10 실측에서
          // 유저 턴에 같은 규칙을 얹자 4/9 → 7/9 로 올랐다.
          const raw = await callLlm(
            config,
            getSystemPrompt(config.serviceProfile),
            userTurn,
            { timeoutMs: LLM_TIMEOUT_MS },
          );
          const result: LlmResult = raw
            ? extractResult(raw)
            : { response: null, insight: null, parsed: false };

          // 순서가 뜻을 가진다: 칩 → I-20 → 홀딩 정책 → F1.
          //
          // ① 칩만 누른 턴의 인사이트는 «서버가» 버린다. 프롬프트로 시켜도 저가 모델은
          //    종종 어기고, 그러면 내용 없는 제보가 묶여 자동 PR 후보가 된다.
          if (chipOnly) {
            result.insight = null;
            result.extends = null;
            result.matchesExistingGroup = null;
          }
          // ② I-20 — AI 가 물러난 질문은 «항상» 흔적을 남긴다. 지금까지는 모델 재량이라
          //    같은 성격의 사실 질문 6건 중 2건만 남았다. 운영자가 FAQ 로 보충할 재료다.
          //    ⚠️ 홀딩 정책 «앞» 이어야 한다 — 그쪽은 `insight.category === 'cs'` 를 보고
          //    판정하므로, 모델이 insight 를 안 준 채 escalate 로 사실 문장을 쓴 턴이
          //    뒤에 두면 정책에 안 걸려 그 문장이 그대로 나간다(코드 리뷰 MEDIUM).
          //    여기서 cs 를 채워 주면 그 턴도 대기 문구로 덮인다.
          ensureEscalationInsight(result, bodyText, { chipOnly, refMap });
          // ③ 정시·지연 두 경로가 모두 이 값을 쓴다. 여기서 한 번 거르면 둘 다 덮인다.
          applyHoldingPolicy(result, botId);
          // ④ F1 — 이미 접수된 문제면 «서버가» 진행 상황을 답한다. 모델은 「어느 묶음인가」만
          //    골랐다. 문구를 모델에 맡기면 없는 PR 번호를 지어낸다(목록에 번호를 안 싣는 이유).
          //    merged·pr_created 는 답을 대체하고, open 은 모델 답변 뒤에 한 줄을 덧붙인다 —
          //    「접수돼 있다」는 그 사람의 질문에 대한 답이 아니라서 꼬리질문을 지우면 안 된다.
          //    합류·되돌림(`responses`)은 여기서 만들지 않는다 — 그건 묶기(B1)가 한다.
          //    `escalate` 와 `insight` 는 «건드리지 않는다». 우리가 확실한 건 그 문제의
          //    «상태»이지, 이 사람이 사람 손을 필요로 하는지가 아니다.
          const known = chipOnly
            ? null
            : resolveKnownIssue(result.matchesExistingGroup, groupRefMap, result.response);
          if (known) {
            result.response = known.reply;
          }
          return result;
        })(),
      )
    : null;

  const replying = budget?.allowed ? budget.value : null;

  // 넷을 가른다: 늦음 → SLOW_NOTICE, 시간당 상한 → RATE_NOTICE, 일일 예산 → LIMIT_NOTICE,
  // 답을 못 냄 → HOLDING_NOTICE, 정상 → 없음. 어느 안내도 **저장하지 않는다**(위 상수 주석 참고).
  // 늦은 경로만 예외로 «답변»(HOLDING_MESSAGE)을 저장한다 — 아래 late 분기 주석.
  let notice: string | null = null;

  if (!replying) {
    // LLM 을 아예 부르지 않은 세 경우. 인사이트도 없다.
    if (rateHold) {
      // 봇 시간당 상한 — 예산 초과와 같은 종류다(트래픽 문제이지 지식 문제가 아니다).
      // 그래서 「담당자 확인 필요」을 찍지 «않는다». 대화는 미읽음으로 남아 받은편지함에 뜬다.
      notice = notices.rate;
    } else if (budget && !budget.allowed) {
      // 상한 초과 — 「담당자 확인 필요」을 찍지 «않는다». 그 배지는 "지식에 없어 사람이
      // 이어받아야 한다"는 뜻인데 여기는 예산 문제다. 섞으면 운영자가 지식을 고치러 간다.
      // 대화는 미읽음으로 남아 받은편지함에 그대로 뜬다 — 놓치지 않는다.
      notice = notices.limit;
    } else {
      // 설정을 못 읽어 부르지 못했다. 이건 답이 안 나간 것이므로 사람이 이어받는다.
      notice = notices.holding;
      after(markConversationEscalated(conversation.id));
    }
  } else {
    // 핸들을 잡아둔다. 답이 먼저 오면 타이머를 «해제»해야 한다 — 안 그러면
    // 방문자가 0.5초 만에 답을 받았어도 이 타이머가 최대 10초 동안 살아 있고,
    // 서버리스 함수는 대기 중인 타이머가 있는 동안 정리되지 못한다.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), VISITOR_WAIT_MS);
    });

    // 두 갈래 다 reject 하지 않는다(replying 은 catch 로 감쌌고 timeout 은 resolve 만 한다)
    // — race 가 던지지 않으므로 try/finally 가 필요 없다.
    const result = await Promise.race([replying.catch(() => null), timeout]);
    clearTimeout(timeoutHandle);

    if (result) {
      if (result.response) {
        await saveConversationResponse({
          botId,
          conversationId: conversation.id,
          triggerMessageId: messageId,
          responseType: replyResponseType,
          body: result.response,
          delivered: true,
        });
      }
      // 두 after 는 «동시»다 — 인자가 이미 시작된 promise 라 after() 가 순서를 정하지 않는다.
      // 배지(markConversationEscalated)가 묶기 대기에 막히지 않는 이유는 순서가 아니라 «별개 promise» 라서다.
      // AI 가 답을 못 냈으면 받은편지함에 「담당자 확인 필요」으로 올린다.
      if (needsEscalation(result)) after(markConversationEscalated(conversation.id));
      after(settleInsight(result).then((receipt) => groupAfterSettle(result, receipt)));
      notice = result.response ? null : notices.holding;
    } else {
      // 늦은 경우 — 안내 문구는 **저장하지 않고** 이번 응답에만 실어 보낸다.
      // 진짜 답변은 뒤늦게 저장되어 위젯의 다음 폴링에 뜬다. 늦게도 답이 없으면(30초 초과·provider
      // 오류·결과 처리 중 예외) 대기 «답변»을 저장한다 — 응답은 이미 나갔고 남은 통로가 폴링뿐이라,
      // 안 남기면 방문자는 「바로 답 드릴게요」 뒤에 영영 아무것도 못 본다.
      // 문장·kind 는 모델이 스스로 물러날 때 저장되는 것과 같다(HOLDING_MESSAGE · 'ai') — 위젯은 이
      // 말풍선이 마지막이면 「상담원 연결」 칩을 붙인다. SLOW/LIMIT/RATE 같은 «안내(notice)» 를
      // 저장하지 않는 규칙과는 다른 층이다: 이건 안내가 아니라 답이다.
      // (안내까지 저장하면 말풍선이 둘로 남는다)
      notice = notices.slow;
      // 저장은 «정확히 한 번». then 이 저장한 뒤의 단계(settleInsight 등)가 던져 catch 로 와도
      // 다시 저장하지 않고, replying 자체가 reject 해 then 을 건너뛴 경우에만 catch 가 저장한다.
      let lateSaved = false;
      const saveLate = async (body: string) => {
        lateSaved = true;
        await saveConversationResponse({
          botId,
          conversationId: conversation.id,
          triggerMessageId: messageId,
          responseType: replyResponseType,
          body,
          delivered: true,
        });
      };
      after(
        replying
          .then(async (late) => {
            // late 객체는 건드리지 않는다 — needsEscalation(late) 는 response null 을 보고 배지를 켠다.
            await saveLate(late.response ?? notices.holdingMessage);
            const receipt = await settleInsight(late);
            // 늦은 것과 못 답한 것은 다르다. 늦게라도 답이 나왔으면 사람이 이어받을 일이 없다 —
            // 그래서 타임아웃 자체가 아니라 «늦게 도착한 결과»로 판정한다.
            if (needsEscalation(late)) await markConversationEscalated(conversation.id);
            // 배지·저장이 다 끝난 «뒤»에 90초를 기다린다. 앞에 두면 배지가 90초 늦는다.
            await groupAfterSettle(late, receipt);
          })
          .catch(async (err) => {
            console.error(`[widget/${botId}] late reply failed:`, err);
            if (!lateSaved) {
              await saveLate(notices.holdingMessage).catch((e) =>
                console.error(`[widget/${botId}] late holding save failed:`, e),
              );
            }
            await markConversationEscalated(conversation.id);
          }),
      );
    }
  }

  const items = await getTimeline(conversation.id);
  return widgetJson({
    conversationId: conversation.id,
    // 방금 저장된 제보의 id. 랜딩 「라이브 데모」 팝업이 이걸로 진행(분류 → 묶음)을 추적한다.
    // 위젯이 타임라인을 거꾸로 훑어 마지막 user 항목을 찾는 대신 서버가 곧장 알려준다 —
    // 위젯은 gzip 상한(19KB)에 붙어 있어 클라이언트 루프 한 벌이 비싸다.
    messageId,
    items,
    notice,
    // escalated 는 일부러 안 싣는다 — 이번 메시지로 AI 가 물러났는지는 after() 뒤에야 알아서
    // 여기 값은 «보내기 전» 상태다. 최신 상태는 다음 폴링(GET)이 준다.
    contact: {
      name: conversation.contact_name,
      email: conversation.contact_email,
      phone: conversation.contact_phone,
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;

  const bot = await resolveWidgetBot(botId);
  if (!bot) return widgetError('봇을 찾을 수 없습니다', 404);

  const visitorId = req.nextUrl.searchParams.get('visitorId');
  const afterAt = req.nextUrl.searchParams.get('after');
  if (!isUuid(visitorId)) return widgetError('visitorId 형식이 올바르지 않습니다', 400);

  // 첫 호출이 곧 "위젯이 사이트에 붙었다"는 신호다. 온보딩 화면이 이걸 폴링한다.
  if (!afterAt) {
    after(markWidgetConnected(botId));
  }

  const db = getServiceRoleClient();
  const { data: conversation } = await db
    .from('conversations')
    .select('id, contact_name, contact_email, contact_phone, handoff_requested_at')
    .eq('bot_id', botId)
    .eq('source', 'web')
    .eq('external_user_id', visitorId)
    .maybeSingle();

  // 아직 한 마디도 안 한 방문자 — 빈 대화로 답한다.
  if (!conversation) {
    return widgetJson({
      conversationId: null,
      items: [],
      serviceName: bot.service_name,
      escalated: false,
      contact: { name: null, email: null, phone: null },
    });
  }

  const items = await getTimeline(conversation.id, afterAt);
  return widgetJson({
    conversationId: conversation.id,
    items,
    serviceName: bot.service_name,
    // 방문자가 «직접» 상담원을 불렀는가. 위젯이 하단 상태 줄을 이걸로 켜고 끈다.
    // AI 가 물러난 것(escalated_at)만으로는 안 켜진다 — 그때는 대기 문구 밑 「상담원 연결」 칩이
    // 남아 방문자가 누르게 한다(2026-09-16 ny 결정).
    escalated: conversation.handoff_requested_at !== null,
    contact: {
      name: conversation.contact_name,
      email: conversation.contact_email,
      phone: conversation.contact_phone,
    },
  });
}


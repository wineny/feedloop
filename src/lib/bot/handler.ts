// 메시지 처리 — 분류 → Gemini 호출 → 응답 전송 → DB 저장

import type { Context } from 'grammy';
import { generateText } from 'ai';
import {
  getSystemPrompt,
  getFollowUpPrompt,
  getCsAnswerPrompt,
  type ServiceProfile,
} from './prompts';
import { applyHoldingPolicy, holdingMessage, visitorTextLocale, type HoldingLocale } from './holding';
import { after } from 'next/server';
import { scheduleAutoGrouping, shouldScheduleAutoGrouping } from '@/lib/groups/auto-grouping';

import {
  saveMessage,
  saveInsight,
  saveResponse,
  getRecentMessages,
  checkCooldown,
  updateCooldown,
} from './db';
import { resolveModel, LlmConfigError, type ResolvedModel } from '@/lib/llm/provider';
import { classifyFailure } from '@/lib/llm/key';
import { markLlmKeyFailed, clearLlmKeyFailure } from '@/lib/llm/failure';

/**
 * I-10 자동 묶기를 응답 뒤로 미룬다. grammy 웹훅은 요청 안에서 이 핸들러를 기다리므로
 * `after()` 가 붙는다. 요청 밖(단위 테스트)에서 부르면 `after` 가 던지는데, 그때는 그냥
 * 떠 있는 promise 로 둔다 — 이 경로엔 등록된 봇이 0 이라 실전 부담이 없다.
 */
function deferAutoGrouping(botId: string): void {
  const task = scheduleAutoGrouping(botId).catch((err) =>
    console.error(`[bot] auto grouping failed bot=${botId}:`, err instanceof Error ? err.message : err),
  );
  try {
    after(task);
  } catch {
    void task;
  }
}

// ── 타입 ────────────────────────────────────────────

interface BotConfig {
  botId: string;
  mentionPatterns: string[];
  feedbackKeywords: {
    negative: string[];
    positive: string[];
    question: string[];
  };
  serviceProfile: ServiceProfile;
  cooldownIntervalSec?: number;
  cooldownMaxDaily?: number;
  // ── BYOK 재료 (계획 §A-2). getBotConfigFromDB 가 지식과 «같은 select» 로 싣는다.
  //    resolveModel / resolveLimit 은 이 값만 보고 판정한다 — DB 를 다시 읽지 않는다.
  /** NULL = 기본값(키 없음 100 / 운영자 키 있으면 한도 없음) */
  dailyReplyLimit?: number | null;
  /** 운영자 키(AES). 이 값의 «존재 여부»가 곧 BYOK 여부다. 복호화는 resolveModel 에서만. */
  llmApiKeyEncrypted?: string | null;
  llmProvider?: string | null;
  /** 운영자가 고른 모델. NULL = 그 provider 의 추천 기본값 */
  llmModel?: string | null;
  /**
   * 즉답 호출이 마지막으로 실패한 시각. 「키 확인 필요」 배지의 판정 근거다.
   * `callLlm` 이 «성공했을 때» 이 값이 있으면 그때만 지운다 — 평소엔 DB 왕복이 0 이다.
   * 지우고 나면 캐시된 config 도 같이 고쳐서 5분 동안 같은 UPDATE 를 반복하지 않는다.
   */
  llmKeyFailedAt?: string | null;
}

interface LlmResult {
  response: string | null;
  insight: {
    category: string;
    summary: string;
    sentiment: string;
  } | null;
  escalate?: boolean;
  /**
   * 모델이 「근거가 없어 답하지 않는다」고 표시했다(응답 JSON 의 `hold`). 대기 문구는 서버가 방문자 언어로
   * 넣는다(`applyHoldingPolicy`). `extractResult` 가 이 값이 true 면 escalate 도 켠다.
   */
  hold?: boolean;
  /**
   * 이 턴이 «앞 제보의 보충»이면 그 제보의 ref(위젯 유저 턴의 「이 대화의 기존 제보」 목록).
   * 새 제보면 null. 카카오·텔레그램은 목록 자체를 안 실으므로 늘 null 이고, 실려 와도
   * 그쪽 호출부가 안 읽으니 무해하다.
   */
  extends?: string | null;
  /**
   * F1 — 이 턴이 «이미 접수된 문제» 목록의 어느 묶음과 같은 문제인지(그 묶음의 ref).
   * 목록을 싣는 것은 위젯 즉답뿐이라 카카오·텔레그램은 늘 null 이다.
   * 목록 밖 값의 폐기와 답변 문구 조립은 서버가 한다(`groups/existing-match.ts`).
   */
  matchesExistingGroup?: string | null;
  /** false = JSON 파싱 실패. 호출부는 raw 대신 자기 폴백 문구를 쓴다(계획 §A-3). */
  parsed?: boolean;
}

// ── LLM 호출 (BYOK) ─────────────────────────────────
//
// 이름이 provider 중립인 이유: 어느 provider 로 나가는지는 «봇마다» 다르다.
// 운영자가 키를 넣었으면 그 사람의 provider·모델·돈으로, 안 넣었으면 우리 플랫폼 키로 간다.
//
// 싱글턴을 두지 않는다. 봇마다 키가 다르므로 프로세스 하나에 클라이언트 하나를 캐시하면
// 남의 키로 남의 봇을 부르게 된다. 생성 비용은 무시할 만하다.

/**
 * 텔레그램 즉답의 LLM 예산.
 *
 * 위젯 10초·카카오 4초와 달리 텔레그램에는 «채널이 강제하는 마감»이 없다. 그렇다고
 * 무한정 두면 provider 가 매달릴 때 함수가 maxDuration 까지 붙들리고, 그동안 운영자 키로
 * 나간 요청도 살아 있다 — 채널이 안 재촉한다는 것이 값을 안 물어도 된다는 뜻은 아니다.
 * 사람이 답을 기다려 줄 만한 상한으로 넉넉히 잡되, 상한은 반드시 있어야 한다.
 */
const TELEGRAM_LLM_TIMEOUT_MS = 30_000;

/**
 * `botId` 가 아니라 `BotConfig` 를 받는다 — 세 호출부(위젯·카카오·텔레그램)가 모두
 * 이미 config 를 손에 쥐고 있어 DB 를 다시 읽을 이유가 없다.
 *
 * 실패 시 반환값은 예전과 같이 `null` 이다. 상위 폴백(위젯 10초·카카오 4초·텔레그램 분기)이
 * 그대로 동작한다. 달라진 건 «운영자에게 실패 사유가 남는다»는 것뿐이다.
 */
export async function callLlm(
  config: BotConfig,
  systemPrompt: string,
  userMessage: string,
  options?: { timeoutMs?: number; recordKeyFailure?: boolean },
): Promise<string | null> {
  let resolved: ResolvedModel | null = null;
  try {
    resolved = await resolveModel(config);
    const { text } = await generateText({
      model: resolved.model,
      system: systemPrompt,
      prompt: userMessage,
      // ⚠️ 반드시 0 이어야 한다. AI SDK v7 기본값은 2 라 «우리 호출 1건이 provider 호출 3건»이 된다.
      // 일일 상한이 3배로 새고(상한이 상한이 아니게 된다), 카카오 4초 예산은 첫 재시도에서 깨진다.
      // 재시도는 우리가 하지 않는다 — 실패하면 상위 폴백 문구가 나가고 사람이 이어받는다.
      maxRetries: 0,
      // 호출부의 예산(위젯 10초·카카오 4초)을 SDK 안쪽까지 밀어 넣는다.
      // 바깥 Promise.race 는 «기다리기»를 멈출 뿐 provider 요청은 계속 도는데,
      // 그 요청도 결국 운영자 돈이고 함수 수명을 잡는다.
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });

    // 지난 실패 표시를 «성공했을 때만» 지운다. 안 지우면 운영자가 키를 고쳐 답이 다시
    // 나가기 시작해도 「키 확인 필요」 배지가 영구히 떠 있게 된다.
    if (config.llmKeyFailedAt && resolved.usingOwnKey) {
      await clearLlmKeyFailure(config.botId);
      // 캐시된 config 를 그 자리에서 고친다. core.ts 의 configCache 가 «이 객체»를 들고 있어
      // 이렇게 하면 5분 캐시가 만료될 때까지 같은 UPDATE 를 메시지마다 반복하지 않는다.
      // (core.ts 를 import 해 invalidateBotCache 를 부르면 core→handler→failure→core 순환이 된다)
      config.llmKeyFailedAt = null;
    }

    return text?.trim() || null;
  } catch (err) {
    // `recordKeyFailure: false` 는 «이 실패로 운영자 키를 의심하지 말라»는 뜻이다.
    // 배치 분류처럼 예산이 이 경로 사정으로 정해지는 호출이 그렇다 — 50건을 60초
    // 안에 못 끝낸 것은 키 문제가 아닌데, `classifyFailure` 는 분류 안 되는 실패를
    // 전부 'connection' 으로 떨어뜨리고 그러면 「키 확인 필요」 배지가 켜진다.
    // 운영자는 멀쩡한 키를 5분(config 캐시) 동안 의심하게 된다.
    if (options?.recordKeyFailure === false) {
      console.error(
        `[bot] LLM call failed (not recorded as a key failure): bot=${config.botId} ` +
          `provider=${resolved?.provider ?? '?'}`,
      );
      return null;
    }
    await recordLlmFailure(config, resolved, err);
    return null;
  }
}

/**
 * 실패를 «운영자가 고칠 수 있는 형태»로 남긴다.
 *
 * 우리 키로 자동 폴백하지 않는다 — 조용히 우리 돈이 나가고 운영자는 키가 죽은 걸
 * 영원히 모르게 된다. 대신 사유를 4분류로 남기고, 방문자에겐 상위 폴백 문구가 간다.
 *
 * export 인 이유: 위젯의 결제 에이전트(lib/paypal/agent.ts 경로)는 `callLlm` 을 거치지 않고
 * 같은 provider 를 부른다. 실패를 같은 4분류·같은 배지로 남기려면 이 함수를 같이 써야 한다.
 */
export async function recordLlmFailure(
  config: BotConfig,
  resolved: ResolvedModel | null,
  err: unknown,
): Promise<void> {
  const usingOwnKey = resolved
    ? resolved.usingOwnKey
    : err instanceof LlmConfigError
      ? err.usingOwnKey
      : Boolean(config.llmApiKeyEncrypted);

  const rawStatus = (err as { statusCode?: unknown } | null)?.statusCode;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  // 분류에만 쓴다. 이 문자열은 로그에도 DB 에도 안 들어간다 — provider 메시지에
  // 키 조각이나 내부 정보가 섞일 수 있다.
  const detail = err instanceof Error ? `${err.name} ${err.message}` : '';
  const kind = classifyFailure(status, detail);

  console.error(
    `[bot] LLM call failed: bot=${config.botId} provider=${resolved?.provider ?? '?'} ` +
      `status=${status ?? '?'} kind=${kind} ownKey=${usingOwnKey}`,
  );

  // 플랫폼 폴백(키 없는 봇)이 실패한 것은 «운영자 잘못이 아니다». bots 에 쓰지 않는다.
  if (!usingOwnKey) return;

  await markLlmKeyFailed(config.botId, kind);
}

/**
 * JSON 파싱이 깨졌을 때(`parsed === false`) 분기별 폴백 문구를 얹는다.
 *
 * 왜 필요한가: `handleMessage` 는 `if (result.response)` 로 전송·저장·쿨다운을 통째로
 * 감싼다. `parsed:false` 가 생기기 전에는 raw 가 늘 채워져 있어 이 경로가 드러나지 않았다.
 * 이제 막지 않으면 «텔레그램 봇이 조용히 침묵»한다.
 *
 * 문구는 새로 만들지 않는다 — 같은 분기의 `raw === null`(호출 실패) 폴백을 그대로 쓴다.
 */
function withParseFallback(result: LlmResult, fallback: string | null): LlmResult {
  if (result.parsed !== false) return result;
  return { ...result, response: fallback };
}

// ── LLM 응답 파싱 ───────────────────────────────────

export function extractResult(raw: string): LlmResult {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || !('response' in parsed) || !('insight' in parsed)
      || (parsed.response !== null && typeof parsed.response !== 'string')
      || (parsed.insight !== null && (typeof parsed.insight !== 'object' || Array.isArray(parsed.insight)
        || typeof parsed.insight.category !== 'string' || typeof parsed.insight.summary !== 'string'
        || !parsed.insight.summary.trim() || typeof parsed.insight.sentiment !== 'string'))
      || (parsed.escalate !== undefined && typeof parsed.escalate !== 'boolean')) {
      throw new Error('invalid_response_shape');
    }
    return {
      response: parsed.response || null,
      insight: parsed.insight || null,
      // 문자열이 아니면 null 이다. 모델이 객체·숫자·true 를 넣어도 그건 ref 가 아니고,
      // 어차피 refMap 대조에서 걸리지만 여기서 모양을 좁혀 두면 호출부가 단순해진다.
      extends: typeof parsed.extends === 'string' ? parsed.extends.trim() : null,
      // `extends` 와 같은 이유로 문자열만 받는다. 목록 대조는 호출부가 한다.
      matchesExistingGroup:
        typeof parsed.matches_existing_group_id === 'string' ? parsed.matches_existing_group_id.trim() : null,
      // hold 는 «사람이 이어받아야 한다»를 품는다 — 모델이 escalate 를 빠뜨려도 받은편지함 배지와
      // I-20 흔적(ensureEscalationInsight)이 같이 켜지게 여기서 합친다. 불리언이 아니면 false 로 본다.
      escalate: parsed.escalate === true || parsed.hold === true,
      hold: parsed.hold === true,
      parsed: true,
    };
  } catch {
    // ⚠️ 예전에는 raw 를 그대로 response 로 돌려줬다. JSON 이 깨지면 모델의 원시 출력이
    //    — 시스템 프롬프트 조각이 섞였을 수도 있는 — 방문자에게 그대로 갔다.
    //    지어내지 않는다는 원칙은 «출력 파싱이 깨진 경우에도» 적용된다(계획 §A-3).
    //    호출부가 response === null 을 보고 자기 안내 문구를 쓰고, 대화는 사람에게 넘어간다.
    return {
      response: null,
      // raw 앞부분은 남긴다 — 운영자 쪽 기록이라 노출 문제가 없고 디버깅에 필요하다.
      insight: { category: 'other', summary: raw.slice(0, 200), sentiment: 'neutral' },
      // 파싱이 깨진 출력에서 ref 를 «짐작»하지 않는다. 잘못 짚으면 멀쩡한 제보의
      // summary 가 깨진 raw 앞부분으로 덮인다 — 새 행으로 남기는 편이 회복 가능하다.
      extends: null,
      // 깨진 출력에서 묶음 ref 를 «짐작»하지 않는다 — 엉뚱한 묶음의 진행 상황을 답하게 된다.
      matchesExistingGroup: null,
      escalate: true,
      parsed: false,
    };
  }
}

/** 텔레그램 «봇을 직접 부른» 턴에서 답을 못 냈을 때. 방문자 말의 언어로. */
const RETRY_LATER: Record<HoldingLocale, string> = {
  ko: '잠시 후 다시 말씀해주세요~',
  en: 'Please try again in a moment.',
};

// ── 메시지 분류 ─────────────────────────────────────

type MessageType = 'mention' | 'keyword' | 'question' | 'general';

function classifyMessage(body: string, config: BotConfig): MessageType {
  for (const pattern of config.mentionPatterns) {
    if (body.includes(pattern)) return 'mention';
  }
  for (const kw of config.feedbackKeywords.negative) {
    if (body.includes(kw)) return 'keyword';
  }
  for (const kw of config.feedbackKeywords.positive) {
    if (body.includes(kw)) return 'keyword';
  }
  for (const kw of config.feedbackKeywords.question) {
    if (body.includes(kw)) return 'question';
  }
  return 'general';
}

function findMatchedKeyword(body: string, config: BotConfig): string | null {
  const allKeywords = [
    ...config.feedbackKeywords.negative,
    ...config.feedbackKeywords.positive,
  ];
  for (const kw of allKeywords) {
    if (body.includes(kw)) return kw;
  }
  return null;
}

// ── 메인 핸들러 ─────────────────────────────────────

export async function handleMessage(ctx: Context, config: BotConfig) {
  const text = ctx.message?.text;
  if (!text) return;

  // 봇 메시지에 대한 reply → 항상 응답 (대화 이어가기)
  const isReplyToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  const msgType = isReplyToBot ? 'mention' as MessageType : classifyMessage(text, config);

  // general 메시지는 저장만 하고 응답 안 함
  if (msgType === 'general') {
    await saveMessage(config.botId, ctx);
    return;
  }

  // 쿨다운 체크 (30초 간격, 일 50회 기본)
  const canRespond = await checkCooldown(
    config.botId,
    config.cooldownIntervalSec ?? 30,
    config.cooldownMaxDaily ?? 50,
  );
  if (!canRespond) {
    await saveMessage(config.botId, ctx);
    return;
  }

  const messageId = await saveMessage(config.botId, ctx);
  if (!messageId) return;

  // 최근 대화 컨텍스트
  const recent = await getRecentMessages(config.botId, ctx.message!.chat.id);
  const context = recent.map((m: { author_name: string; body: string }) => `${m.author_name}: ${m.body}`).join('\n');

  // LLM 호출. 텔레그램은 대화 언어를 저장하지 않는다 — 답은 모델이 방문자 말의 언어를 따라가고,
  // 서버가 넣는 문장(대기 문구·재시도 안내)은 방문자 말에서 고른다(한글 없음 + 라틴 문자 = en).
  let result: LlmResult;
  const systemPrompt = getSystemPrompt(config.serviceProfile);
  const visitorLocale = visitorTextLocale(text, 'ko');

  switch (msgType) {
    case 'mention': {
      const userMessage = context
        ? `Recent conversation:\n${context}\n\nCurrent message:\n${ctx.message!.from?.first_name}: ${text}`
        : `${ctx.message!.from?.first_name}: ${text}`;
      const raw = await callLlm(config, systemPrompt, userMessage, {
        timeoutMs: TELEGRAM_LLM_TIMEOUT_MS,
      });
      // 봇을 직접 부른 상황이라 침묵이 곧 고장으로 읽힌다.
      result = raw
        ? withParseFallback(extractResult(raw), RETRY_LATER[visitorLocale])
        : { response: RETRY_LATER[visitorLocale], insight: null };
      break;
    }
    case 'keyword': {
      const keyword = findMatchedKeyword(text, config) || '';
      const followUp = getFollowUpPrompt(config.serviceProfile, context, keyword, text);
      const raw = await callLlm(config, systemPrompt, followUp, {
        timeoutMs: TELEGRAM_LLM_TIMEOUT_MS,
      });
      // 키워드 감지는 원래 답을 «안 할 수 있는» 분기다. 깨진 JSON 에서도 침묵이 맞고,
      // 말하지 않았으니 updateCooldown 이 안 불리는 것도 맞다(기존 동작 그대로).
      result = raw
        ? withParseFallback(extractResult(raw), null)
        : { response: null, insight: { category: 'other', summary: text.slice(0, 200), sentiment: 'neutral' } };
      break;
    }
    case 'question': {
      const csPrompt = getCsAnswerPrompt(config.serviceProfile, text);
      const raw = await callLlm(config, systemPrompt, csPrompt, {
        timeoutMs: TELEGRAM_LLM_TIMEOUT_MS,
      });
      // 질문에 침묵하면 안 된다. 사람에게 넘긴다(extractResult 의 catch 가 escalate 를 이미 켠다).
      // 폴백 문구도 holding.ts 한 곳에서 온다 — 정책(applyHoldingPolicy)이 넣는 문장과 갈라지면 안 된다.
      result = raw
        ? withParseFallback(extractResult(raw), holdingMessage(visitorLocale))
        : { response: holdingMessage(visitorLocale), insight: { category: 'cs', summary: text.slice(0, 200), sentiment: 'neutral' }, escalate: true };
      break;
    }
    default:
      return;
  }

  // 서버측 방어 — 모델이 «자신 없다»(escalate) 면서 «질문»(cs) 에 답 텍스트를 냈으면
  // 그 텍스트를 우리 대기 문구로 바꾼다. 텔레그램의 mention·keyword·question 세 분기가 모두 여기를 지난다
  // (카카오는 별도 라우트 api/kakao/webhook 이 같은 정책을 직접 건다).
  result = applyHoldingPolicy(result, config.botId, visitorLocale);

  // 응답 전송 (reply 실패 시 일반 메시지로 fallback)
  if (result.response) {
    try {
      await ctx.reply(result.response, { reply_parameters: { message_id: ctx.message!.message_id } });
    } catch {
      await ctx.api.sendMessage(ctx.message!.chat.id, result.response);
    }
    await saveResponse(config.botId, messageId, msgType, result.response);
    await updateCooldown(config.botId);
  }

  // 인사이트 저장 — 답장은 위에서 이미 나갔다. 저장 실패는 답장을 되돌릴 수 없으니 로그로만 남긴다(I-28).
  // messageId 가 null 인 경로는 위(`if (!messageId) return`)에서 이미 끊었다.
  if (result.parsed === true) {
    const receipt = await saveInsight(config.botId, messageId, result.insight, result.escalate === true).catch((err) => {
      console.error(`[bot/${config.botId}] insight save failed:`, err);
      return null;
    });
    if (shouldScheduleAutoGrouping({ insightId: receipt?.id ?? null, category: result.insight?.category ?? null, source: 'telegram' })) deferAutoGrouping(config.botId);
  }

  console.log(`[bot] ${msgType} | ${text.slice(0, 50)} → ${result.response?.slice(0, 50) || '(no reply)'}`);
}

export { classifyMessage, type BotConfig, type MessageType, type LlmResult };

// 카카오 i 오픈빌더 스킬 서버 — 동적 라우팅
// POST /api/kakao/webhook/{botId}
//
// ⚠️ **2026-09-14 부터 기본으로 닫혀 있다.** `KAKAO_WEBHOOK_ENABLED=true` 라야 받는다.
//
// 왜: 이 라우트는 서명도 시크릿도 없이 열려 있었다. 오픈빌더가 서명 헤더를 주지 않기
// 때문인데(운영자가 스킬 서버 URL 을 직접 붙여넣는 구조), 그렇다고 불가피했던 건 아니다 —
// 채널톡은 같은 처지에서 경로에 시크릿 세그먼트를 붙였다(`/[botId]/[token]`).
// 게다가 `botId` 는 비밀이 아니다. 위젯 스니펫의 `data-feedloop` 로 모든 방문자에게 공개된다.
//
// 즉 아무나 POST 하면 메시지·인사이트가 쌓이고 LLM 예산이 나갔다. `bump_kakao_usage` 는
// 계측만 하고 차단하지 않는다. `pr_mode='auto'` 봇이면 익명 제보가 PR 까지 사람 없이 간다
// (채널톡에는 연결 시 approve 로 내리는 U4 강등이 있지만 카카오엔 없다).
//
// 닫아도 잃는 것이 없음을 실측으로 확인했다(2026-09-14): 마지막 카카오 발화 2026-09-06,
// 이후 0건, **미전달 대기열 0건**. 과거 대화 3개·메시지 5건은 DB 에 그대로 있고 「대화」
// 목록에도 계속 보인다 — 그건 이 라우트와 무관하다.
//
// 코드·대기열 로직은 지우지 않았다. 다시 쓸 일이 생기면 env 한 줄로 켠다. 다만 켜기 전에
// 경로 시크릿(채널톡과 대칭)과 auto 강등을 먼저 붙이는 것이 옳다 — 백로그 I-34.
//
// 오픈빌더 제약: 1:1 채팅만 가능, 응답 5초 제한, 선톡(먼저 보내기) 불가.
// 그래서 텔레그램과 달리 모든 발화를 피드백 후보로 처리하고,
// 5초 안에 못 끝나면 안내 문구로 폴백한다.

import { NextRequest, NextResponse, after } from 'next/server';

// 응답은 4초 안에 나가지만 after() 의 자동 묶기(90초 조용한 시간 + 묶기 100초)가 뒤에 돈다.
export const maxDuration = 300;
import { getBotConfigFromDB } from '@/lib/bot/core';
import { scheduleAutoGrouping, shouldScheduleAutoGrouping } from '@/lib/groups/auto-grouping';
import { callLlm, extractResult, type LlmResult } from '@/lib/bot/handler';
import { getSystemPrompt } from '@/lib/bot/prompts';
import {
  saveKakaoMessage,
  saveInsight,
  saveResponse,
  getRecentKakaoMessages,
  markBotConnected,
} from '@/lib/bot/db';
import { isOpenBuilderTest, type KakaoSkillPayload } from '@/lib/bot/kakao-test-payload';
import { bumpKakaoUsage } from '@/lib/llm/usage';
import { personLabel } from '@/lib/channel/labels';
import {
  touchConversation,
  upsertConversation,
  getUndeliveredResponses,
  markResponsesDelivered,
  markConversationEscalated,
  needsEscalation,
} from '@/lib/bot/conversations';
import { HOLDING_NOTICE, applyHoldingPolicy, visitorTextLocale } from '@/lib/bot/holding';

const REPLY_TIMEOUT_MS = 4000; // 카카오 5초 제한보다 여유 있게
// 대기열 조회는 인덱스 한 번이면 끝난다. DB 가 늦으면 이번엔 포기하고 다음 발화로 미룬다
// — 되돌림·운영자 답장 때문에 응답 전체가 5초를 넘기면 안 된다.
const QUEUE_LOOKUP_TIMEOUT_MS = 1500;
// 오픈빌더 말풍선은 한 응답에 3개까지. 밀린 것 2개 + 이번 답변 1개.
const MAX_QUEUED_PER_REPLY = 2;
// 호출 실패·타임아웃 폴백. 대기 문구와 같은 단일 출처(holding.ts)를 쓴다.
const FALLBACK_TEXT = HOLDING_NOTICE;
const CONNECTED_TEXT =
  'Feedloop 연결 확인됐어요 ✅\n이제 이 채널로 들어오는 피드백을 받아서 정리해드립니다.';

function kakaoSimpleText(text: string) {
  return kakaoTexts([text]);
}

/** 말풍선 여러 개 — 밀려 있던 답장·되돌림을 이번 답변 앞에 붙여 보낸다. */
function kakaoTexts(texts: string[]) {
  return NextResponse.json({
    version: '2.0',
    template: { outputs: texts.map((text) => ({ simpleText: { text } })) },
  });
}

/** 대기열 조회가 응답 예산을 잡아먹지 않도록 자체 타임아웃을 건다. */
async function lookupQueued(conversationId: string | null) {
  if (!conversationId) return [];
  const timeout = new Promise<never[]>((resolve) =>
    setTimeout(() => resolve([]), QUEUE_LOOKUP_TIMEOUT_MS),
  );
  return Promise.race([
    getUndeliveredResponses(conversationId, MAX_QUEUED_PER_REPLY).catch(() => []),
    timeout,
  ]);
}

async function processUtterance(
  botId: string,
  userId: string,
  utterance: string,
  conversationId: string | null,
): Promise<string> {
  const config = await getBotConfigFromDB(botId);

  const messageId = await saveKakaoMessage(botId, {
    userId,
    utterance,
    conversationId,
  });

  if (!messageId) return '메시지를 저장하지 못했습니다. 잠시 후 다시 보내주세요.';

  // 메시지가 «남은 뒤» 시각을 찍는다(I-29 근본 원인). 최근 대화 조회와 «같이» 보낸다 — 4초 예산이라
  // 직렬 왕복을 더하지 않는다. 다만 이 단계는 둘 중 느린 쪽을 기다린다(PK 단건 UPDATE, 보통 수십 ms).
  // 쓰기가 느린 장애(I-23)면 바로 위 saveKakaoMessage 가 먼저 실패해 여기 오지 않는다.
  // touchConversation 은 실패를 로그로 끝내지만 .catch 를 둔다 — 거부되면 답장이 오류 문구로 바뀐다.
  const [recent] = await Promise.all([
    getRecentKakaoMessages(botId, userId),
    conversationId
      ? touchConversation(conversationId).catch((err) => console.error(`[kakao/${botId}] touch failed:`, err))
      : Promise.resolve(),
  ]);
  const context = recent
    .map((m: { author_name: string | null; body: string }) => `${m.author_name ?? personLabel('kakao')}: ${m.body}`)
    .join('\n');

  const systemPrompt = getSystemPrompt(config.serviceProfile);
  const userMessage = context
    ? `Recent conversation:\n${context}\n\nCurrent message:\nVisitor: ${utterance}`
    : `Visitor: ${utterance}`;

  // 봇마다 provider·모델·키가 다르다 — config 를 그대로 넘긴다(DB 를 다시 읽지 않는다).
  //
  // 4초 예산을 SDK 안쪽까지 밀어 넣는다. 바깥 Promise.race 는 «기다리기»만 멈출 뿐
  // provider 요청은 계속 돌고, 그것도 운영자 돈이며 함수 수명을 잡는다.
  const raw = await callLlm(config, systemPrompt, userMessage, { timeoutMs: REPLY_TIMEOUT_MS });
  // 위젯·텔레그램과 같은 서버측 방어 — 모델이 «자신 없다»(escalate) 며 낸 질문 답변은 우리 대기 문구로.
  // GROUNDING_REMINDER 는 «일부러» 안 붙인다: 카카오는 4초 예산이라 입력이 느는 쪽이 더 위험하고,
  // 규칙은 시스템 프롬프트(「답변 규칙」 섹션)에 이미 있다.
  const result: LlmResult = raw
    ? applyHoldingPolicy(extractResult(raw), botId, visitorTextLocale(utterance, 'ko'))
    : { response: FALLBACK_TEXT, insight: null };

  const replyText = result.response || FALLBACK_TEXT;
  await saveResponse(botId, messageId, 'kakao', replyText, conversationId);
  if (result.parsed === true) {
    // 인사이트는 답장의 «덤»이다 — 답장은 위에서 이미 저장됐다. 여기서 throw 가 새면 processUtterance 가
    // 거부되고 바깥 catch 가 「요청을 처리하지 못했습니다」를 내보내, 방문자는 만들어 둔 답을 못 받는다(I-28).
    // 저장 실패는 로그로 남기고 답장은 그대로 내보낸다. messageId 가 null 인 경로는 위에서 이미 끊었다.
    const receipt = await saveInsight(botId, messageId, result.insight, result.escalate === true).catch((err) => {
      console.error(`[kakao/${botId}] insight save failed:`, err);
      return null;
    });
    // I-10 — 인사이트가 생겼으면 자동 묶기. 90초 대기라 4초 예산 밖(after)에서.
    if (shouldScheduleAutoGrouping({ insightId: receipt?.id ?? null, category: result.insight?.category ?? null, source: 'kakao' })) {
      after(scheduleAutoGrouping(botId).catch((err) => console.error(`[kakao/${botId}] auto grouping failed:`, err)));
    }
  }

  // 위젯과 같은 규칙으로 「담당자 확인 필요」을 찍는다. 카카오는 폴백 문구라도 나가지만
  // 그건 답이 아니라 접수 확인이다 — 사람이 이어받아야 한다는 사실은 달라지지 않는다.
  //
  // ⚠️ `raw === null`(LLM 호출 실패)은 needsEscalation 만으로 못 잡는다. 위 폴백이
  //    response 를 FALLBACK_TEXT 로 채워버려 "답이 있는 것"처럼 보이기 때문이다.
  //    위젯은 같은 경우에 response 를 null 로 두므로 이 예외가 필요 없다.
  // 4초 경주 경로에서 DB 쓰기를 빼낸다 — 응답을 늦출 이유가 없다.
  if (conversationId && (raw === null || needsEscalation(result))) {
    after(markConversationEscalated(conversationId));
  }

  return replyText;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;

  // env 를 «핸들러 안»에서 읽는다. 모듈 로드 시점에 잡으면 값을 바꿔도 재배포 전까지
  // 안 먹는다(이 레포에서 crypto.ts 가 같은 함정에 빠진 적이 있다).
  // 403 이 아니라 404 다 — 닫힌 문이 어디 있는지까지 알려줄 이유가 없다.
  if (process.env.KAKAO_WEBHOOK_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const payload: KakaoSkillPayload = await req.json();

    // 연결 테스트는 LLM 을 타지 않고 즉답한다.
    // 콜드스타트(실측 3.5초) 상태에서도 5초 제한 안에 성공 응답이 나가야
    // 고객이 연결 직후 보는 첫 화면이 폴백 문구가 아니게 된다.
    if (isOpenBuilderTest(payload)) {
      await markBotConnected(botId);
      return kakaoSimpleText(CONNECTED_TEXT);
    }

    const utterance = payload.userRequest?.utterance?.trim();
    const userId = payload.userRequest?.user?.id;

    if (!utterance || !userId) {
      return kakaoSimpleText('메시지를 확인하지 못했어요. 다시 보내주시겠어요?');
    }

    // 받은편지함이 웹 위젯과 카카오를 한 화면에서 보려면 카카오도 대화에 묶여야 한다.
    // 대기열을 LLM 과 병렬로 조회하려면 대화를 먼저 열어야 해서 여기서 연다.
    const conversation = await upsertConversation({
      botId,
      source: 'kakao',
      externalUserId: userId,
    });
    const conversationId = conversation?.id ?? null;

    const processing = processUtterance(botId, userId, utterance, conversationId);
    // 5초 안에 못 끝나 폴백으로 응답해도 분류·저장은 끝까지 완료 (Vercel에서 응답 후 종료 방지)
    after(processing.catch((err) => console.error(`[kakao/${botId}] after error:`, err)));
    // 실유저 요청도 연결 신호다. 응답 지연이 없도록 응답 후에 기록한다.
    after(markBotConnected(botId));

    // 일일 사용량 «계측만» 한다. **차단은 안 한다** — 이유 둘:
    //  1) 카카오는 4초 예산이다. bump RPC 왕복 하나가 폴백 문구를 부를 수 있다
    //  2) 오픈빌더 1:1 채널이라 익명 스크립트가 때릴 수 있는 위젯 POST 와 노출 성격이 다르다
    // 그래도 같은 지갑에서 나가는 호출이라 «세기는» 한다. 응답 후에 돌므로 지연이 없고,
    // 결과와 무관하게 이번 응답은 그대로 나간다.
    //
    // 세는 칸이 위젯과 «다르다»(kakao_call_attempts). 같은 칸이면 차단당하지 않는
    // 카카오 트래픽이 차단당하는 위젯의 상한을 잠식해, 위젯이 아무 잘못 없이 조용히 막힌다.
    after(bumpKakaoUsage(botId));

    const timeout = new Promise<string>((resolve) =>
      setTimeout(() => resolve('응답이 지연되고 있어요. 잠시 후 다시 확인해주세요.'), REPLY_TIMEOUT_MS),
    );

    // 루프를 닫는 지점 — 선톡이 안 되니 유저가 말을 건 이 순간에 밀린 것을 얹는다.
    // LLM 응답과 병렬로 조회해 지연을 더하지 않는다.
    const [text, queued] = await Promise.all([
      Promise.race([processing, timeout]),
      lookupQueued(conversationId),
    ]);

    if (queued.length === 0) return kakaoSimpleText(text);

    // 실제로 내보내는 게 확정된 뒤에만 전달 처리한다.
    after(markResponsesDelivered(queued.map((q) => q.id)));
    return kakaoTexts([...queued.map((q) => q.body), text]);
  } catch (err) {
    console.error(`[kakao/${botId}] Error:`, err);
    return kakaoSimpleText('요청을 처리하지 못했습니다. 잠시 후 다시 보내주세요.');
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ botId: string }> },
) {
  const { botId } = await params;
  // 온보딩 페이지가 웹훅을 미리 깨우는(warm-up) 데에도 쓴다.
  // POST 와 달리 게이트를 두지 않는다 — 받은 값을 돌려줄 뿐 DB·LLM 을 건드리지 않는다.
  return NextResponse.json({ status: 'ok', channel: 'kakao', botId });
}

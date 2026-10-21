// i18n 5단계 프롬프트 smoke — 영어로 다시 쓴 프롬프트가 실제 모델에서 «출력 언어 규칙»대로 도는지 본다.
// 실행: npx tsx scripts/i18n-prompt-smoke.ts
//
// DB 에는 아무것도 쓰지 않는다. 프롬프트 조립 함수와 LLM 호출 함수(callLlm·proposeGroups·judgeGroupImpact)만
// 직접 부른다. 봇 설정은 여기서 만든 가짜(운영자 키 없음)라 플랫폼 기본 모델(PLATFORM_LLM_PROVIDER 의 추천 모델)로
// 나가고, 실패해도 `llm_key_failed_at` 을 쓰지 않는다(운영자 키가 아닐 때는 기록하지 않는다 — handler.ts).
// 안전장치로 Supabase 키를 프로세스 env 에서 지운다 — 어딘가 DB 를 부르면 쓰기 전에 실패한다.
//
// 확인하는 것:
//   위젯 답변   영어 질문(locale en) → 영어 답, 한국어 질문(locale ko) → 한국어 답, 지식에 없는 질문 → hold=true
//   분류        한국어 3 + 영어 3 → category 가 열거값, summary 는 영어(OWNER_CONTENT_LOCALE)
//   묶기·영향   한국어 피드백 묶음 → 영어 title·summary·impact reason
//   PR 프롬프트 비싸고 GitHub 이 필요해 호출하지 않는다. 조립 결과의 지시문이 영어인지만 본다.

import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.POSTGRES_URL_NON_POOLING;

type Lang = 'en' | 'ko' | 'mixed' | 'none';

/** 글자 비율로 언어를 판정한다. 한글이 글자의 90% 이상이면 ko, 10% 미만이면 en, 그 사이는 mixed. */
function langOf(text: string | null | undefined): Lang {
  const t = text ?? '';
  const hangul = (t.match(/[가-힣]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (hangul + latin === 0) return 'none';
  const ratio = hangul / (hangul + latin);
  if (ratio >= 0.9) return 'ko';
  if (ratio < 0.1) return 'en';
  return 'mixed';
}

interface Row {
  kase: string;
  input: string;
  output: string;
  lang: string;
  json: string;
  ok: boolean;
}

const rows: Row[] = [];
const cut = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

async function main() {
  const { callLlm, extractResult } = await import('../src/lib/bot/handler');
  const { getSystemPrompt } = await import('../src/lib/bot/prompts');
  const { GROUNDING_REMINDER, applyHoldingPolicy, ensureEscalationInsight } = await import('../src/lib/bot/holding');
  const { buildWidgetUserTurn } = await import('../src/lib/bot/reply-context');
  const { prepareRecoveryCase, parseRecoveryResult } = await import('../src/lib/classify/recovery');
  const { CATEGORIES } = await import('../src/lib/classify/taxonomy');
  const { proposeGroups } = await import('../src/lib/groups/grouping');
  const { judgeGroupImpact } = await import('../src/lib/groups/priority');
  const { buildPatchPrompt, buildSelectionPrompt } = await import('../src/lib/auto-dev/ai-engine');
  const { buildSpecPrompt } = await import('../src/lib/groups/spec');
  const { renderKnowledge } = await import('../src/lib/bot/knowledge');
  type BotConfig = import('../src/lib/bot/handler').BotConfig;

  const knowledge = renderKnowledge(
    'Wander Korea is a slow-travel booking site for Seoul neighborhoods. Tours can be cancelled for a full refund up to 3 days before the start date.',
    [
      { q: 'How many coupons can I get per day?', a: 'One coupon per store per day.' },
      { q: '쿠폰은 하루에 몇 장 받을 수 있나요?', a: '같은 가게에서 하루 한 장이에요.' },
    ],
  );
  const config: BotConfig = {
    botId: 'i18n-smoke',
    mentionPatterns: [],
    feedbackKeywords: { negative: [], positive: [], question: [] },
    serviceProfile: {
      botName: 'Wander Korea',
      botTone: 'Friendly and casual. A few emoji are fine.',
      serviceName: 'Wander Korea',
      serviceUrl: 'https://wanderkorea.example',
      serviceDescription: 'Slow-travel tour booking for Seoul neighborhoods',
      serviceCompany: '',
      targetUsers: 'beta testers',
      serviceFeatures: [],
      loginMethod: '',
      faq: [],
      knowledge,
    },
    dailyReplyLimit: null,
    llmApiKeyEncrypted: null,
    llmProvider: null,
    llmModel: null,
    llmKeyFailedAt: null,
  };

  // ── 1. 위젯 답변 ───────────────────────────────────────────────
  const replyCases: { text: string; locale: 'en' | 'ko'; expectHold: boolean }[] = [
    { text: 'How many coupons can I get per day?', locale: 'en', expectHold: false },
    { text: 'Can I cancel my tour and get a refund?', locale: 'en', expectHold: false },
    { text: '쿠폰은 하루에 몇 장 받을 수 있어요?', locale: 'ko', expectHold: false },
    { text: '투어 취소하면 환불 되나요?', locale: 'ko', expectHold: false },
    { text: 'Is there free parking near the meeting point?', locale: 'en', expectHold: true },
  ];
  for (const c of replyCases) {
    const userTurn = buildWidgetUserTurn({ recent: '', extendable: '', text: c.text, hintLine: '', reminder: GROUNDING_REMINDER });
    const raw = await callLlm(config, getSystemPrompt(config.serviceProfile, { replyLocale: c.locale }), userTurn, { timeoutMs: 60_000 });
    if (!raw) {
      rows.push({ kase: `reply ${c.locale}`, input: cut(c.text, 40), output: '(no model output)', lang: '-', json: 'no', ok: false });
      continue;
    }
    const result = extractResult(raw);
    const modelHold = result.hold === true;
    ensureEscalationInsight(result, c.text);
    applyHoldingPolicy(result, config.botId, c.locale);
    const lang = langOf(result.response);
    const summaryLang = result.insight ? langOf(result.insight.summary) : 'none';
    const ok =
      result.parsed === true &&
      modelHold === c.expectHold &&
      lang === c.locale &&
      // 모델이 쓴 summary 는 영어(서버가 방문자 원문을 넣은 I-20 흔적은 예외 — 모델이 안 쓴 값이다)
      (!result.insight || modelHold || summaryLang === 'en' || summaryLang === 'none');
    rows.push({
      kase: c.expectHold ? `reply hold ${c.locale}` : `reply ${c.locale}`,
      input: cut(c.text, 40),
      output: `${modelHold ? '[hold] ' : ''}${cut(result.response ?? '(null)', 50)} | summary(${summaryLang}): ${cut(result.insight?.summary ?? '-', 40)}`,
      lang: `${lang} (want ${c.locale})`,
      json: result.parsed ? 'yes' : 'no',
      ok,
    });
  }

  // ── 2. 분류 (운영 경로: 회수 분류 = 즉답과 같은 프롬프트) ─────────────────
  const classifyCases: { text: string; want: string }[] = [
    { text: '쿠폰함 지난내역 탭 누르면 하얀 화면만 떠요', want: 'bug' },
    { text: '예약 내역을 캘린더로 내보내는 기능이 있으면 좋겠어요', want: 'feature_request' },
    { text: '지도 화면에서 내 위치 버튼이 어디 있는지 한참 찾았어요. 잘 안 보여요', want: 'ux' },
    { text: 'The checkout page crashes when I apply a coupon code', want: 'bug' },
    { text: 'Can I book a tour for a group of 10 people?', want: 'cs' },
    { text: 'Love the new neighborhood guides, they are great!', want: 'praise' },
  ];
  for (const c of classifyCases) {
    const prepared = prepareRecoveryCase({
      profile: config.serviceProfile,
      timeline: [],
      refMap: new Map(),
      messageId: 'm1',
      text: c.text,
      context: null,
      widget_hint: null,
    });
    const raw = await callLlm(config, prepared.system, prepared.user, { timeoutMs: 60_000, recordKeyFailure: false });
    if (!raw) {
      rows.push({ kase: 'classify', input: cut(c.text, 40), output: '(no model output)', lang: '-', json: 'no', ok: false });
      continue;
    }
    const { parsed } = parseRecoveryResult(raw, new Map(), c.text);
    const cat = parsed.insight?.category ?? '(none)';
    const summary = parsed.insight?.summary ?? '';
    const enumOk = (CATEGORIES as readonly string[]).includes(cat);
    const lang = langOf(summary);
    rows.push({
      kase: `classify ${langOf(c.text)}`,
      input: cut(c.text, 40),
      output: `${cat}${cat === c.want ? '' : ` (expected ${c.want})`} | ${cut(summary, 50)}`,
      lang: `${lang} (want en)`,
      json: parsed.parsed ? 'yes' : 'no',
      // 카테고리 «정답»은 정보로만 싣는다 — 이 smoke 가 보는 것은 열거값·언어·파싱이다
      ok: parsed.parsed === true && enumOk && lang === 'en',
    });
  }

  // ── 3. 묶기 제목·요약 + 영향 이유 (한국어 피드백 묶음) ─────────────────
  const insights = [
    { id: 'ins-1', category: 'bug', summary: '결제 화면에서 쿠폰 적용 버튼을 눌러도 반응이 없음' },
    { id: 'ins-2', category: 'bug', summary: '쿠폰 적용하기 누르면 아무 일도 안 일어나요 (아이폰 사파리)' },
    { id: 'ins-3', category: 'bug', summary: 'PC 크롬에서 결제할 때 쿠폰 버튼이 안 눌려서 결제를 못 했어요' },
  ];
  try {
    const groups = await proposeGroups(config, insights, [], Date.now() + 90_000);
    for (const g of groups) {
      const tl = langOf(g.title);
      const sl = langOf(g.summary);
      rows.push({
        kase: 'group title/summary',
        input: `${insights.length} Korean reports`,
        output: `${cut(g.title, 45)} | ${cut(g.summary, 40)}`,
        lang: `${tl}/${sl} (want en)`,
        json: 'yes',
        ok: tl === 'en' && sl === 'en' && Array.isArray(g.insight_ids),
      });
    }
    const first = groups[0];
    if (first) {
      const impact = await judgeGroupImpact(
        config,
        [{ id: 'g1', title: first.title, summary: first.summary, insights: insights.map((i) => ({ summary: i.summary })) }],
        Date.now() + 60_000,
      );
      for (const r of impact) {
        const l = langOf(r.reason);
        rows.push({
          kase: 'impact reason',
          input: cut(first.title, 40),
          output: `core=${r.core} | ${cut(r.reason, 50)}`,
          lang: `${l} (want en)`,
          json: 'yes',
          ok: l === 'en',
        });
      }
    }
  } catch (err) {
    rows.push({ kase: 'group/impact', input: 'Korean reports', output: cut(err instanceof Error ? err.message : String(err), 80), lang: '-', json: 'no', ok: false });
  }

  // ── 4. PR·스펙 프롬프트 — 호출하지 않고 조립 결과만 본다 ────────────────
  const insight = { category: 'bug', summary: 'Coupon apply button does nothing at checkout', message_body: '결제 화면에서 쿠폰 적용 버튼이 안 눌려요', context: '- Page: https://x.app/checkout' };
  const sources = [{ path: 'app/checkout/page.tsx', content: 'export default function Page() { return null }' }];
  const prompts: [string, string][] = [
    ['PR selection prompt', buildSelectionPrompt(insight, { owner: 'o', repo: 'r', sourcePaths: ['app/checkout/page.tsx'], truncated: false })],
    ['PR patch prompt', buildPatchPrompt(insight, sources, undefined, [], { sourcePaths: ['app/checkout/page.tsx'], truncated: false })],
    ['spec prompt', buildSpecPrompt({ title: 'Export bookings to calendar', summary: 'Users want calendar export' }, ['예약을 캘린더로 내보내고 싶어요'])],
  ];
  for (const [name, p] of prompts) {
    // 피드백 원문(한국어 입력)을 뺀 지시문만 본다
    const instructions = p.replace(insight.message_body, '').replace('예약을 캘린더로 내보내고 싶어요', '');
    const l = langOf(instructions);
    const asksEnglish = /in English/.test(p);
    rows.push({
      kase: name,
      input: '(assembled only, not sent)',
      output: `${p.length} chars · ${asksEnglish ? 'says "in English"' : 'no output-language line'}`,
      lang: `${l} (want en)`,
      json: '-',
      ok: l === 'en' && (name === 'PR selection prompt' || asksEnglish),
    });
  }

  // ── 표 ─────────────────────────────────────────────────────────
  const head = ['case', 'input', 'output', 'language', 'JSON', 'result'];
  const body = rows.map((r) => [r.kase, r.input, r.output, r.lang, r.json, r.ok ? 'PASS' : 'FAIL']);
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const b of body) console.log(`| ${b.map(esc).join(' | ')} |`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

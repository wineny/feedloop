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
//   회귀 비율  케이스마다 RUNS 번(기본 4, SMOKE_RUNS 로 조정) 돌려 비율로 본다(5d 에서 추가):
//              감사·인사·맞장구에 response=null 이 안 나오는지(ko/en, 카카오 경로·위젯 경로),
//              extends·Known issues ref 가 맞는 항목을 가리키는지(대괄호째 적어도 normalizeRef 가 벗기는지),
//              언어 미지정 카카오 경로의 hold 판단, 한국어·영어가 섞인 묶기.

import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.POSTGRES_URL_NON_POOLING;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 비율 케이스(5번 절)를 몇 번씩 돌리나. 모델 출력이 흔들리므로 한 번으로는 회귀를 못 본다. */
const RUNS = Number(process.env.SMOKE_RUNS ?? 4);

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

  // ── 5. 회귀 비율 — 같은 입력을 RUNS 번 돌려 센다 ─────────────────────
  const { buildInsightRefMap, formatExtendableSection } = await import('../src/lib/bot/reply-context');
  const { buildGroupRefMap, formatKnownIssuesSection } = await import('../src/lib/groups/existing-match');
  const { normalizeRef } = await import('../src/lib/classify/ref');
  const { visitorTextLocale } = await import('../src/lib/bot/holding');

  interface RateRow { kase: string; input: string; metric: string; hits: number; runs: number; ok: boolean; note: string }
  const rateRows: RateRow[] = [];
  const call = async (system: string, user: string) => {
    const raw = await callLlm(config, system, user, { timeoutMs: 60_000, recordKeyFailure: false });
    return raw ? extractResult(raw) : null;
  };

  // 5a. 감사·인사·맞장구 — 카카오 경로(대화 언어 없음, 유저 턴 = `Visitor: …`, 상기 문구 없음).
  //     response=null 이면 서버는 대기 안내를 보내고 사람에게 넘긴다(kakao webhook FALLBACK_TEXT).
  const courtesy = ['감사합니다!', 'ok 감사합니다', '네 알겠어요', '안녕하세요', 'Thanks!', 'ok got it', 'hi there'];
  for (const t of courtesy) {
    let nulls = 0;
    let holds = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await call(getSystemPrompt(config.serviceProfile), `Visitor: ${t}`);
      if (!r || r.response === null) nulls++;
      if (r?.hold) holds++;
    }
    rateRows.push({ kase: 'courtesy kakao', input: t, metric: 'response null', hits: nulls, runs: RUNS, ok: nulls === 0 && holds === 0, note: holds ? `hold ${holds}` : '' });
  }

  // 위젯 경로: 제보 → 꼬리질문 뒤의 감사. 「이 대화의 기존 제보」 목록과 상기 문구가 붙는다.
  const coupon = { id: '33333333-aaaa-4bbb-8ccc-000000000009', category: 'bug', summary: 'White screen when opening the coupon box', source_message_ids: ['m0'] };
  const extRefMap = buildInsightRefMap([coupon]);
  const extendable = formatExtendableSection(extRefMap);
  const wantExt = [...extRefMap.keys()][0];
  const recentByLocale = {
    ko: 'Visitor: 쿠폰함 들어가면 흰 화면이에요\nWander Korea: 앗 불편하셨겠어요! 어떤 기기에서 그러셨어요?',
    en: 'Visitor: The coupon box shows a white screen\nWander Korea: Oh no, sorry about that! Which device were you on?',
  } as const;
  for (const [t, locale] of [['감사합니다!', 'ko'], ['Thanks!', 'en']] as const) {
    let nulls = 0;
    for (let i = 0; i < RUNS; i++) {
      const u = buildWidgetUserTurn({ recent: recentByLocale[locale], extendable, text: t, hintLine: '', reminder: GROUNDING_REMINDER });
      const r = await call(getSystemPrompt(config.serviceProfile, { replyLocale: locale }), u);
      if (!r || r.response === null) nulls++;
    }
    rateRows.push({ kase: `courtesy widget ${locale}`, input: t, metric: 'response null', hits: nulls, runs: RUNS, ok: nulls === 0, note: '' });
  }

  // 5b. extends — 꼬리질문에 대한 답은 앞 제보에 합쳐져야 한다. 대괄호째 적어도 normalizeRef 가 벗긴다.
  for (const [t, locale] of [['아이폰 사파리요', 'ko'], ['iPhone, Safari', 'en']] as const) {
    let match = 0;
    let bracketed = 0;
    for (let i = 0; i < RUNS; i++) {
      const u = buildWidgetUserTurn({ recent: recentByLocale[locale], extendable, text: t, hintLine: '', reminder: GROUNDING_REMINDER });
      const r = await call(getSystemPrompt(config.serviceProfile, { replyLocale: locale }), u);
      if (r?.extends && /[[\]]/.test(r.extends)) bracketed++;
      if (normalizeRef(r?.extends) === wantExt) match++;
    }
    rateRows.push({ kase: `extends ${locale}`, input: t, metric: 'ref resolves', hits: match, runs: RUNS, ok: match === RUNS, note: `raw bracketed ${bracketed}` });
  }

  // 5c. Known issues — 묶음 제목이 한국어·영어로 섞인 목록. 방문자 말과 제목 언어가 달라도 같은 문제면 그 ref.
  const KO_COUPON = { id: '11111111-aaaa-4bbb-8ccc-000000000001', title: '결제 화면에서 쿠폰 적용 버튼이 눌리지 않음', summary: '', category: 'bug', status: 'open', prNumber: null, prUrl: null };
  const KO_MAP = { id: '11111111-aaaa-4bbb-8ccc-000000000002', title: '지도 화면 내 위치 버튼을 찾기 어려움', summary: '', category: 'ux', status: 'pr_created', prNumber: 7, prUrl: null };
  const EN_BLANK = { id: '22222222-aaaa-4bbb-8ccc-000000000003', title: 'Tour detail page shows a blank screen', summary: '', category: 'bug', status: 'open', prNumber: null, prUrl: null };
  const groupRefMap = buildGroupRefMap([KO_COUPON, KO_MAP, EN_BLANK]);
  const knownIssues = formatKnownIssuesSection(groupRefMap);
  const knownCases: { text: string; locale: 'en' | 'ko'; want: string | null }[] = [
    { text: '투어 상세 들어가면 흰 화면이에요', locale: 'ko', want: EN_BLANK.id },
    { text: '결제할 때 쿠폰 적용 버튼이 안 눌려요', locale: 'ko', want: KO_COUPON.id },
    { text: "When I check out, tapping the apply-coupon button doesn't do anything", locale: 'en', want: KO_COUPON.id },
    { text: "I can't find the my-location button on the map", locale: 'en', want: KO_MAP.id },
    { text: 'The search filter resets every time I go back', locale: 'en', want: null },
  ];
  for (const c of knownCases) {
    let match = 0;
    let bracketed = 0;
    for (let i = 0; i < RUNS; i++) {
      const u = buildWidgetUserTurn({ recent: '', extendable: '', knownIssues, text: c.text, hintLine: '', reminder: GROUNDING_REMINDER });
      const r = await call(getSystemPrompt(config.serviceProfile, { replyLocale: c.locale }), u);
      const got = r?.matchesExistingGroup ?? null;
      if (got && /[[\]]/.test(got)) bracketed++;
      const resolved = groupRefMap.get(normalizeRef(got))?.id ?? null;
      if (resolved === c.want) match++;
    }
    rateRows.push({ kase: `known ${c.locale}`, input: cut(c.text, 40), metric: c.want ? 'ref resolves' : 'stays null', hits: match, runs: RUNS, ok: match === RUNS, note: `raw bracketed ${bracketed}` });
  }

  // 5d. 언어 미지정 카카오 경로 — 사실 질문(지식 없음)은 hold, 피드백은 답, 답 언어는 방문자 말을 따른다.
  const kakaoCases: { text: string; hold: boolean }[] = [
    { text: '주차장 있나요?', hold: true },
    { text: 'Is there parking at the meeting point?', hold: true },
    { text: '예약하기 버튼 눌렀는데 아무 반응이 없어요', hold: false },
  ];
  for (const c of kakaoCases) {
    let good = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await call(getSystemPrompt(config.serviceProfile), `Visitor: ${c.text}`);
      if (!r) continue;
      const replyOk = c.hold || (r.response !== null && langOf(r.response) === visitorTextLocale(c.text));
      if ((r.hold === true) === c.hold && replyOk) good++;
    }
    rateRows.push({ kase: 'kakao no locale', input: cut(c.text, 40), metric: c.hold ? 'hold' : 'reply in visitor language', hits: good, runs: RUNS, ok: good === RUNS, note: '' });
  }

  // 5e. 섞인 언어 묶기 — 한국어 기존 묶음 + 영어 새 제보, 영어 기존 묶음 + 한국어 새 제보.
  const mixedRuns = Math.min(RUNS, 3);
  let mixedGood = 0;
  const mixedNotes: string[] = [];
  for (let i = 0; i < mixedRuns; i++) {
    const fresh = [
      { id: 'n-en-1', category: 'bug', summary: 'Coupon apply button does nothing on the checkout screen' },
      { id: 'n-en-2', category: 'bug', summary: 'Reviews tab freezes when scrolling on Android' },
      { id: 'n-ko-3', category: 'bug', summary: '투어 상세 페이지 열면 하얀 화면만 나와요' },
    ];
    try {
      const gs = await proposeGroups(config, fresh, [KO_COUPON, KO_MAP, EN_BLANK], Date.now() + 90_000);
      const where = (id: string) => {
        const g = gs.find((x) => x.insight_ids?.includes(id));
        return g ? (g.existing_group_id ?? 'NEW') : 'MISSING';
      };
      const ok = where('n-en-1') === KO_COUPON.id && where('n-en-2') === 'NEW' && where('n-ko-3') === EN_BLANK.id;
      if (ok) mixedGood++;
      else mixedNotes.push(`run${i}: en→ko ${where('n-en-1').slice(0, 8)}, unrelated ${where('n-en-2').slice(0, 8)}, ko→en ${where('n-ko-3').slice(0, 8)}`);
    } catch (err) {
      mixedNotes.push(`run${i}: ${cut(err instanceof Error ? err.message : String(err), 40)}`);
    }
  }
  rateRows.push({ kase: 'mixed grouping', input: '3 new (en/en/ko) vs ko/ko/en groups', metric: 'all three placed right', hits: mixedGood, runs: mixedRuns, ok: mixedGood === mixedRuns, note: mixedNotes.join('; ') });

  // ── 표 ─────────────────────────────────────────────────────────
  const head = ['case', 'input', 'output', 'language', 'JSON', 'result'];
  const body = rows.map((r) => [r.kase, r.input, r.output, r.lang, r.json, r.ok ? 'PASS' : 'FAIL']);
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const b of body) console.log(`| ${b.map(esc).join(' | ')} |`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);

  const rateHead = ['case', 'input', 'metric', 'count', 'note', 'result'];
  console.log(`\n| ${rateHead.join(' | ')} |`);
  console.log(`|${rateHead.map(() => '---').join('|')}|`);
  for (const r of rateRows) {
    console.log(`| ${[r.kase, r.input, r.metric, `${r.hits}/${r.runs}`, r.note, r.ok ? 'PASS' : 'FAIL'].map(esc).join(' | ')} |`);
  }
  const rateFailed = rateRows.filter((r) => !r.ok).length;
  console.log(`\n${rateRows.length - rateFailed}/${rateRows.length} rate cases passed (${RUNS} runs each)`);
  if (failed > 0 || rateFailed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

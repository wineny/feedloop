// 답변 품질 회귀 — 「지식에 없는 것을 물으면 사람에게 넘기는가」를 잰다. DB 에 쓰지 않는다.
//
// 왜 이걸 재나 — 분류만 재고 답변을 안 재면, 분류 기준 블록을 시스템 프롬프트에 넣은 변경이
// **답변 쪽을 망가뜨렸는지 알 수 없다.** 같은 프롬프트가 두 일을 동시에 한다.
// 2026-09-10 에 같은 실험을 했고(지식 밖 3종 × 3회), 그때 gemini-2.5-flash 가 9/9 였다.
// 그 뒤로 프롬프트가 두 번 바뀌었다 — 분류 기준 블록(`6c234bc`)과 CS 중복 정리(`6040dea`).
//
// 위젯과 **완전히 같은 호출 모양**을 쓴다(`api/widget/[botId]/messages/route.ts:123`) —
// `getSystemPrompt(config.serviceProfile)` + `사용자: <텍스트>`. 유저 턴에 분류·escalate
// 지시가 따로 없다는 점까지 같아야 이 실험이 뜻을 갖는다.
//
// ⚠️ 완전한 write-free 는 아니다 — callLlm 의 «성공» 경로가 `llm_key_failed_at` 을 지운다(handler.ts).
//    「키 확인 필요」 배지가 켜진 봇을 재면 배지가 꺼진다(실제 성공 호출과 같은 효과).
//
//   npx tsx scripts/measure-escalate.ts --env .env.local --bot <bot_id> --runs 3
//     [--model gemini-2.5-flash]   키 없는 봇의 플랫폼 폴백 모델을 덮어쓴다(PLATFORM_LLM_MODEL)
//     [--provider anthropic]       플랫폼 폴백 provider 를 덮어쓴다(PLATFORM_LLM_PROVIDER). 그 provider 의 플랫폼 키가 .env.local 에 있어야 한다
//     [--as-platform]              운영자 키가 있는 봇이라도 키를 «무시»하고 플랫폼 경로로 잰다 — 지식이 실린 봇을 폴백 모델로 재보기 위해서(DB 무변경)
//     [--set nullnul|generic|feedloop]  질문 세트. generic = 지식 0 봇용 · feedloop·feedloop2 = 자기 위젯(8f0c0182)용 · v2 는 확장 지식 기준
//     [--reminder on|off]          위젯 유저 턴의 GROUNDING_REMINDER 를 붙일지(기본 on = 운영과 같음)
//
// I-08(2026-09-12) 이후 판정은 두 겹이다 — escalate 플래그 «그리고» 응답 텍스트가 대기 문구인가.
// 지식 0 봇의 사실 질문은 둘 다 참이어야 「지어내지 않았다」로 친다. 피드백 대조군은
// 대기 문구가 «나오면 안 된다»(모든 말에 담당자 확인만 하는 회귀를 잡는다).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
loadEnv(resolve(process.cwd(), flag('env') ?? '.env.local'));

const BOT_ID = flag('bot');
const RUNS = Number(flag('runs') ?? 3);
const SET = flag('set') ?? 'nullnul';
const REMINDER = (flag('reminder') ?? 'on') !== 'off';
const MODEL = flag('model');
const PROVIDER = flag('provider');
const AS_PLATFORM = args.includes('--as-platform');
// dynamic import «전»에 세운다 — provider.ts 는 호출 시점에 env 를 읽지만, 순서를 지켜 두면 나중에 누가
// 모듈 로드 시점 읽기로 바꿔도 이 스크립트가 조용히 옛 값을 재지 않는다.
if (MODEL) process.env.PLATFORM_LLM_MODEL = MODEL;
if (PROVIDER) process.env.PLATFORM_LLM_PROVIDER = PROVIDER;

/** 위젯 예산과 같게 둔다. 여기서 늘리면 운영에서 안 나오는 답까지 세게 된다. */
const WIDGET_TIMEOUT_MS = 10_000;

/** 지식에 없는 것. 기대 동작 = 지어내지 않고 «팀에 확인» + escalate. */
const OUTSIDE = [
  '널널카페 종로점 영업시간이 어떻게 되나요?',
  '쿠폰 쓰는 가게들 디카페인 되나요?',
  '가게에 주차 되나요?',
];

/** 지식에 있는 것. 기대 동작 = 그 자리에서 답하고 escalate 하지 않음(대조군). */
const INSIDE = [
  '쿠폰은 하루 몇 장까지 받나요?',
  '쿠폰은 어떻게 쓰나요?',
  '혼잡도가 실시간인가요?',
];

/**
 * 피드루프 자기 위젯(`8f0c0182`)용. **심사위원이 만질 수 있는 유일한 위젯**이라 따로 잰다.
 * 질문은 봇의 실제 `knowledge_text`·`knowledge_faq`(2026-09-18 기준)에서 뽑았다.
 *
 * INSIDE 는 FAQ 에 «토씨까지 그대로» 있는 것과 «말을 바꾼 것»을 섞었다 — 바꾼 쪽이 먼저 무너진다.
 * 2026-09-16 운영 실측: 「수정 PR은 누가 승인하나요?」(FAQ 3번 원문·시작 칩)가 2번 중 1번 대기 문구로 물러났다.
 */
/**
 * 확장 지식(2026-09-18 v2) 기준 세트. v1 8문항으로는 «늘어난 지식이 대기 규칙을 무너뜨렸는지»가
 * 안 보인다 — 지식이 커지면 모델이 「모르면 담당자 확인」을 자주 놓친다(models.ts 주석).
 * 그래서 INSIDE 를 넓히는 만큼 OUTSIDE 도 «여전히 모르는 것»으로 같이 넓힌다.
 */
const FEEDLOOP2_INSIDE = [
  '수정안은 누가 승인하나요?',
  '깃허브 권한은 어디까지 가져가나요?',
  '제 코드를 AI가 마음대로 바꾸나요?',
  '카카오톡으로도 받을 수 있어요?',
  '채널톡이랑 붙일 수 있나요?',
  '랜딩에 있는 데모는 진짜 서비스인가요?',
  '팀원이랑 같이 볼 수 있나요?',
  '영어로 물어보는 유저도 답변되나요?',
  '남긴 이메일은 어디에 쓰나요?',
  '상담원 연결을 누르면 어떻게 되나요?',
  '피드백이 쌓이면 자동으로 묶이나요?',
  '설치하는 데 정말 5분이면 되나요?',
];

/** 확장 뒤에도 «여전히» 모르는 것. 지어내면 ✗. 여기가 무너지면 지식을 너무 넓게 쓴 것이다. */
const FEEDLOOP2_OUTSIDE = [
  '어떤 AI 모델을 쓰나요? 버전까지 알려주세요',
  '하루에 몇 건까지 무료인가요?',
  '고객센터 전화번호가 어떻게 되나요?',
  '언제부터 유료로 바뀌나요?',
  '가동률을 몇 퍼센트 보장하나요?',
  '피드백 데이터는 몇 년 보관하나요?',
];

const FEEDLOOP_INSIDE = [
  '설치하는 데 정말 5분이면 되나요?',
  '수정 PR은 누가 승인하나요?',
  '무료로 어디까지 쓸 수 있나요?',
  '깃허브 연결 안 하면 못 쓰나요?',
  '카톡으로도 피드백 받을 수 있어요?',
  '고쳐지면 저한테 알려주나요?',
  '이거 누가 만들었어요?',
  '피드루프가 뭐 하는 서비스예요?',
];

/** 피드루프 지식 «밖». 근거가 없으니 대기 문구 + escalate 가 정답. 지어내면 ✗. */
const FEEDLOOP_OUTSIDE = [
  '하루 100건을 넘기면 어떻게 되나요?',
  '남긴 피드백 데이터는 어디에 저장되고 얼마나 보관하나요?',
  '팀원 여러 명이 같이 볼 수 있나요?',
  '슬랙이랑 연동돼요?',
  '영어 쓰는 유저도 답변 받을 수 있나요?',
];

/** 피드루프 대조군 — 피드백. 대기 문구가 나오면 「모든 말에 담당자 확인」 회귀다. */
const FEEDLOOP_FEEDBACK = [
  '위젯 닫기 버튼이 모바일에서 잘 안 눌려요',
  '대시보드에 검색 기능이 있으면 좋겠어요',
  '설치 안내가 깔끔해서 좋네요',
];

/** 지식 0 봇용 — 어느 서비스든 물어볼 법한 사실 질문. 근거가 없으니 전부 대기 문구 + escalate 가 정답. */
const GENERIC_FACT = [
  '쿠폰은 하루에 몇 장까지 받을 수 있나요?',
  '환불은 며칠 안에 해야 하나요?',
  '유료 요금제 가격이 얼마예요?',
  '고객센터 전화번호가 뭐예요?',
  '결제 수단에 카카오페이도 되나요?',
];

/** 지식 0 봇용 대조군 — 피드백. 대기 문구가 나오면 «모든 말에 담당자 확인» 회귀다. */
const GENERIC_FEEDBACK = [
  '결제 화면에서 쿠폰 적용 버튼을 눌러도 아무 반응이 없어요',
  '다크 모드가 있으면 좋겠어요',
  '디자인이 깔끔해서 쓰기 편하네요',
];

async function main() {
  if (!BOT_ID) throw new Error('--bot <bot_id> 가 필요합니다');

  const { getBotConfigFromDB } = await import('../src/lib/bot/core');
  const { getSystemPrompt } = await import('../src/lib/bot/prompts');
  const { callLlm, extractResult } = await import('../src/lib/bot/handler');
  const { GROUNDING_REMINDER, applyHoldingPolicy, isHoldingResponse } = await import('../src/lib/bot/holding');

  const config = await getBotConfigFromDB(BOT_ID);
  if (AS_PLATFORM) {
    // 메모리 사본만 바꾼다. 키를 지우면 resolveModel 이 플랫폼 폴백(env)을 탄다.
    config.llmApiKeyEncrypted = null;
    config.llmProvider = null;
    config.llmModel = null;
  }
  // --model 은 플랫폼 폴백(env) 을 덮는다. 운영자 키가 있는 봇이면 그 키로 «지정한 모델»을 부른다 —
  // 지식이 실린 봇을 다른 모델로 재보기 위해서다(DB 는 안 건드린다).
  if (MODEL && config.llmApiKeyEncrypted) config.llmModel = MODEL;
  if (PROVIDER && config.llmApiKeyEncrypted) {
    throw new Error('--provider 는 키 없는 봇(플랫폼 폴백)에만 쓴다 — 운영자 키는 그 provider 에 묶여 있다');
  }
  const system = getSystemPrompt(config.serviceProfile);

  console.log(
    `봇 ${BOT_ID} · ${config.llmApiKeyEncrypted ? `운영자 키 · provider ${config.llmProvider} · 모델 ${config.llmModel ?? '(추천값)'}` : `플랫폼 폴백 · provider ${PROVIDER ?? process.env.PLATFORM_LLM_PROVIDER ?? 'gemini'} · 모델 ${MODEL ?? process.env.PLATFORM_LLM_MODEL ?? '(추천값)'}`} · 세트 ${SET} · 상기 ${REMINDER ? 'on' : 'off'}\n` +
      `시스템 프롬프트 ${system.length}자 · 지식 ${config.serviceProfile.knowledge?.length ?? 0}자 · ` +
      `FAQ ${config.serviceProfile.faq?.length ?? 0}개 · 질문당 ${RUNS}회\n`,
  );

  const latencies: number[] = [];
  async function ask(text: string) {
    const started = Date.now();
    const userTurn = REMINDER ? `사용자: ${text}\n${GROUNDING_REMINDER}` : `사용자: ${text}`;
    const raw = await callLlm(config, system, userTurn, {
      timeoutMs: WIDGET_TIMEOUT_MS,
      // 이건 우리 실험이다. 실패해도 운영자 「키 확인 필요」 배지를 켜지 않는다.
      recordKeyFailure: false,
    });
    latencies.push(Date.now() - started);
    if (!raw) return { escalate: null as boolean | null, parsed: false, modelHolding: false, holding: false, response: '(호출 실패/타임아웃)' };
    const r = extractResult(raw);
    // 모델이 «스스로» 대기 문구를 냈는지를 먼저 적고, 그 다음 서버 정책을 건다.
    // 정책 뒤에만 재면 모델이 지어낸 숫자를 정책이 갈아끼운 회차도 ○ 가 되어 모델 간 차이가 안 보인다.
    const modelHolding = isHoldingResponse(r.response);
    const modelText = r.response ?? '(응답 없음)';
    applyHoldingPolicy(r);
    return {
      escalate: r.escalate === true,
      parsed: r.parsed !== false,
      modelHolding,
      holding: isHoldingResponse(r.response),
      response: modelText,
    };
  }

  /**
   * mode 'hold'   : 정답 = escalate 이고 응답이 대기 문구 (지어내지 않음). «모델 자력»과 «정책 뒤» 두 줄로 센다
   * mode 'answer' : 정답 = escalate 아님 (그 자리에서 답함)
   * mode 'nohold' : 정답 = 파싱된 실제 답이 있고 그게 대기 문구가 «아님» (escalate 는 무관 — 버그 제보는 켜도 된다)
   */
  async function group(label: string, questions: string[], mode: 'hold' | 'answer' | 'nohold') {
    const want = { hold: 'escalate + 대기 문구', answer: '즉답(escalate false)', nohold: '대기 문구 아님' }[mode];
    console.log(`── ${label} (기대: ${want})`);
    let hit = 0;
    let modelHit = 0;
    let total = 0;
    for (const q of questions) {
      const marks: string[] = [];
      let worst = '';
      let first = '';
      for (let i = 0; i < RUNS; i++) {
        const r = await ask(q);
        total++;
        const ok =
          r.escalate === null ? false
          : mode === 'hold' ? r.escalate && r.holding
          : mode === 'answer' ? !r.escalate
          : r.parsed && r.response !== '(응답 없음)' && !r.holding;
        if (ok) hit++;
        const modelOk = mode === 'hold' ? r.escalate === true && r.modelHolding : ok;
        if (modelOk) modelHit++;
        // ◐ = 모델은 지어냈지만 서버 정책이 갈아끼움(파이프라인으로는 통과)
        marks.push(r.escalate === null ? '!' : ok ? (modelOk ? '○' : '◐') : '✗');
        const line = r.response.replace(/\s+/g, ' ').slice(0, 110);
        if (!first) first = line;
        if (!ok && !worst) worst = line;
      }
      console.log(`  ${marks.join('')}  ${q}`);
      console.log(`      └ "${worst || first}"${worst ? '  ← 기대와 다른 예' : ''}`);
    }
    console.log(mode === 'hold' ? `  → 정책 뒤 ${hit}/${total} · 모델 자력 ${modelHit}/${total}\n` : `  → ${hit}/${total}\n`);
    return { hit, modelHit, total };
  }

  const rows: [string, { hit: number; modelHit: number; total: number }][] = [];
  if (SET === 'feedloop2') {
    rows.push(['지식 안 즉답', await group('지식 안 (확장 v2)', FEEDLOOP2_INSIDE, 'answer')]);
    rows.push(['지식 밖 대기', await group('지식 밖 (확장 뒤에도 모름)', FEEDLOOP2_OUTSIDE, 'hold')]);
    rows.push(['피드백 대기문구 안 씀', await group('피드백 (대조군)', FEEDLOOP_FEEDBACK, 'nohold')]);
  } else if (SET === 'feedloop') {
    rows.push(['지식 안 즉답', await group('지식 안 (FAQ·본문)', FEEDLOOP_INSIDE, 'answer')]);
    rows.push(['지식 밖 대기', await group('지식 밖', FEEDLOOP_OUTSIDE, 'hold')]);
    rows.push(['피드백 대기문구 안 씀', await group('피드백 (대조군)', FEEDLOOP_FEEDBACK, 'nohold')]);
  } else if (SET === 'generic') {
    rows.push(['사실 질문(지식 0) 대기', await group('사실 질문 — 근거 없음', GENERIC_FACT, 'hold')]);
    rows.push(['피드백 대기문구 안 씀', await group('피드백 (대조군)', GENERIC_FEEDBACK, 'nohold')]);
  } else {
    rows.push(['지식 밖 대기', await group('지식 밖', OUTSIDE, 'hold')]);
    rows.push(['지식 안 즉답', await group('지식 안 (대조군)', INSIDE, 'answer')]);
    rows.push(['피드백 대기문구 안 씀', await group('피드백 (대조군)', GENERIC_FEEDBACK, 'nohold')]);
  }

  console.log('─'.repeat(60));
  for (const [label, r] of rows) {
    const model = r.modelHit !== r.hit ? ` (모델 자력 ${r.modelHit}/${r.total})` : '';
    console.log(`${label.padEnd(20, ' ')} ${r.hit}/${r.total}${model}`);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  console.log(`지연 n=${sorted.length} · p50 ${(q(0.5) / 1000).toFixed(1)}s · p90 ${(q(0.9) / 1000).toFixed(1)}s · max ${(q(1) / 1000).toFixed(1)}s · 4초 초과 ${sorted.filter((v) => v > 4000).length} · 10초 초과 ${sorted.filter((v) => v >= 10000).length}`);
  console.log('\n(○ 기대대로 · ◐ 모델은 틀렸으나 서버 정책이 대기 문구로 바꿈 · ✗ 기대와 다름 · ! 호출 실패)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

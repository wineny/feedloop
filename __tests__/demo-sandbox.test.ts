// 레인 A — 연습용 화면(로그아웃 심사 화면)의 안전장치 (2026-09-18)
//
// 랜딩 「라이브 데모」 팝업이 심사위원을 우리 운영자 화면으로 데려간다. 거기서는 예전과 달리
// 버튼이 **눌린다** — 답장 보내기, 지금 묶기, PR 만들기, 묶음 닫기, 머지 확인.
//
// 그래서 지켜야 하는 것이 하나 늘었다:
//
//   🔴 연습용 화면에서 누른 버튼은 **서버로 나가면 안 된다.**
//      로그인하지 않은 아무나 누를 수 있는 버튼이고, 그 끝에는 진짜 방문자의 대화와
//      진짜 GitHub 레포가 있다. 심사 기간 17일 동안 누가 몇 번 누를지 모른다.
//
// 위험한 회귀는 「버튼은 풀어 놓고 안전장치를 지우는 것」이다. 그러면 화면은 멀쩡해 보이는데
// 누르는 순간 진짜 API 로 나간다. 그 모양을 소스에서 직접 막는다 —
// jsdom·testing-library 가 이 레포에 없어서(제출 전날이라 의존성을 늘리지 않는다)
// widget.js 게이트 테스트와 같은 방식으로 «함수 본문»을 떼어내 검사한다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * `const 이름 = ... => { ... }` 의 본문을 통째로 떼어낸다.
 * 중괄호를 세어 닫는 자리를 찾는다 — 이 파일들의 주석·문자열에는 짝 안 맞는 중괄호가 없다.
 */
function grabArrowBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`${name} 을 못 찾았다 — 이름이 바뀌었으면 이 테스트도 같이 고쳐라`);
  const open = src.indexOf('{', src.indexOf('=>', at));
  if (open < 0) throw new Error(`${name} 의 본문 시작을 못 찾았다`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 의 본문이 안 닫혔다`);
}

/** 연습용 분기가 fetch 보다 «앞»에 있고, 그 분기가 return 으로 끊는가. */
function demoGateGuardsFetch(body: string): { hasGate: boolean; gateBeforeFetch: boolean; gateReturns: boolean } {
  // `if (demo.isDemo) {` 또는 `if (demo) {`
  const gate = body.search(/if \(demo(\.isDemo)?\)\s*\{/);
  const fetchAt = body.indexOf('fetch(');
  if (gate < 0) return { hasGate: false, gateBeforeFetch: false, gateReturns: false };
  // 분기 안에서 return 으로 끊는지 — 끊지 않으면 그대로 아래 fetch 까지 흘러내린다
  const tail = body.slice(gate, fetchAt > gate ? fetchAt : undefined);
  return {
    hasGate: true,
    gateBeforeFetch: fetchAt < 0 || gate < fetchAt,
    // ⚠️ `return` 만 찾으면 안 된다. 연습용 블록 안에는 `patchDemo(prev => { return {...} })` 처럼
    //    **값을 돌려주는** return 이 이미 들어 있어서, 정작 핸들러를 끊는 맨 `return;` 을 지워도
    //    이 검사가 초록인 채로 남는다 — 이 파일이 막겠다고 한 바로 그 회귀를 놓친다.
    //    그래서 «맨» return 만 인정한다.
    gateReturns: /\breturn\s*;/.test(tail),
  };
}

describe('연습용 화면 — 눌러도 서버로 나가지 않는다', () => {
  const cases: { file: string; fn: string; 무엇: string }[] = [
    { file: 'src/app/[locale]/inbox/page.tsx', fn: 'handleSendReply', 무엇: '답장 보내기' },
    { file: 'src/app/[locale]/inbox/page.tsx', fn: 'handleCloseConversation', 무엇: '대화 닫기' },
    { file: 'src/app/[locale]/dashboard/page.tsx', fn: 'handleCheckMerged', 무엇: '머지 확인' },
    { file: 'src/components/dashboard/InsightGroups.tsx', fn: 'handleRunGrouping', 무엇: '지금 묶기' },
    { file: 'src/components/dashboard/InsightGroups.tsx', fn: 'handleCreatePr', 무엇: 'PR 만들기' },
    { file: 'src/components/dashboard/InsightGroups.tsx', fn: 'handleDismiss', 무엇: '묶음 닫기' },
  ];

  for (const { file, fn, 무엇 } of cases) {
    it(`${무엇} — 연습용이면 fetch 앞에서 끊는다`, () => {
      const g = demoGateGuardsFetch(grabArrowBody(read(file), fn));
      expect(g.hasGate, `${fn} 에 연습용 분기가 없다`).toBe(true);
      expect(g.gateBeforeFetch, `${fn} 의 연습용 분기가 fetch 보다 뒤에 있다`).toBe(true);
      expect(g.gateReturns, `${fn} 의 연습용 분기가 return 으로 끊지 않는다`).toBe(true);
    });
  }
});

/** 주석을 걷어낸 코드만 남긴다 — 「왜 안 쓰는가」를 적어 둔 주석이 「쓴다」로 읽히지 않게. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('연습용 상태는 이 탭에만 산다', () => {
  const provider = codeOnly(read('src/lib/demo/DemoProvider.tsx'));

  it('연습용 기록을 브라우저 저장소에 남기지 않는다', () => {
    // 남기면 앞사람이 어질러 놓은 화면을 뒷사람이 물려받아 튜토리얼이 한 번 쓰고 닳는다.
    expect(provider).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('연습용 데이터를 서버로 보내지 않는다', () => {
    expect(provider).not.toMatch(/\bfetch\(/);
  });
});

describe('데모가 가리키는 주소', () => {
  const constants = read('src/components/landing/constants.ts');

  it('DEMO_URL 이 실제 데모 사이트를 가리킨다', () => {
    const m = constants.match(/export const DEMO_URL = '([^']+)'/);
    expect(m, 'DEMO_URL 을 못 찾았다').toBeTruthy();
    const url = m![1];
    // 🔴 한 번 `http://localhost:8765`(개발용 임시 페이지)가 커밋 직전까지 남아 있었다.
    //    그대로 나갔으면 랜딩의 [라이브 데모]가 빈 화면이 됐다.
    expect(url).toMatch(/^https:\/\//);
    expect(url).not.toMatch(/localhost|127\.0\.0\.1|\.local/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-18 — 여기 있던 세 검사를 갈아 끼웠다.
 *
 * 없앤 것: ①팝업이 여는 `APP_VIEWS` 가 전부 `?demo=1` 인지 ②`TRACK_STEP` 을 번호가 아니라
 * 표시로 찾는지 ③`LiveDemo.tsx` 의 `W` 치수가 `widget.js` CSS 와 같은지.
 * 셋 다 **팝업이 널널투어를 iframe 으로 띄우던 시절의 검사**다. 이제 팝업은 우리가 그린
 * 각본 데모라(`src/components/demo/guided/`) iframe 도, 남의 오리진 위에 띄우는 화살표도 없다.
 * 검사할 대상 자체가 사라졌지 기준이 느슨해진 게 아니다.
 *
 * ⚠️ `public/widget.js` 와 `/api/public/demo-track` 은 **그대로 살아 있다**(널널투어 실서비스에
 * 이미 나가 있는 파일이라 동결일에 건드리지 않았다). 그 둘을 지키는 `demo-track.test.ts` 도 그대로다.
 * ⚠️ 위쪽 「연습용 화면」 검사들도 그대로다 — `?demo=1` 경로는 아직 누구나 열 수 있다.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('가이드 데모 — 각본은 서버로 나가지 않는다', () => {
  const files = [
    'src/components/demo/guided/script.ts',
    'src/components/demo/guided/GuidedDemo.tsx',
    'src/components/demo/guided/SiteStage.tsx',
    'src/components/demo/guided/Widget.tsx',
  ];

  for (const f of files) {
    it(`${f.split('/').pop()} 이 네트워크를 건드리지 않는다`, () => {
      // 각본 데모는 로그인 없이 아무나 여는 화면이고, 심사 기간 17일 동안 몇 번 열릴지 모른다.
      // 여기서 요청이 나가는 순간 그 끝에는 진짜 방문자의 대화와 진짜 레포가 있다.
      const code = codeOnly(read(f));
      expect(code).not.toMatch(/\bfetch\(/);
      expect(code).not.toMatch(/XMLHttpRequest|sendBeacon|EventSource|new WebSocket/);
    });
  }

  it('각본이 브라우저 저장소에 아무것도 남기지 않는다', () => {
    // 남기면 앞사람이 보던 데까지 물려받아 「처음부터」가 처음이 아니게 된다.
    for (const f of files) {
      expect(codeOnly(read(f)), f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});

describe('가이드 데모 각본 자체', () => {
  it('단계마다 제목·화면·재생할 것이 앞뒤가 맞는다', async () => {
    const { STEPS, PAGE_SRC } = await import('@/components/demo/guided/script');
    expect(STEPS.length).toBeGreaterThanOrEqual(5);
    for (const a of STEPS) {
      // 설명 문단이 없어진 뒤로 **제목이 패널의 유일한 말**이다. 비면 그 단계는 아무 말도 안 한다.
      expect(a.title.length, `${a.key} 에 제목이 없다`).toBeGreaterThan(0);
      expect(PAGE_SRC[a.page], `${a.key} 의 화면 ${a.page} 이 PAGE_SRC 에 없다`).toBeTruthy();
      // 누를 곳이 없는 단계는 버튼 문구가 있어야 한다. 없으면 화면에서 막힌다.
      if (!a.target) expect(a.label?.length ?? 0, `${a.key} 에 넘어갈 버튼 문구가 없다`).toBeGreaterThan(0);
      else expect(a.hint.length, `${a.key} 에 링 옆 지시가 없다`).toBeGreaterThan(0);
      // 누를 것도 재생할 것도 볼 곳도 없으면 그 단계는 아무 말도 안 하는 빈 칸이다.
      expect(
        a.frames.length > 0 || !!a.spot || !!a.target,
        `${a.key} 에 누를 것도·재생할 것도·볼 곳도 없다`,
      ).toBe(true);
    }
  });

  it('패널은 제목만 말한다 — 설명 문단을 되살리지 않는다', async () => {
    // 🔴 세 번 줄였다. 긴 문단(ny 「너무 길다」) → 불릿 두 줄(ny 「절대 2줄을 안 넘게」) →
    //    통째로 삭제(ny 「그냥 아예 2줄 불릿도 다 없애자」, 2026-09-18).
    //    왼쪽에서 읽고 오른쪽에서 찾는 왕복이 이 데모의 가장 큰 군더더기였다. 지금은 패널이
    //    제목 하나만 말하고, 「지금 뭘 누르라는지」는 화면 위 말풍선이 그 자리에서 말한다.
    //    되살리기로 정한다면 이 검사부터 지워라 — 모르고 되돌아가는 것을 막으려고 둔 것이다.
    const script = read('src/components/demo/guided/script.ts');
    const panel = read('src/components/demo/guided/GuidedDemo.tsx');
    expect(script, '각본에 설명 문단이 되살아났다').not.toMatch(/^\s*say:/m);
    expect(panel, '패널이 설명 문단을 다시 그린다').not.toMatch(/step\?\.say|\bOUTRO\b|\bINTRO\b/);
  });

  it('안내 문구가 널널투어 챗봇 캐릭터를 우리 입으로 말하지 않는다', async () => {
    // 만복이는 **널널투어 위젯의 프로필**이다. Feedloop 안내가 「안녕하세요, 만복이예요」라고
    // 말하면 우리 제품의 안내인지 그 사이트의 캐릭터인지 구분이 안 된다(ny 지적 2026-09-18).
    // 위젯 그림 쪽 얼굴은 그대로 두고, **설명하는 말**에서만 뺀다.
    const { STEPS } = await import('@/components/demo/guided/script');
    for (const a of STEPS) {
      // 패널에 남은 말(제목)과 화면 위에 뜨는 말(말풍선) 둘 다 본다
      const words = [a.title, a.hint, a.label ?? '', ...(a.spot?.text ?? []), a.spot?.say ?? ''].join(' ');
      expect(words, `${a.key} 의 안내에 만복이가 있다`).not.toMatch(/만복/);
    }
  });

  it('짚는 자리는 그 단계가 서 있는 화면에 실제로 있는 «글자»다', async () => {
    // 클래스 이름으로 찾으면 화면을 다시 떠 오는 순간 조용히 빗나간다. 그리고 단계마다
    // **자기 화면**에서 찾아야 한다 — 편지함 글자를 지도 화면에서 찾으면 링이 안 뜬다.
    const { STEPS, PAGE_SRC } = await import('@/components/demo/guided/script');
    const { readFileSync } = await import('node:fs');
    for (const s of STEPS) {
      const page = readFileSync(new URL(`../public${PAGE_SRC[s.page]}`, import.meta.url), 'utf8');
      const wants: { what: string; texts: string[] }[] = [];
      // 🔴 여러 줄을 한꺼번에 짚는 단계는 «하나라도» 가 아니라 «전부» 있어야 한다 —
      //    하나만 있어도 통과시키면 「이 셋이 같은 문제」가 둘만 켜진 채로 나간다.
      if (s.target?.where === 'frame-many') {
        for (const t of s.target.text) {
          expect(page.includes(t), `${s.key}(${s.page}) 에서 짚을 「${t}」 가 떠 온 화면에 없다`).toBe(true);
        }
      } else if (s.target && s.target.where !== 'widget') {
        wants.push({ what: '누를 곳', texts: s.target.text });
      }
      if (s.spot) wants.push({ what: '볼 곳', texts: s.spot.text });
      for (const w of wants) {
        // 후보 중 «적어도 하나»는 떠 온 화면에 있어야 한다. 하나도 없으면 링이 뜰 곳이 없다.
        expect(
          w.texts.some((t) => page.includes(t)),
          `${s.key}(${s.page}) 의 ${w.what}: 떠 온 화면에 「${w.texts.join(' / ')}」 중 아무것도 없다`,
        ).toBe(true);
      }
    }
  });

  it('칸째 두르는 단계는 «글자»가 아니라 그 글자를 품은 칸을 두른다', async () => {
    // 🔴 ny 2026-09-18 5차 — 「빨간 박스는 이 아래쪽 섹션을 둘러싸는 게 더 나을 것 같아, 『반영 알림』 말고」.
    //    제목 세 글자만 두르면 「알림이 나갔다」는 말뿐이고 **누구에게 갔는지**가 박스 밖에 남는다.
    //    `spot.grow` 는 글자를 찾은 뒤 그 글자를 품은 칸까지 올라가 두른다.
    //
    //    이 검사가 지키는 것 둘 —
    //      ① 올라갈 칸이 떠 온 화면에 «실제로» 있다. 없으면 `closest` 가 null 이라 조용히
    //         글자만 두르는 예전 모습으로 돌아간다(화면은 멀쩡해 보여서 눈으로는 못 잡는다).
    //      ② 그 칸 안에 **두르려던 것이 같이 들어 있다.** 화면을 다시 떠 왔을 때 받은 사람 줄이
    //         다른 칸으로 빠지면 박스는 떠도 여전히 제목만 두르게 된다.
    const { STEPS, PAGE_SRC } = await import('@/components/demo/guided/script');
    const { readFileSync } = await import('node:fs');
    const grown = STEPS.filter((s) => s.spot?.grow);
    expect(grown.length, '칸째 두르는 단계가 하나도 없다 — 되돌렸다면 이 검사도 같이 지워라').toBeGreaterThan(0);

    for (const s of grown) {
      const tag = s.spot!.grow!;
      // 이 검사는 파서 없이 태그를 세어 본다 — 선택자가 태그 이름을 벗어나면 못 본다
      expect(tag, `${s.key}: 검사가 볼 수 있는 것은 태그 이름뿐이다 (지금 「${tag}」)`).toMatch(/^[a-z]+$/);
      const page = readFileSync(new URL(`../public${PAGE_SRC[s.page]}`, import.meta.url), 'utf8');
      const blocks = page.split(`<${tag}`).slice(1).map((x) => x.split(`</${tag}>`)[0]);
      const hit = blocks.filter((b) => s.spot!.text.some((t) => b.includes(t)));
      expect(
        hit.length,
        `${s.key}(${s.page}): 「${s.spot!.text.join(' / ')}」 를 품은 <${tag}> 가 떠 온 화면에 없다`,
      ).toBeGreaterThan(0);
      // 칸이 글자보다 «크다» — 두르는 뜻이 살아 있다
      expect(hit.some((b) => b.length > 200), `${s.key}: 올라간 칸이 글자 한 줄만 하다`).toBe(true);
    }

    // 9단계가 두르는 칸 안에 **받은 사람 줄**이 같이 있어야 이 단계의 주장이 화면에서 증명된다.
    // (짚는 글자가 목록 «안»의 한 줄인 이유 — `grow` 는 위로만 올라가므로 제목에서는 옆 형제인
    //  목록에 닿을 수 없다. 자세한 사정은 `script.ts` 의 그 단계 주석에 있다.)
    const merge = STEPS.find((s) => s.key === 'merge');
    expect(merge?.spot?.grow, '9단계가 다시 글자만 두른다').toBeTruthy();
    const pr = readFileSync(new URL(`../public${PAGE_SRC[merge!.page]}`, import.meta.url), 'utf8');
    const box = pr
      .split(`<${merge!.spot!.grow!}`)
      .slice(1)
      .map((x) => x.split(`</${merge!.spot!.grow!}>`)[0])
      .find((b) => merge!.spot!.text.some((t) => b.includes(t)));
    expect(box?.includes('전달됨'), '9단계 박스 안에 「전달됨」 줄이 없다 — 누구에게 갔는지가 박스 밖이다').toBe(true);
  });

  it('루프를 끝까지 닫는다 — 되돌림까지 간다', async () => {
    // 데모가 PR 까지만 가고 끝나면 이 제품의 주장(「고쳐서 돌려준다」)이 화면에서 증명되지 않는다.
    const { STEPS, INITIAL, isCustomerPage } = await import('@/components/demo/guided/script');
    let scene = { ...INITIAL };
    for (const act of STEPS) {
      scene = { ...scene, page: act.page };
      for (const f of act.frames) {
        const patch = typeof f.patch === 'function' ? f.patch(scene) : f.patch;
        scene = { ...scene, ...patch };
      }
    }
    expect(scene.returned).toBe(true);
    // 마지막엔 고객 화면으로 돌아와 「반영됐어요」 카드가 떠 있어야 한다
    expect(isCustomerPage(scene.page)).toBe(true);
    expect(scene.msgs.some((m) => m.card)).toBe(true);
  });

  it('팀 화면까지 한 바퀴를 돈다 — 고객 쪽만 보여주고 끝나지 않는다', async () => {
    // 「피드백이 코드가 된다」가 이 제품의 주장이라, 운영자 쪽 화면이 빠지면 데모가 절반이다.
    const { STEPS, isCustomerPage } = await import('@/components/demo/guided/script');
    const team = new Set(STEPS.map((s) => s.page).filter((p) => !isCustomerPage(p)));
    expect([...team].sort()).toEqual(['groups', 'inbox', 'pr']);
  });

  it('「같은 문제」로 짚는 세 줄이 떠 온 편지함에 실제로 있다', async () => {
    // 🔴 이 셋이 「비슷한 제보 묶기」 단계의 전부다. 한 줄이라도 사본과 어긋나면 짚을 자리를
    //    못 찾아 그 단계가 조용히 버튼으로 넘어가 버린다 — 화면에선 아무 일도 안 일어난다.
    //    떠 온 묶음 화면이 「3명이 말했어요」라고 말하니 세 줄이어야 앞뒤가 맞는다.
    const { SIMILAR_SAYS, SAY } = await import('@/components/demo/guided/script');
    expect(SIMILAR_SAYS).toHaveLength(3);
    expect(SIMILAR_SAYS[0], '첫 줄은 방금 사람이 직접 남긴 그 한마디여야 한다').toBe(SAY);
    expect(new Set(SIMILAR_SAYS).size, '같은 문구가 두 줄 있다').toBe(3);
    const inbox = read('public/demo/team-inbox/index.html');
    for (const t of SIMILAR_SAYS) expect(inbox, `편지함 사본에 「${t}」 가 없다`).toContain(t);
    expect(read('public/demo/team-groups/index.html')).toMatch(/>3<\/b>명이 말했어요/);
  });

  it('건너가는 장면이 다 끝나기 «전»에 꺼지지 않는다', async () => {
    // 🔴 장면 길이가 CSS(애니메이션)와 JS(타이머) 두 군데에 나뉘어 있다. 한쪽만 고치면
    //    우편물이 편지함에 닿기도 전에 사라진다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    const demo = read('src/components/demo/guided/GuidedDemo.tsx');
    const mail = stage.match(/gdMail ([\d.]+)s/);
    expect(mail, 'gdMail 의 길이를 못 찾았다').toBeTruthy();
    const timer = demo.match(/setHandoff\(false\), (\d+)\)/);
    expect(timer, '건너가는 장면을 끄는 타이머를 못 찾았다').toBeTruthy();
    expect(Number(timer![1])).toBeGreaterThanOrEqual(Number(mail![1]) * 1000);
  });

  it('팀 화면과 메일함에서는 배경을 어둡게 칠하지 않는다', () => {
    // ny 「도착 분류부터 반영까지는 배경을 어둡게 안 만들면 어떨까? 다른 화면 파악이 너무 안됨」
    // (2026-09-18). 어둡게 칠하는 것은 고객 화면(널널투어) 한 곳뿐이어야 한다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    expect(stage).toMatch(/const dim = scene\.page === 'map'/);
    // 어둡게 칠할지 «정하는 곳»은 하나여야 한다. 링의 기본 스타일에도 박아 두면 규칙이 둘이 되어,
    // 한쪽만 고쳤을 때 팀 화면이 슬그머니 다시 어두워진다.
    expect(stage).toMatch(/ring\.style\.boxShadow = dim \?/);
    const inJsx = stage.slice(stage.indexOf('ref={ringRef}'));
    expect(inJsx.slice(0, 500), '링의 기본 스타일에 어둠이 박혀 있다').not.toMatch(/9999px/);
  });

  it('말풍선 자리는 «재서» 정한다 — 고정값으로 가두지 않는다', () => {
    // 🔴 「가운데에서 ±70px」이라는 고정값으로 가두던 때가 있었다. 그 70 은 짧은 문구를 재 본
    //    값이라, 문구가 길어지자 390px 에서 **왼쪽이 화면 밖으로 잘려 첫 글자가 사라졌다**
    //    (2026-09-18, ny 워딩 교체 직후). 글자는 있는데 안 읽히니 눈으로 보기 전엔 몰랐다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    expect(stage, '말풍선 폭을 재지 않는다').toMatch(/bubble\.offsetWidth/);
    expect(stage, '말풍선 높이를 재지 않는다').toMatch(/bubble\.offsetHeight/);
    // 옆에 비킬지도 «잰 폭» 으로 정해야 한다 — 고정값이면 긴 문구가 왼쪽으로 삐져나간다
    expect(stage).toMatch(/const room = box\.x >= bw \+ \d+/);
  });

  it('짚을 자리로 부드럽게 미끄러지되, 스크롤 중에 다시 보내지 않는다', () => {
    // ny 「스무스하게 스크롤이 되면 좋겠어」(2026-09-18). 🔴 iframe 안에서 스크롤이 날 때마다
    //    자리를 다시 재는 구조라(`ready`), 거기서 스크롤을 또 시키면 부드러운 이동이 매 프레임
    //    처음부터 다시 시작해 영영 도착하지 못한다. 자리 «재기»는 계속하되 «보내기»는 한 번만.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    expect(stage).toMatch(/behavior: 'smooth'/);
    expect(stage, '단계마다 한 번만 보내는 장치가 없다').toMatch(/scrolledKey\.current === key/);
  });

  it('사본 iframe 은 스크립트를 «허용»한다 — 아이폰에서 안을 누르려면', () => {
    // 🔴 2026-09-23 지인 제보: 카톡 인앱(아이폰)에서 5단계 「눌러서 계속」이 안 눌린다.
    //    WebKit 은 `sandbox` 에 `allow-scripts` 가 없는 프레임 문서에 부모가 단 리스너를 아예 안 부른다
    //    (click·pointermove·scroll 0회 — Playwright webkit 실측). 사본엔 스크립트가 한 줄도 없으니
    //    (위 「남의 스크립트가 한 줄도 없다」) 허용해도 도는 게 없다. 「한 겹 더 잠그자」고 되돌리면
    //    아이폰이 통째로 막힌다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    expect(stage).toMatch(/sandbox="(?=[^"]*allow-same-origin)(?=[^"]*allow-scripts)[^"]*"/);
  });

  it('챗봇 창은 고객 화면에서만 «피할 것»으로 센다', () => {
    // 🔴 팀 화면으로 넘어간 직후 0.3초는 창이 `visibility` 전환 중이라 아직 `visible` 로 읽힌다.
    //    모바일에선 창이 폭을 다 덮어, 5단계 편지함 줄을 창 아래(프레임 밖)로 밀어 스크롤이 0 으로
    //    되돌아가고 링이 무대 바닥에 잘렸다(2026-09-23 실측). visibility 검사만으로는 못 거른다 —
    //    화면이 `map` 일 때만 창을 가드에 넣는다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    const body = grabArrowBody(stage, 'scrollIntoSafeArea');
    expect(body).toMatch(/live\.current\.page === 'map'\s*\?\s*widgetRef\.current\?\.querySelector<HTMLElement>\('\[data-widget-panel\]'\)\s*:\s*null/);
  });

  it('아이폰 탭은 touchend 에서 받고, 합성 click 은 끊는다', () => {
    // 🔴 WebKit 은 `<p>`·`<ul>` 같은 요소를 탭해도 click 을 안 만든다(cursor:pointer 를 줘도). 그래서 탭은
    //    `touchend` 에서 직접 받는다. 거기서 `preventDefault` 를 빼면 버튼은 두 번 세고(5→6단계처럼 같은
    //    줄이 연이어 짚히는 자리는 한 탭에 두 단계), `passive: true` 로 바꾸면 preventDefault 가 조용히
    //    무시된다. 둘 다 화면은 멀쩡해 보여서 아이폰으로 눌러 보기 전엔 모른다.
    const stage = read('src/components/demo/guided/SiteStage.tsx');
    const at = stage.indexOf("'touchend',");
    expect(at, 'touchend 경로가 없다').toBeGreaterThan(0);
    const block = stage.slice(at, stage.indexOf('{ capture: true, passive: false }', at) + 40);
    expect(block, 'passive:false 가 아니면 preventDefault 가 안 듣는다').toMatch(/passive: false/);
    expect(block, '합성 click 을 안 끊는다').toMatch(/e\.preventDefault\(\)/);
    expect(block).toMatch(/onTap\(/);
    // 마우스 길(click)도 같은 onTap 으로 간다 — 두 길이 다른 논리를 갖게 두지 않는다
    const click = stage.slice(stage.indexOf("'click',"), at);
    expect(click).toMatch(/onTap\(/);
  });

  it('마지막 메일 화면의 본문은 손으로 그린 것이 아니다', () => {
    // 🔴 데모의 마지막 화면은 «프로덕션에서 진짜 메일을 만드는 그 함수»가 만든 것이어야 한다.
    //    따로 그려 두면 템플릿을 고쳤을 때 데모만 옛 모습으로 남아 «없는 제품»을 보여주게 된다.
    const render = read('scripts/render-demo-mail.ts');
    expect(render).toMatch(/renderLoopClosedEmail/);
    expect(render).toMatch(/from '\.\.\/src\/lib\/email\/templates'/);
    // 각본이 그 화면에서 짚는 글자가 실제로 떠 온 메일에 있어야 한다
    const mail = read('public/demo/mail/index.html');
    expect(mail).toContain('「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음');
    expect(mail).toContain('말씀하신 문제를 고쳤어요');
  });

  it('알아서 재생되는 길이가 사람이 앉아 있을 만하다', async () => {
    // ⚠️ 하한이 15초였다가 내려왔다. 팀 화면 세 단계가 «재생»에서 «화면 전환»으로 바뀌면서
    //    (2026-09-18) 자동 재생 구간이 고객 쪽 넷으로 줄었기 때문이다. 기준이 느슨해진 게
    //    아니라 재는 대상이 달라졌다 — 팀 쪽은 이제 사람이 버튼을 눌러 넘긴다.
    const { TOTAL_MS } = await import('@/components/demo/guided/script');
    expect(TOTAL_MS).toBeGreaterThan(8_000);
    expect(TOTAL_MS).toBeLessThan(120_000);
  });
});

/* ⚠️ 「붙인 사례」 검사는 지웠다 — 랜딩 레인이 그 섹션과 `InstalledOn.tsx` 를 통째로 걷어냈다
 *    (main `454c491` 까지). 검사만 남으면 없는 파일을 읽다 죽는다. */

describe('떠 온 사본 넉 장', () => {
  // 랜딩 데모가 실서비스가 아니라 **우리 주소의 사본**을 띄우는 이유는 `SiteStage.tsx` 머리주석에.
  // 사본이 지켜야 하는 것들을 여기서 막는다.
  // 고객 쪽 사본 — 자기 폴더 안에 자산을 두고 뿌리(`/…`)에서 남의 것을 찾지 않아야 한다
  const site = ['public/demo/nulnul-map/index.html', 'public/demo/mail/index.html'];
  const team = [
    'public/demo/team-inbox/index.html',
    'public/demo/team-groups/index.html',
    'public/demo/team-pr/index.html',
  ];

  for (const f of [...site, ...team]) {
    const name = f.split('/').at(-2);

    it(`${name} — 남의 스크립트가 한 줄도 없다`, () => {
      // 캡처할 때 걷어냈다. 다시 들어오면 심사위원 브라우저에서 코드가 돌고,
      // 하이드레이션이 API 를 부르다 화면이 비워진다.
      const html = read(f);
      expect(html).not.toMatch(/<script/i);
      // 🔴 iframe 이 `allow-scripts` 를 켠 뒤(아이폰 탭 때문에)로는 `<script>` 말고도 코드가 도는 길이 있다 —
      //    인라인 핸들러(`onerror=`)·`javascript:` 주소·안에 또 박힌 프레임. 다시 뜰 때 하나라도 딸려 오면 여기서 잡는다.
      expect(html, '인라인 이벤트 핸들러가 딸려 왔다').not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, 'javascript: 주소가 딸려 왔다').not.toMatch(/javascript:/i);
      expect(html, '사본 안에 또 프레임·객체가 있다').not.toMatch(/<(iframe|object|embed)\b/i);
    });

    it(`${name} — 자기 힘으로 뜬다(바깥을 안 부른다)`, () => {
      // 널널투어나 우리 앱이 내려가도 데모는 그대로 떠야 한다.
      // 심사 기간 17일 동안 링크가 죽으면 실격이다.
      const html = read(f);
      expect(html).not.toMatch(/localhost|127\.0\.0\.1/);
      expect(html).not.toMatch(/src="https?:/);
      expect(html).not.toMatch(/<link[^>]+href="https?:/i);
      // ⚠️ `<a href>` 는 다르다 — 누르기 전에는 아무것도 안 부른다. 메일 사본의 「확인하기」가
      //    진짜 널널투어를 가리키는 것은 **맞는 것**이다(우리 앱이 실제로 보내는 본문이 그렇다).
      //    나머지 사본에 그 주소가 남아 있으면 자산을 덜 가져왔다는 뜻이라 그대로 막는다.
      if (name !== 'mail') expect(html).not.toMatch(/https?:\/\/nulnul\.vercel\.app/);
    });

    it(`${name} — 개발 서버 찌꺼기가 없다`, () => {
      // Next 개발 서버는 `/__nextjs_font/…` 폰트를 끼워 넣는다. **프로덕션에 없는 주소**라
      // 배포된 사본에서 404 가 난다. 우리 앱 화면을 떠 오면서 처음 나왔다(2026-09-18).
      expect(read(f)).not.toMatch(/__nextjs_font/);
    });
  }

  for (const f of site) {
    it(`${f.split('/').at(-2)} — 남의 오리진 자산을 뿌리에서 찾지 않는다`, () => {
      // 🔴 `<image href="/thumb-….jpg">`(SVG 안 사진) 한 장이 이렇게 남아 404 였다 — 그 주소는
      //    널널투어 것이라 우리 주소에는 없다. 지도에 구멍이 뚫린 채로 심사에 나갈 뻔했다.
      //    (우리 앱을 떠 온 팀 화면은 다르다. `/favicon.ico` 처럼 뿌리에서 찾아도 우리 것이 나온다.)
      expect(read(f)).not.toMatch(/(?:src|href)="\/[^"]*\.(?:jpg|jpeg|png|webp|avif|svg|css|woff2?)"/i);
    });
  }

  for (const f of team) {
    it(`${f.split('/').at(-2)} — 연습용 데이터로 떴다(실방문자 정보 0)`, () => {
      // 🔴 FAQ 「개인정보 포함 금지」. 로그인한 진짜 운영자 화면을 떠 오면 실방문자의 이름과
      //    이메일이 제출물에 박힌다. `?demo=1` 로 떴다는 증거가 화면의 이 배너다 —
      //    배너가 없으면 진짜 데이터일 수 있으니 통과시키지 않는다.
      expect(read(f)).toMatch(/예시 데이터로 둘러보는 중이에요/);
    });
  }

  it('팀 화면 셋이 자산을 한 벌만 쓴다', () => {
    // 세 장이 각자 폰트 92개를 복사해 가면 9.6MB 다. 같은 폴더를 함께 본다.
    for (const f of team) expect(read(f), f).toMatch(/\.\.\/team-a\//);
  });

  it('연습용 화면이 스스로 띄우는 링은 떠 오지 않는다', () => {
    // 🔴 `?demo=1` 화면은 자기 나름의 「여기를 눌러보세요」 링(`DemoHint`)을 띄운다. 그게 사본에
    //    박히면 튜토리얼이 씌우는 링과 **빨간 링이 두 개**가 되어, 지금 할 일이 어느 쪽인지
    //    알 수 없다(ny 지적 2026-09-18 — 편지함의 「여기에 답장을 써보세요」).
    //    걷어내는 일은 캡처기가 한다. 다시 떠 와도 안 딸려오도록 세 곳을 함께 묶어 둔다.
    for (const f of team) {
      expect(read(f), f).not.toMatch(/demoHintPulse/);
      expect(read(f), f).not.toMatch(/data-demo-hint/);
    }
    // ① 표식 — DemoHint 가 그리는 것 전부에 붙어 있어야 캡처기가 찾는다(링·말풍선·keyframes 3개)
    const hint = read('src/components/demo/DemoHint.tsx');
    expect((hint.match(/data-demo-hint=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // ② 걷어내기 — 캡처기가 그 표식을 지운다. 둘 중 하나만 있으면 다음 캡처에서 조용히 되살아난다
    expect(read('scripts/capture-nulnul.mjs')).toMatch(/\[data-demo-hint\][\s\S]{0,80}remove\(\)/);
  });

  it('각본이 말하는 묶음 제목이 떠 온 팀 화면에 실제로 있다', () => {
    // 왼쪽 안내와 오른쪽 그림이 갈라지는 것이 이 데모가 세 번 갈아엎힌 이유다.
    const title = '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음';
    expect(read('public/demo/team-groups/index.html')).toContain(title);
    expect(read('public/demo/team-pr/index.html')).toContain(title);
  });
});

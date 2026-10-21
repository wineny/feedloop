/**
 * 가이드 데모 각본 — 「게임 튜토리얼」 (ny 결정 2026-09-18 17:00, 흐름 개정 18:30)
 *
 * 앞선 판들이 왜 안 됐나:
 *   ① 널널투어 실서비스를 iframe 으로 띄운 판 — 진짜였지만 **다른 오리진**이라 우리가 그 안을
 *      만질 수 없었다. 버튼 위에 안내를 붙일 수도, 입력칸에 글자를 넣을 수도 없다.
 *   ② 화면을 우리가 그린 판 — 만질 수는 있는데 「가짜 같다」(ny).
 *
 * 그래서 지금 판 — **화면을 전부 우리 주소로 떠 왔다**(`public/demo/`).
 * 고객 쪽은 널널투어 전국 지도, 팀 쪽은 **우리 앱의 진짜 화면 3장**(편지함·피드백 묶음·수정 PR)이다.
 * 손으로 그린 화면은 하나도 없다. 같은 오리진이라 우리가 만질 수 있어서 이게 된다:
 *   · 눌러야 할 곳에 **반짝이는 링**을 씌우고
 *   · **그 버튼 말고는 아예 안 눌리게** 막고
 *   · 「화면에서 선택하기」가 **진짜로** 동작한다(누른 자리를 실제로 재서 붙인다)
 *
 * 🔴 여기 있는 것은 **서버로 나가지 않는다.** 화면은 전부 떠 온 사본이다.
 * 🔴 팀 화면은 `?demo=1` 연습용 데이터를 떠 온 것이라 **실방문자 이름·이메일이 한 글자도 없다**
 *    (FAQ 「개인정보 포함 금지」). 거기 보이는 이름·건수는 전부 지어낸 것이다.
 * 🔴 널널투어는 우리가 만든 서비스다. 사진 출처 표기는 떠 온 화면에 **그대로 살아 있다.**
 */

import { copy as enCopy } from './script.en';
import { copy as koCopy } from './script.ko';

// ── 화면 상태 ────────────────────────────────────────────────

/**
 * iframe 이 지금 띄우고 있는 화면.
 * `map` 하나만 고객 화면이고 나머지 셋은 **우리 앱의 진짜 운영자 화면**이다.
 */
export type SitePage = 'map' | 'inbox' | 'groups' | 'pr' | 'mail';

/** 각본·화면 사본이 있는 언어. 그 밖의 언어는 영어로 본다 */
export type DemoLocale = 'en' | 'ko';

export function demoLocale(locale: string): DemoLocale {
  return locale === 'ko' ? 'ko' : 'en';
}

/** 떠 온 화면의 주소. 영어판은 `index.html`, 한국어판은 `index.ko.html` 이다 */
export function pageSrc(locale: DemoLocale): Record<SitePage, string> {
  const file = locale === 'ko' ? 'index.ko.html' : 'index.html';
  return {
    map: `/demo/nulnul-map/${file}`,
    inbox: `/demo/team-inbox/${file}`,
    groups: `/demo/team-groups/${file}`,
    pr: `/demo/team-pr/${file}`,
    mail: `/demo/mail/${file}`,
  };
}

/**
 * 고객 쪽 화면인가 — 화면 위 배지(「고객 화면」/「팀 화면」)가 이걸로 갈린다.
 * `map`(널널투어)과 `mail`(방문자가 받은 메일) 둘이 고객 쪽이다.
 *
 * ⚠️ **위젯이 뜨는 화면과는 다르다.** 위젯은 `map` 에만 뜬다 — 메일함 위에 챗봇이 떠 있으면
 *    말이 안 된다. 그 판단은 `SiteStage` 가 `page === 'map'` 으로 따로 한다.
 */
export function isCustomerPage(page: SitePage): boolean {
  return page === 'map' || page === 'mail';
}

export interface Msg {
  who: 'me' | 'ai';
  text: string;
  /** 「반영됐어요」 카드. 루프가 닫혔을 때만 붙는다 */
  card?: boolean;
}

/** 「화면에서 선택하기」로 실제로 집은 자리. 누른 요소를 재서 넣는다 */
export interface Picked {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface Scene {
  page: SitePage;
  widgetOpen: boolean;
  /** 입력칸에 «쓰이는 중»인 글. 전송하면 빈다 */
  draft: string;
  msgs: Msg[];
  /** AI 가 답을 쓰는 중 — 점 세 개 */
  thinking: boolean;
  /** 「화면에서 선택하기」 도구가 켜졌나 */
  picking: boolean;
  /** 실제로 집은 자리. 각본이 아니라 사람이 누른 결과가 들어온다 */
  picked: Picked | null;
  /** 그 화면 조각이 제보에 첨부됐나 */
  attached: boolean;
  /** 보낸 사람에게 「반영됐어요」가 갔나 — 루프가 닫혔다는 표시 */
  returned: boolean;
}

export const INITIAL: Scene = {
  page: 'map',
  widgetOpen: false,
  draft: '',
  msgs: [],
  thinking: false,
  picking: false,
  picked: null,
  attached: false,
  returned: false,
};

// ── 무엇을 누르게 할 것인가 ──────────────────────────────────

/**
 * 반짝이는 링을 씌울 자리.
 * `frame` 쪽은 떠 온 화면 «안»이라 **글자로 찾는다** — 클래스 이름은 빌드마다 바뀌지만
 * 화면에 보이는 말은 안 바뀐다. 못 찾으면 그 단계는 「계속 보기」 버튼으로 넘어간다(막히지 않게).
 */
export type Target =
  | { where: 'widget'; id: 'fab' | 'input' | 'pick' | 'card' }
  /**
   * 화면에 보이는 그 «글자»를 찾아 링을 씌운다. 여러 개를 주면 **실제로 보이는 첫 번째**를 쓴다 —
   * 폭에 따라 다른 것을 보여주는 화면이 있어서, 후보를 안 두면 좁은 화면에서 링이 빈 곳을 두른다.
   */
  | { where: 'frame'; text: string[] }
  /**
   * 「화면에서 선택하기」가 켜진 단계. 화면 아무 데나가 아니라 **지정한 그것만** 집을 수 있고,
   * 그 자리는 초록으로 반짝여서 어디를 눌러야 하는지 눈에 띈다(ny 지적 2026-09-18).
   */
  | { where: 'frame-pick'; text: string[] }
  /**
   * 한 화면에서 **여러 줄을 한꺼번에** 짚는 단계(「이 셋이 같은 문제예요」). 준 글자마다 하나씩
   * 블록이 켜지고, 그중 아무거나 누르면 다음으로 간다. 하나라도 화면에 없으면 그 단계는
   * 버튼으로 넘어간다 — `__tests__/demo-sandbox.test.ts` 가 셋 다 있는지 먼저 잡는다.
   */
  | { where: 'frame-many'; text: string[] };

export interface Frame {
  after: number;
  patch: Partial<Scene> | ((s: Scene) => Partial<Scene>);
}

export interface Step {
  key: string;
  /**
   * 이 단계가 서 있는 화면. **단계가 현재가 되는 순간** iframe 이 여기로 바뀐다.
   *
   * 🔴 화면 바꾸기를 `frames` 에 두면 안 된다 — `frames` 는 버튼을 «누른 뒤»에 도는데
   *    사이드 패널의 설명은 «누르기 전»에 읽힌다. 그래서 「팀 편지함에 쌓였어요」를 읽는 동안
   *    오른쪽은 아직 고객 화면이고, 편지함이 뜬 뒤엔 벌써 다음 단계 설명이 떠 있었다.
   *    설명·링·화면이 한 칸씩 어긋나던 원인이 이거다(2026-09-18).
   */
  page: SitePage;
  /** 사이드 패널 제목 */
  title: string;
  /** 단계 목록에 쓰는 짧은 이름 */
  short: string;
  /**
   * ⚠️ 설명 문단은 **없다.** 길게 썼다가(ny 「너무 길다」) 불릿 두 줄로 줄였다가
   *    결국 통째로 뺐다(ny 2026-09-18 「그냥 아예 2줄 불릿도 다 없애자」).
   *    패널은 **제목 하나**만 말하고, 「지금 뭘 누르라는지」는 화면 위 말풍선(`hint`·`spot.say`)이
   *    말한다 — 왼쪽에서 읽고 오른쪽에서 찾는 왕복이 사라진다.
   *    되살리려면 `__tests__/demo-sandbox.test.ts` 의 「패널은 제목만 말한다」도 같이 고쳐야 한다.
   */
  /** 링 옆에 붙는 짧은 지시 */
  hint: string;
  /** 누를 곳. null 이면 누를 것이 없는 단계라 버튼으로 넘긴다 */
  target: Target | null;
  /**
   * 누를 것은 없지만 **눈이 가야 하는 자리**. 팀 화면에서 쓴다 — 진짜 운영자 화면은 넓어서
   * 안내만 읽어서는 어디를 보라는 건지 모른다(ny 「단계별 하이라이트로 놓치는 부분이 없게」).
   *
   * `grow` — 찾은 «글자»에서 **그 글자를 품은 칸까지 올라가서** 두른다(CSS 선택자).
   * 제목 세 글자만 두르면 「그래서 무엇이 어떻게 됐다는 건가」가 안 보이는 자리가 있다
   * (ny 2026-09-18 「빨간 박스는 이 아래쪽 섹션을 둘러싸는 게 더 나을 것 같아, 『반영 알림』 말고」).
   * 글자로 찾는 것은 그대로다 — 클래스 이름에 기대지 않는다. 찾은 뒤 한 칸 올라갈 뿐이다.
   * 못 올라가면(선택자에 맞는 조상이 없으면) 찾은 그 글자를 두른다 — 조용히 막히지 않는다.
   */
  spot?: { text: string[]; say: string; grow?: string };
  /** target 이 없을 때 버튼에 쓸 말 */
  label?: string;
  /** 누른 «뒤»에 알아서 재생되는 것 */
  frames: Frame[];
}

/** 글자가 하나씩 쓰이는 프레임을 만든다. 사람이 타이핑하는 속도로 보이게 */
function type(text: string, msPerChar: number): Frame[] {
  // `[...text]` 는 코드포인트로 세는데 `slice` 는 UTF-16 으로 자른다 — 둘을 섞으면
  // 이모지가 하나만 들어와도 끝 글자가 잘린다. 잘라낸 배열을 그대로 이어 붙인다.
  const chars = [...text];
  return chars.map((_, i) => ({
    after: msPerChar,
    patch: { draft: chars.slice(0, i + 1).join('') },
  }));
}

/** AI 답이 «쓰이는» 것처럼 보이게 마지막 말풍선의 글자를 늘린다 */
function stream(text: string, msPerChar: number): Frame[] {
  const chars = [...text];
  return chars.map((_, i) => ({
    after: msPerChar,
    patch: (s: Scene) => {
      const last = s.msgs.at(-1);
      // 각본 순서를 바꾸다 말풍선 없이 stream 이 돌면 who 없는 빈 말풍선이 «조용히» 생긴다
      if (!last) return {};
      return { msgs: [...s.msgs.slice(0, -1), { ...last, text: chars.slice(0, i + 1).join('') }] };
    },
  }));
}

// ── 각본에 쓰이는 말 ─────────────────────────────────────────
//
// 말(문구)은 언어별 파일 `script.en.ts` · `script.ko.ts` 에 있고, 이 파일은 **구조**(어느 화면에서
// 무엇을 누르고 무엇을 재생하나)만 갖는다. 구조를 언어마다 따로 두면 한쪽만 고치는 일이 생긴다.
//
// 영어판은 한국어판의 직역이 아니다 — 같은 사건(제휴 가게 쿠폰이 안 받아진다)을 영어권 심사위원이
// 바로 읽도록 새로 썼다. 떠 온 화면(`public/demo/*/index.html`)의 글자와 «한 글자도» 같아야 짚을 자리를 찾는다.

/** 한 단계의 문구 */
export interface StepCopy {
  /** 사이드 패널 제목 */
  title: string;
  /** 단계 목록에 쓰는 짧은 이름 */
  short: string;
  /** 링 옆에 붙는 짧은 지시 */
  hint: string;
  /** 누를 것이 없을 때 버튼에 쓸 말 */
  label?: string;
  /** 팀 화면 «보는 자리» 말풍선 */
  say?: string;
}

export interface ScriptCopy {
  hello: string;
  /** 제보 한 줄 */
  report: string;
  reply: string;
  fixed: string;
  /** 팀 화면 3장에 보이는 묶음 제목. 연습용 데이터와 한 글자도 어긋나면 안 된다 */
  groupTitle: string;
  /** 「이 셋이 같은 문제예요」로 짚는 편지함 세 줄. 첫 줄은 `say` */
  similar: readonly [string, string, string];
  /** 「화면에서 선택하기」로 집는 버튼의 글자 */
  couponButton: string;
  /** 「PR #128」 줄 두 개 */
  prLines: [string, string];
  /** 되돌림을 받은 사람 줄 두 개(9단계) */
  recipients: [string, string];
  /** 되돌림 목록에서 «전달됨» 에 해당하는 글자 */
  delivered: string;
  /** 메일 제목 줄 */
  mailSubject: string;
  urls: Record<SitePage, string>;
  steps: Record<'open' | 'write' | 'tool' | 'point' | 'arrive' | 'similar' | 'group' | 'pr' | 'merge' | 'returned' | 'mail', StepCopy>;
}

export interface Script {
  STEPS: Step[];
  SAY: string;
  SIMILAR_SAYS: readonly string[];
  PAGE_SRC: Record<SitePage, string>;
  PAGE_URL: Record<SitePage, string>;
  /** 건너뛰어 왔을 때 집은 것으로 채울 이름 */
  POINT_LABEL: string;
  /** 각본이 «알아서 재생»하는 시간의 합. 단계 사이에 사람이 버튼을 누르는 시간은 안 들어 있다 */
  TOTAL_MS: number;
}

function buildSteps(c: ScriptCopy): Step[] {
  const s = c.steps;
  return [
    {
      key: 'open',
      page: 'map',
      title: s.open.title,
      short: s.open.short,
      hint: s.open.hint,
      target: { where: 'widget', id: 'fab' },
      frames: [
        { after: 300, patch: { widgetOpen: true } },
        { after: 500, patch: (sc) => ({ msgs: [...sc.msgs, { who: 'ai', text: '' }] }) },
        ...stream(c.hello, 16),
      ],
    },
    {
      key: 'write',
      page: 'map',
      title: s.write.title,
      short: s.write.short,
      hint: s.write.hint,
      target: { where: 'widget', id: 'input' },
      frames: [
        { after: 400, patch: {} },
        ...type(c.report, 70),
        { after: 600, patch: (sc) => ({ draft: '', msgs: [...sc.msgs, { who: 'me', text: c.report }] }) },
        { after: 600, patch: { thinking: true } },
        { after: 1500, patch: (sc) => ({ thinking: false, msgs: [...sc.msgs, { who: 'ai', text: '' }] }) },
        ...stream(c.reply, 18),
      ],
    },
    {
      key: 'tool',
      page: 'map',
      title: s.tool.title,
      short: s.tool.short,
      hint: s.tool.hint,
      target: { where: 'widget', id: 'pick' },
      frames: [{ after: 300, patch: { picking: true } }],
    },
    {
      key: 'point',
      page: 'map',
      title: s.point.title,
      short: s.point.short,
      hint: s.point.hint,
      target: { where: 'frame-pick', text: [c.couponButton] },
      // 집은 자리(`picked`)는 사람이 누른 결과라 각본이 아니라 `SiteStage` 가 넣는다
      frames: [{ after: 900, patch: { picking: false, attached: true } }],
    },
    {
      key: 'arrive',
      page: 'inbox',
      title: s.arrive.title,
      short: s.arrive.short,
      hint: '',
      target: null,
      spot: { text: [c.report], say: s.arrive.say ?? '' },
      label: s.arrive.label,
      frames: [],
    },
    {
      key: 'similar',
      page: 'inbox',
      title: s.similar.title,
      short: s.similar.short,
      // 🔴 이 단계가 「묶기」의 전부다. 편지함에서 묶음 화면으로 그냥 갈아 끼우면 「점프처럼 보인다」(ny 2026-09-18).
      //    묶이는 «근거»를 같은 화면에서 먼저 보여준다.
      hint: s.similar.hint,
      target: { where: 'frame-many', text: [...c.similar] },
      label: s.similar.label,
      frames: [],
    },
    {
      key: 'group',
      page: 'groups',
      title: s.group.title,
      short: s.group.short,
      hint: '',
      target: null,
      spot: { text: [c.groupTitle], say: s.group.say ?? '' },
      label: s.group.label,
      frames: [],
    },
    {
      key: 'pr',
      page: 'pr',
      title: s.pr.title,
      short: s.pr.short,
      // 사람이 하는 일은 «없다»는 것을 문장에서 분명히 한다(ny 2026-09-18 4차)
      hint: '',
      target: null,
      spot: { text: [...c.prLines], say: s.pr.say ?? '' },
      label: s.pr.label,
      frames: [],
    },
    {
      key: 'merge',
      page: 'pr',
      title: s.merge.title,
      short: s.merge.short,
      hint: '',
      target: null,
      // 🔴 두르는 것은 제목이 아니라 **그 아래 «받은 사람 목록»** 이다(ny 2026-09-18 5차). `grow` 는 위로만
      //    올라가므로 제목에서는 옆 형제인 목록에 닿을 수 없다 — 목록 «안»의 한 줄을 찾아 그 줄의 목록(`ul`)으로 올라간다.
      // ⚠️ 한 줄로 붙여 쓴다 — 「설명 문단이 되살아났나」 검사가 줄 첫머리의 `say:` 를 본다.
      spot: { text: [...c.recipients], grow: 'ul', say: s.merge.say ?? '' },
      label: s.merge.label,
      // 🔴 되돌림 카드는 **여기서** 만들어야 한다. `frames` 는 그 단계를 «떠날 때» 도는데, 다음 단계의
      //    `page` 는 그 직후에 적용된다 — 카드를 다음 단계의 frames 에 두면 뜨자마자 메일함에 덮여 안 보인다.
      frames: [
        { after: 1300, patch: { page: 'map' } },
        { after: 900, patch: (sc) => ({ returned: true, msgs: [...sc.msgs, { who: 'ai', text: c.fixed, card: true }] }) },
      ],
    },
    {
      key: 'returned',
      page: 'map',
      title: s.returned.title,
      short: s.returned.short,
      hint: s.returned.hint,
      target: { where: 'widget', id: 'card' },
      frames: [],
    },
    {
      key: 'mail',
      page: 'mail',
      title: s.mail.title,
      short: s.mail.short,
      // 🔴 이 화면의 본문은 «프로덕션에서 진짜 메일을 만드는 그 함수»가 만든 것이다
      //    (`scripts/render-demo-mail.ts` → `renderLoopClosedEmail`). 손으로 그린 화면이 아니다.
      hint: '',
      target: null,
      // 제목 줄을 짚는다 — 「보낸사람 · 받는사람」 머리글이 화면에 같이 남아 「이건 메일이다」가 읽힌다.
      spot: { text: [c.mailSubject, c.groupTitle], say: s.mail.say ?? '' },
      label: s.mail.label,
      frames: [],
    },
  ];
}

const cache: Partial<Record<DemoLocale, Script>> = {};

/** 그 언어의 각본. 언어마다 한 번만 만든다 */
export function getScript(locale: string): Script {
  const l = demoLocale(locale);
  const hit = cache[l];
  if (hit) return hit;
  const c = l === 'ko' ? koCopy : enCopy;
  const STEPS = buildSteps(c);
  const script: Script = {
    STEPS,
    SAY: c.report,
    SIMILAR_SAYS: c.similar,
    PAGE_SRC: pageSrc(l),
    PAGE_URL: c.urls,
    POINT_LABEL: c.couponButton,
    TOTAL_MS: STEPS.reduce((sum, a) => sum + a.frames.reduce((n, f) => n + f.after, 0), 0),
  };
  cache[l] = script;
  return script;
}

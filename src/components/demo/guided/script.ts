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

// ── 화면 상태 ────────────────────────────────────────────────

/**
 * iframe 이 지금 띄우고 있는 화면.
 * `map` 하나만 고객 화면이고 나머지 셋은 **우리 앱의 진짜 운영자 화면**이다.
 */
export type SitePage = 'map' | 'inbox' | 'groups' | 'pr' | 'mail';

export const PAGE_SRC: Record<SitePage, string> = {
  map: '/demo/nulnul-map/index.html',
  inbox: '/demo/team-inbox/index.html',
  groups: '/demo/team-groups/index.html',
  pr: '/demo/team-pr/index.html',
  mail: '/demo/mail/index.html',
};

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

/** 화면 위에 적는 주소. 「이건 웹사이트다」를 한눈에 */
export const PAGE_URL: Record<SitePage, string> = {
  map: 'nulnul.vercel.app/nationwide',
  inbox: 'ai-feedloop.vercel.app/inbox',
  groups: 'ai-feedloop.vercel.app/dashboard',
  pr: 'ai-feedloop.vercel.app/monitor',
  mail: 'sujin@example.com 의 메일함',
};

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

const HELLO = '안녕하세요! 널널투어예요. 쿠폰이나 예약에서 불편한 점 있으면 편하게 남겨주세요.';

/**
 * 제보 한 줄. **ny 가 직접 정한 문장**이다(2026-09-18). 전국 지도에서 제휴 가게 쿠폰을
 * 받으려다 안 되는 상황 — 떠 온 화면에 「쿠폰 받기」 버튼이 실제로 있어서 각본이 성립한다.
 * 팀 화면 3장의 연습용 데이터도 같은 사건으로 맞춰 뒀다(`src/lib/demo/mock-data.ts`).
 */
export const SAY = '쿠폰 다운로드가 잘 안됩니다';

/**
 * AI 즉답. **모르는 것을 지어내지 않는 것**이 이 제품의 주장이라, 각본에서도
 * 원인을 단정하지 않고 「팀에 넘겼다」로 끝낸다. 실제 봇도 그렇게 답한다
 * (`src/lib/bot/holding.ts` 의 정직 중단).
 */
const REPLY =
  '불편하셨겠어요. 「쿠폰 받기」가 안 되는 문제로 접수했어요. 원인은 제가 짐작하지 않고 팀에 그대로 넘길게요 — 고쳐지면 이 대화창으로 알려드릴게요.';

const FIXED = '말씀하신 쿠폰 받기, 고쳐서 올렸어요. 이제 제휴 가게 쿠폰이 바로 받아집니다.';

/** 팀 화면 3장에 보이는 묶음 제목. 연습용 데이터와 한 글자도 어긋나면 안 된다 */
const GROUP_TITLE = '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음';

/**
 * 「비슷한 제보 묶기」 단계에서 **편지함 목록에서 한꺼번에 짚는 세 줄.**
 *
 * 왜 이 셋인가 — 떠 온 묶음 화면이 「피드백 4건 · 3명이 말했어요」라고 말한다. 그 3명이 이들이고,
 * 세 줄은 `src/lib/demo/mock-data.ts` 의 편지함 대화 `demo-conv-1`·`4`·`5` 와 **한 글자도 같아야**
 * 한다(안 그러면 짚을 자리를 못 찾아 그 단계가 버튼으로 넘어가 버린다). 첫 줄은 방금 사람이
 * 직접 남긴 그 한마디(`SAY`)라 「내가 낸 것도 여기 섞였다」가 읽힌다.
 *
 * ⚠️ 한때 이걸 «날아와 포개지는 카드 3장»으로 그렸다가 걷어냈다 — ny 「스무스하고 직관적이지가
 *    않다」(2026-09-18). 움직이는 카드 대신 **화면에 이미 있는 그 줄들**을 블록으로 짚는다.
 *    보는 사람이 「아, 저것들이 같은 얘기구나」를 자기 눈으로 확인하게 된다.
 */
export const SIMILAR_SAYS: readonly string[] = [
  SAY,
  '쿠폰 받기를 눌러도 아무 반응이 없어요',
  '제휴 가게 쿠폰이 발급되지 않습니다',
];

export const STEPS: Step[] = [
  {
    key: 'open',
    page: 'map',
    title: '오른쪽 아래 챗봇 버튼',
    short: '챗봇 열기',
    hint: '이 버튼을 눌러보세요',
    target: { where: 'widget', id: 'fab' },
    frames: [
      { after: 300, patch: { widgetOpen: true } },
      { after: 500, patch: (s) => ({ msgs: [...s.msgs, { who: 'ai', text: '' }] }) },
      ...stream(HELLO, 16),
    ],
  },
  {
    key: 'write',
    page: 'map',
    title: '불편한 점을 그대로 씁니다',
    short: '불편한 점 한마디 남기기',
    hint: '입력칸을 눌러보세요',
    target: { where: 'widget', id: 'input' },
    frames: [
      { after: 400, patch: {} },
      ...type(SAY, 70),
      { after: 600, patch: (s) => ({ draft: '', msgs: [...s.msgs, { who: 'me', text: SAY }] }) },
      { after: 600, patch: { thinking: true } },
      { after: 1500, patch: (s) => ({ thinking: false, msgs: [...s.msgs, { who: 'ai', text: '' }] }) },
      ...stream(REPLY, 18),
    ],
  },
  {
    key: 'tool',
    page: 'map',
    title: '말로 옮기지 않아도 됩니다',
    short: '화면에서 선택하기 켜기',
    // ny 가 정한 소개 문장(2026-09-18 4차) — 「문제가 있는 부분을 정확히 선택해서 문의를 남길 수 있어요」.
    // 말풍선은 한 줄이라 이 문장이 다 안 들어간다. 값어치는 여기서 말하고, 말풍선은 짧게 짚기만 한다.
    hint: '여기를 눌러보세요',
    target: { where: 'widget', id: 'pick' },
    frames: [{ after: 300, patch: { picking: true } }],
  },
  {
    key: 'point',
    page: 'map',
    title: '문제가 있는 부분을 그대로 집어요',
    short: '문제 지점 직접 집기',
    hint: '안 되는 버튼을 집어보세요',
    target: { where: 'frame-pick', text: ['쿠폰 받기'] },
    // 집은 자리(`picked`)는 사람이 누른 결과라 각본이 아니라 `SiteStage` 가 넣는다
    frames: [{ after: 900, patch: { picking: false, attached: true } }],
  },
  {
    key: 'arrive',
    page: 'inbox',
    title: '같은 순간, 팀의 편지함',
    short: '팀 편지함에 도착·분류',
    hint: '',
    target: null,
    spot: { text: [SAY], say: '사용자가 남긴 피드백' },
    label: '같은 말을 한 사람이 또 있는지 볼게요',
    frames: [],
  },
  {
    key: 'similar',
    page: 'inbox',
    title: '같은 말을 한 사람이 또 있었습니다',
    short: '비슷한 제보 찾기',
    // 🔴 이 단계가 「묶기」의 전부다. 예전엔 편지함에서 묶음 화면으로 그냥 갈아 끼웠는데
    //    ny 가 「점프처럼 보인다」고 했다(2026-09-18). 묶이는 «근거»를 같은 화면에서 먼저 보여준다.
    hint: '이 셋이 같은 문제예요',
    target: { where: 'frame-many', text: [...SIMILAR_SAYS] },
    label: '이 셋이 어떻게 묶이는지 볼게요',
    frames: [],
  },
  {
    key: 'group',
    page: 'groups',
    title: '한 묶음이 되면 넘기기 어려워집니다',
    short: '한 묶음으로 묶기',
    hint: '',
    target: null,
    spot: { text: [GROUP_TITLE], say: '하나의 피드백으로 묶입니다' },
    label: '이 묶음이 코드로 가는 걸 볼게요',
    frames: [],
  },
  {
    key: 'pr',
    page: 'pr',
    title: '고치는 초안까지 AI 가 씁니다',
    short: 'AI 가 수정안 만들기',
    // ny 지적(2026-09-18 4차) — 「내가 직접 수정을 하는 것처럼 보이기도 한다」.
    // 여기서 사람이 하는 일은 «없다»는 것을 문장에서 분명히 한다.
    hint: '',
    target: null,
    spot: { text: ['GitHub 에서 PR #128 보기', 'PR #128 · 47초 · 파일 2개'], say: 'AI가 자동으로 개선해 승인을 요청해요' },
    label: '사람이 할 일이 뭔지 볼게요',
    frames: [],
  },
  {
    key: 'merge',
    page: 'pr',
    title: '사람이 하는 일은 하나 — 반영 여부',
    short: '반영은 사람이 결정',
    hint: '',
    target: null,
    // ⚠️ ny 문장은 「피드백 준 유저에게 반영 사실이 자동으로 전달됩니다」였는데, 390px 에서
    //    말풍선이 넉 줄로 접혀 화면을 덮었다(다른 말풍선의 두 배). 「반영 사실이」를 덜었다 —
    //    그 말은 짚고 있는 대상과 제목이 이미 하고 있다.
    //
    // 🔴 두르는 것은 「반영 알림」 세 글자가 아니라 **그 아래 «받은 사람 목록»** 이다
    //    (ny 2026-09-18 5차 「빨간 박스는 이 아래쪽 섹션을 둘러싸는 게 더 나을 것 같아, 『반영 알림』 말고」).
    //    제목만 두르면 「알림이 나갔다」는 말뿐이고, 정작 **누구에게 갔는지**(이수진 · 방문자 둘 ·
    //    전달됨/대기)가 박스 밖에 남는다. 목록째 두르면 세 줄이 박스 «안»에 들어와 이 단계의
    //    주장이 화면에서 증명된다.
    //
    // ⚠️ 그래서 짚는 «글자»가 제목이 아니라 **목록 안의 한 줄**이다 — `grow` 는 위로만 올라가므로
    //    제목(`h3`)에서는 옆 형제인 목록(`ul`)에 닿을 수 없다. 한 줄을 찾아 그 줄의 목록으로 올라간다.
    //    후보를 둘 두는 건 한 줄이 사라져도 같은 목록에 닿게 하기 위해서다.
    //
    // 🔴 제목 칸(`section`)째 두르는 것을 먼저 해 봤고 **390px 에서 안 들어갔다** — 그 칸은 좁은
    //    화면에서 339px 인데 떠 온 화면의 고정 헤더 아래 남는 자리가 330px 라 9px 이 잘렸다.
    //    목록만이면 어느 폭에서나 194px 라 넉넉히 들어간다(2026-09-18 실측).
    // ⚠️ 한 줄로 붙여 쓴다 — 「설명 문단(`say:`)이 되살아났나」 검사가 줄 첫머리의 `say:` 를 보는데,
    //    줄바꿈해서 쓰면 «말풍선» 문구가 그 검사에 걸린다(다른 것을 지키는 검사다).
    spot: { text: ['이수진', '방문자 #b7c4'], grow: 'ul', say: '피드백 준 유저에게 자동으로 전달돼요' },
    label: '반영하고, 보낸 사람에게 알릴게요',
    // 🔴 되돌림 카드는 **여기서** 만들어야 한다. `frames` 는 그 단계를 «떠날 때» 도는데,
    //    다음 단계의 `page` 는 그 직후에 적용된다 — 카드를 다음 단계의 frames 에 두면
    //    뜨자마자 그다음 화면(메일함)에 덮여 한 프레임도 안 보인다(2026-09-18 실측).
    //    그래서 여기서 고객 화면으로 돌아가 카드를 띄우고, 다음 단계는 같은 화면에 서 있는다.
    frames: [
      { after: 1300, patch: { page: 'map' } },
      { after: 900, patch: (s) => ({ returned: true, msgs: [...s.msgs, { who: 'ai', text: FIXED, card: true }] }) },
    ],
  },
  {
    key: 'returned',
    page: 'map',
    title: '보낸 말이 대화창으로 돌아옵니다',
    short: '대화창에 「반영됐어요」',
    hint: '반영 내용은 채팅으로도 전달됩니다',
    target: { where: 'widget', id: 'card' },
    frames: [],
  },
  {
    key: 'mail',
    page: 'mail',
    title: '메일로도 한 번 더 갑니다',
    short: '메일함에도 도착',
    // 🔴 이 화면의 본문은 «프로덕션에서 진짜 메일을 만드는 그 함수»가 만든 것이다
    //    (`scripts/render-demo-mail.ts` → `renderLoopClosedEmail`). 손으로 그린 화면이 아니다.
    hint: '',
    target: null,
    // 제목 줄을 짚는다 — 그래야 「보낸사람 · 받는사람」 머리글이 화면에 같이 남아
    // 「이건 메일이다」가 한눈에 읽힌다(본문 히어로를 짚으면 머리글이 위로 밀려 나간다).
    // ⚠️ 제목은 `src/lib/email/templates.ts` 가 정한다 — 거기가 바뀌면 이 줄도 같이 바뀌어야
    //    하고, 그걸 「짚는 자리가 떠 온 화면에 실제로 있는가」 검사가 잡는다.
    spot: { text: ['[널널투어] 말씀하신 문제를 고쳤어요', GROUP_TITLE], say: '이메일로도 전달됩니다' },
    label: '여기까지가 한 바퀴예요',
    frames: [],
  },
];

/**
 * 각본이 «알아서 재생»하는 시간의 합. 단계 사이에 사람이 버튼을 누르는 시간은 안 들어 있다.
 * 팀 화면 단계들이 재생이 아니라 **화면 전환**으로 바뀐 뒤(2026-09-18) 이 합은 줄었다.
 */
export const TOTAL_MS = STEPS.reduce((sum, a) => sum + a.frames.reduce((n, f) => n + f.after, 0), 0);

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { getScript, isCustomerPage, type Picked, type Scene, type SitePage, type Step, type Target } from './script';
import { Widget, type WidgetPart } from './Widget';

/**
 * 오른쪽 무대 — **떠 온 화면 넉 장**을 겹쳐 두고 그 위에 게임 튜토리얼을 얹는다.
 *   · 고객 쪽 1장: 널널투어 전국 지도(`public/demo/nulnul-map/`)
 *   · 팀 쪽 3장: 우리 앱의 진짜 편지함·피드백 묶음·수정 PR(`public/demo/team-*`)
 *
 * 핵심은 **같은 오리진**이라는 것이다. 실서비스를 그대로 띄우면 우리가 그 안의 DOM 을 만질 수
 * 없어서, 눌러야 할 버튼에 링을 씌우지도 다른 곳을 막지도 못한다. 사본은 우리 `public/` 에
 * 있으니 `contentDocument` 가 열린다. 그래서 이 네 가지가 된다:
 *   ① 눌러야 할 곳에 반짝이는 링 + 나머지는 어둡게
 *   ② **그 버튼 말고는 아예 안 눌리게** 막기(`pointer-events` 를 iframe 안에 주입)
 *   ③ 「화면에서 선택하기」가 진짜로 — 사람이 누른 요소를 실제로 재서 붙인다
 *   ④ 팀 화면처럼 넓은 화면에서 **지금 봐야 하는 자리**만 밝히기
 *
 * ⚠️ 넉 장을 **한꺼번에 띄워 두고 투명도로 바꾼다.** 한 장씩 갈아 끼우면 새 문서를 받는 동안
 *    흰 화면이 번쩍이고 스크롤 자리도 잃는다(ny 「화면 전환이 뚝뚝 끊긴다」 2026-09-18).
 *    겹쳐 두면 전환이 0.3초 페이드 하나로 끝나고, 돌아왔을 때 보던 자리가 그대로다.
 *
 * ⚠️ 사본에는 스크립트가 없다(캡처할 때 걷어냈다). 그래서 링크를 눌러도 저절로 이동하지 않는다.
 *    이동은 우리가 각본대로 시킨다(`scene.page`). 이게 오히려 안전하다 — 튜토리얼이 정한 길
 *    밖으로 샐 수가 없다.
 */

interface Props {
  scene: Scene;
  /** 지금 눌러야 하는 곳 */
  target: Target | null;
  hint: string;
  /** 누를 것은 없지만 눈이 가야 하는 자리 */
  spot: Step['spot'] | null;
  /** 고객 화면 → 팀 화면으로 넘어가는 순간. 「제보가 전달된다」를 잠깐 보여준다 */
  handoff: boolean;
  onHit: () => void;
  onPick: (p: Picked) => void;
  /** 화면 안에서 짚을 곳을 못 찾았다고 부모에게 알린다 — 그 단계는 버튼으로 넘긴다 */
  onTargetMissing: () => void;
  /** 선택 모드의 「취소」 — 실물 위젯에도 있는 버튼이라 같이 둔다 */
  onSkip: () => void;
}

/**
 * 널널투어 봇의 강조색. 「화면에서 선택하기」의 하이라이트는 실물에서 이 색으로 그려진다
 * (`public/widget-pick.js` 의 `opts.accent`). 코랄로 그리면 실제와 다른 화면이 된다.
 */
const ACCENT = '#408D66';

/** `#rrggbb` → `rgba(...)`. widget-pick.js 와 같은 방식 */
function rgba(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(242,100,92,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * iframe 안에 심는 CSS.
 *   · `fl-gate` — 「지금 눌러야 하는 것」 말고는 전부 못 누르게
 *   · `fl-pickmode` — 선택 모드. 집을 수 있는 그것만 십자 커서
 *   · `fl-shine` — 집어야 할 그 자리가 스스로 반짝인다(hover 없이도 보이게)
 */
const GATE_CSS = `
  html.fl-gate, html.fl-gate * { pointer-events: none !important; }
  html.fl-gate .fl-hit, html.fl-gate .fl-hit * { pointer-events: auto !important; cursor: pointer !important; }
  /* 선택 모드는 gate 를 걷는다 — **어디에 올려도 초록으로 켜져야** 「여러 군데를 집을 수 있구나」를
     안다(ny 2026-09-18). 실제로 집히는 것은 fl-hit 하나뿐이고, 그건 클릭을 받아 거르는 쪽에서 정한다. */
  html.fl-pickmode, html.fl-pickmode * { pointer-events: auto !important; cursor: crosshair !important; }
  html.fl-gate, html.fl-pickmode { scroll-behavior: auto !important; }
  .fl-shine { border-radius: 8px; animation: flShine 1.5s ease-in-out infinite; }
  @keyframes flShine {
    0%, 100% { box-shadow: 0 0 0 0 rgba(64,141,102,.6), 0 0 0 2px rgba(64,141,102,.9); }
    55%      { box-shadow: 0 0 0 11px rgba(64,141,102,0), 0 0 0 2px rgba(64,141,102,.9); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-shine { animation: none; box-shadow: 0 0 0 2px rgba(64,141,102,.9); }
  }
`;

/** 눈에 보이나 — 폭에 따라 숨는 것이 있어서, 자리를 차지하는지까지 본다 */
function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8;
}

/**
 * 화면에 보이는 «글자»로 찾는다 — 클래스 이름은 빌드마다 바뀌지만 사람이 읽는 말은 안 바뀐다.
 * 후보를 여럿 받아 **보이는 첫 번째**를 돌려준다(좁은 화면에서 숨는 칸이 있다).
 */
function findByText(doc: Document, texts: string[]): HTMLElement | null {
  for (const text of texts) {
    const all = doc.querySelectorAll<HTMLElement>('a, button, [role="button"], span, div, p, li, h1, h2, h3, dt, dd');
    const hits: HTMLElement[] = [];
    all.forEach((el) => {
      if ((el.textContent ?? '').trim() === text && isVisible(el)) hits.push(el);
    });
    if (!hits.length) continue;
    // 같은 글자를 담은 조상들이 같이 걸린다 — 가장 «안쪽» 것을 고른 뒤 누를 수 있는 조상으로 올린다
    const inner = hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) ?? hits[0];
    const target = (inner.closest('a, button, [role="button"]') as HTMLElement | null) ?? inner;
    if (isVisible(target)) return target;
  }
  return null;
}

/**
 * 떠 온 화면 «자기» 고정 띠의 아랫변(프레임 기준 px). 위에 붙어 폭을 거의 다 차지하는 것만 띠로 본다 —
 * `clearStickyHeader` 가 쓰는 규칙과 같다. 두 군데가 다른 규칙을 쓰면 「비켜 준 만큼」이 어긋난다.
 */
function stickyBottom(doc: Document, frame: HTMLIFrameElement | null): number {
  const win = frame?.contentWindow;
  if (!win || !frame) return 0;
  let bottom = 0;
  for (const node of doc.querySelectorAll<HTMLElement>('body *')) {
    const pos = win.getComputedStyle(node).position;
    if (pos !== 'sticky' && pos !== 'fixed') continue;
    const b = node.getBoundingClientRect();
    if (b.top <= 4 && b.height > 0 && b.width > frame.clientWidth * 0.6) bottom = Math.max(bottom, b.bottom);
  }
  return bottom;
}

/**
 * 붙은 조각에 붙일 이름. 요소 안의 글자를 그냥 이어 붙이면 아랫줄 글까지 딸려 와
 * 「사용 가능한 쿠폰이 없어요한산…」처럼 말이 엉킨다 — 첫 줄만 쓰고 길면 자른다.
 */
function labelOf(el: HTMLElement, fallback: string): string {
  const first = (el.innerText ?? el.textContent ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return fallback;
  return first.length > 14 ? first.slice(0, 14) + '…' : first;
}

export function SiteStage({ scene, target, hint, spot, handoff, onHit, onPick, onTargetMissing, onSkip }: Props) {
  const tr = useTranslations('demo');
  const { PAGE_SRC, PAGE_URL } = getScript(useLocale());
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 화면 넉 장. 겹쳐 두고 투명도로 바꾼다 */
  const framesRef = useRef<Partial<Record<SitePage, HTMLIFrameElement | null>>>({});
  const widgetRef = useRef<HTMLDivElement>(null);
  /**
   * 링·말풍선·집은 네모의 «자리»는 state 로 두지 않고 DOM 에 직접 쓴다.
   * 효과 안에서 setState 를 동기로 부르면 렌더가 한 번 더 돌고 lint 가 에러로 잡는다
   * (앞선 판의 짚는 커서도 같은 이유로 이렇게 했다). 자리는 그릴 대상이지 상태가 아니다.
   */
  const ringRef = useRef<HTMLSpanElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  /** 고객 화면에서 팀 편지함으로 «건너가는» 우편물 */
  const mailRef = useRef<HTMLDivElement>(null);
  /** 「이 셋이 같은 문제예요」 — 한 화면에서 여러 줄을 한꺼번에 짚는 블록들 */
  const blocksRef = useRef<HTMLDivElement>(null);
  /** 선택 모드에서 «지금 가리키는» 요소를 두르는 박스와 그 이름표 */
  const hoverRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLSpanElement>(null);
  /** 리스너를 이미 단 문서들. 같은 문서에 두 번 달면 한 번 누른 게 두 번으로 센다 */
  const wiredRef = useRef(new WeakSet<Document>());
  /** iframe 이 뜨거나 안에서 스크롤될 때마다 올라간다 — 자리 재기를 다시 돌리는 방아쇠 */
  const [ready, setReady] = useState(0);
  /**
   * 「이 단계·이 화면·이 폭」으로 이미 스크롤을 보냈나.
   *
   * 🔴 iframe 안에서 스크롤이 일어날 때마다 자리를 다시 재는데(위 `ready`), 그때 스크롤을 또
   *    시키면 **부드러운 이동이 매 프레임 처음부터 다시 시작해 영영 도착하지 못한다.**
   *    자리 «재기»는 계속하되 자리 «보내기»는 단계마다 한 번만 한다.
   */
  const scrolledKey = useRef('');

  // 이벤트 리스너는 iframe 이 뜰 때 한 번만 붙인다. 최신 값은 ref 로 읽는다.
  // ⚠️ 렌더 중에 ref 를 건드리면 lint 가 에러로 잡는다(react-hooks/refs) — 효과에서 쓴다.
  const pieceFallback = tr('stage.pieceFallback');
  const live = useRef({ target, onHit, onPick, page: scene.page, spot, pieceFallback });
  useEffect(() => {
    live.current = { target, onHit, onPick, page: scene.page, spot, pieceFallback };
  });

  const wrapBox = () => wrapRef.current?.getBoundingClientRect() ?? new DOMRect();
  const curFrame = useCallback(() => framesRef.current[scene.page] ?? null, [scene.page]);

  /** 링과 말풍선을 그 자리에 놓는다. `null` 이면 감춘다 */
  const place = useCallback((box: Box | null, hintText: string, showRing = true, dim = true) => {
    const ring = ringRef.current;
    const bubble = hintRef.current;
    if (!ring || !bubble) return;
    if (!box) {
      ring.style.display = 'none';
      bubble.style.display = 'none';
      return;
    }
    // 🔴 링은 «둘레를 뺀 나머지를 9999px 어둡게» 칠한다. 선택 모드에서는 그 어둠이
    //    「여기 말고는 볼 것 없다」로 읽혀 여러 군데를 집을 수 있다는 걸 가린다(ny 지적).
    //    그때는 링을 끄고, 초록 반짝임과 말풍선만으로 어디를 누를지 알려 준다.
    ring.style.display = showRing ? 'block' : 'none';
    // 🔴 팀 화면에서는 어둡게 칠하지 않는다 — 운영자 화면은 넓고 읽을 것이 많은데 둘레를 빼고
    //    전부 누르면 **다른 데가 뭔지 파악이 안 된다**(ny 「도착 분류부터 반영까지는 배경을 어둡게
    //    안 만들면 어떨까? 다른 화면 파악이 너무 안됨」 2026-09-18). 링과 말풍선만으로 짚는다.
    ring.style.boxShadow = dim ? '0 0 0 9999px rgba(25,29,27,.45)' : 'none';
    ring.style.left = `${box.x - 6}px`;
    ring.style.top = `${box.y - 6}px`;
    ring.style.width = `${box.w + 12}px`;
    ring.style.height = `${box.h + 12}px`;
    const w = wrapRef.current?.clientWidth ?? 600;
    bubble.style.display = hintText ? 'block' : 'none';
    if (!hintText) return;

    // 🔴 말풍선 폭을 **재서** 가둔다. 예전엔 「가운데에서 ±70px」이라는 고정값으로 가뒀는데,
    //    그건 짧은 문구(「이 버튼을 눌러보세요」)를 재 본 값이었다. 문구가 길어지자 390px 에서
    //    **왼쪽이 화면 밖으로 잘려 첫 글자가 사라졌다**(ny 워딩 교체 뒤 실측 2026-09-18).
    //    한 줄로 도저히 안 들어가면 두 줄로 접는다 — 잘리는 것보다 접히는 게 낫다.
    bubble.style.whiteSpace = 'nowrap';
    bubble.style.maxWidth = '';
    if (bubble.offsetWidth > w - 16) {
      bubble.style.whiteSpace = 'normal';
      bubble.style.maxWidth = `${w - 16}px`;
    }
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;

    // 말풍선을 «위»에만 두면 바로 윗줄을 덮는다. 널널투어 쿠폰 목록처럼 **같은 이름의 버튼이
    // 세로로 여러 개** 있는 화면에서는 어느 것을 누르라는 건지 오히려 헷갈린다(2026-09-18 실측).
    // 옆에 «정말로» 들어갈 자리가 있으면 옆으로 비킨다.
    const room = box.x >= bw + 16;
    if (room) {
      bubble.style.left = `${box.x - 12}px`;
      bubble.style.top = `${box.y + box.h / 2}px`;
      bubble.style.transform = 'translate(-100%, -50%)';
    } else {
      const half = bw / 2;
      bubble.style.left = `${Math.max(half + 8, Math.min(box.x + box.w / 2, w - half - 8))}px`;
      bubble.style.top = `${box.y > bh + 16 ? box.y - bh - 12 : box.y + box.h + 12}px`;
      bubble.style.transform = 'translateX(-50%)';
    }
  }, []);

  /**
   * 선택 모드에서 가리키는 요소를 두른다. 치수·이름 규칙은 `public/widget-pick.js` 와 같다 —
   * 박스는 요소보다 2px 씩 크고, 이름표는 「태그 · 글자 40자」다. 실물과 다르게 그리면
   * 심사위원이 데모에서 본 것과 실제로 붙는 것이 달라진다.
   */
  const hover = useCallback((el: HTMLElement | null) => {
    const box = hoverRef.current;
    const tag = tagRef.current;
    if (!box || !tag) return;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const w = wrapRef.current?.getBoundingClientRect();
    const f = framesRef.current[live.current.page]?.getBoundingClientRect();
    if (!w || !f) return;
    const r = el.getBoundingClientRect();
    const b = { x: f.left - w.left + r.left, y: f.top - w.top + r.top, w: r.width, h: r.height };
    box.style.display = 'block';
    box.style.left = `${b.x - 2}px`;
    box.style.top = `${b.y - 2}px`;
    box.style.width = `${b.w + 4}px`;
    box.style.height = `${b.h + 4}px`;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const named = /[\p{L}\p{N}]/u.test(text) ? text : '';
    tag.textContent = el.tagName.toLowerCase() + (named ? ` · ${named}` : '');
  }, []);

  /**
   * 건너가는 장면들을 **도착지에 놓고**, 출발지까지의 거리를 CSS 변수로 준다.
   * 애니메이션은 그 거리에서 0 으로 날아온다 — 우편물은 위젯이 있던 오른쪽 아래에서
   * 「편지함에 쏙」, 제보 카드 셋은 서로 다른 세 자리에서 「한 자리에 포개짐」.
   * 도착지는 그 단계가 짚는 자리(편지함의 그 줄 · 묶음의 그 카드)라 폭이 달라도 같은 데로 간다.
   * 못 찾으면 화면 가운데로 보낸다(막히지 않게).
   */
  const placeMail = useCallback((box: Box | null) => {
    const el = mailRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const to = box
      ? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
      : { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
    // 출발지 = 위젯이 서 있던 오른쪽 아래 모서리
    const from = { x: wrap.clientWidth - 56, y: wrap.clientHeight - 56 };
    el.style.left = `${to.x}px`;
    el.style.top = `${to.y}px`;
    el.style.setProperty('--fl-dx', `${from.x - to.x}px`);
    el.style.setProperty('--fl-dy', `${from.y - to.y}px`);
  }, []);

  /**
   * 「이 셋이 같은 문제예요」 — 화면에 이미 있는 여러 줄에 한꺼번에 블록을 씌운다.
   *
   * 링은 «하나»를 두르는 물건이라 여기 못 쓴다. 미리 그려 둔 칸들을 자리마다 놓고 남는 것은
   * 감춘다(자리는 그릴 대상이지 상태가 아니다 — 위 머리주석과 같은 이유).
   * 하나씩 시차를 두고 켜져서 「하나… 둘… 셋, 이것들이 같은 얘기」로 읽힌다.
   */
  const placeBlocks = useCallback((boxes: Box[]) => {
    const host = blocksRef.current;
    if (!host) return;
    const cells = [...host.children] as HTMLElement[];
    cells.forEach((cell, i) => {
      const b = boxes[i];
      if (!b) {
        cell.style.display = 'none';
        return;
      }
      cell.style.display = 'block';
      cell.style.left = `${b.x - 4}px`;
      cell.style.top = `${b.y - 3}px`;
      cell.style.width = `${b.w + 8}px`;
      cell.style.height = `${b.h + 6}px`;
      cell.style.animationDelay = `${i * 260}ms`;
    });
  }, []);

  /** iframe 안 좌표 → 우리(부모) 좌표 */
  const toWrap = useCallback((r: DOMRect): Box => {
    const w = wrapBox();
    const f = framesRef.current[live.current.page]?.getBoundingClientRect() ?? new DOMRect();
    return { x: f.left - w.left + r.left, y: f.top - w.top + r.top, w: r.width, h: r.height };
  }, []);

  /**
   * 짚을 자리를 **챗봇 창에 안 가리는 곳으로** 끌어온다.
   *
   * 🔴 이게 없어서 한 판이 통째로 날아갔다 — 눌러야 할 버튼이 오른쪽 아래에 있으면 위젯 창
   *    (320×430)이 정확히 그 위를 덮어, ny 화면에서 「눌러도 반응이 없는 것처럼」 보였다
   *    (2026-09-18). 가운데 정렬만 하면 세로 가운데가 곧 위젯의 윗머리다.
   */
  const scrollIntoSafeArea = useCallback((el: HTMLElement) => {
    const frame = framesRef.current[live.current.page];
    const win = frame?.contentWindow;
    if (!frame || !win) return;
    // 🔴 `el.scrollIntoView()` 를 쓰면 안 된다. 브라우저는 그 요소가 보이도록 **위쪽 스크롤
    //    컨테이너를 전부** 움직이는데, 데모가 랜딩에 박히면서 «바깥 페이지»가 여기 포함됐다
    //    — 단계를 누를 때마다 랜딩이 통째로 끌려간다(팝업일 땐 막에 가려 안 드러났다).
    //    그래서 iframe «자기 창»만 직접 굴린다. 가운데 맞춤은 우리가 계산한다.
    {
      const r0 = el.getBoundingClientRect();
      win.scrollBy(0, r0.top - (frame.clientHeight - r0.height) / 2);
    }

    const f = frame.getBoundingClientRect();
    // 무대 위에 떠 있어 «짚을 자리를 가리는» 것들 — 위젯 창과 선택 모드의 띠
    // 🔴 챗봇 창은 **고객 화면(`map`)일 때만** 피할 것이다. 팀 화면에선 `visibility:hidden` 으로 꺼지지만
    //    `transition: visibility .3s` 라 넘어간 직후 0.3초는 아직 `visible` 로 읽힌다 — 아래의 visibility
    //    검사가 그 사이엔 못 거른다. 모바일에선 창이 폭을 다 덮어 X 가 겹치므로, 5단계 편지함 줄을
    //    창 «아래»(프레임 밖)로 밀어 스크롤이 0 으로 되돌아가고 링이 무대 바닥에 잘려 그려졌다
    //    (2026-09-23 실측: scrollBy +203 → −215). 데스크톱은 창이 오른쪽·목록이 왼쪽이라 안 드러났다.
    const guards = [
      live.current.page === 'map' ? widgetRef.current?.querySelector<HTMLElement>('[data-widget-panel]') : null,
      wrapRef.current?.querySelector<HTMLElement>('[data-pick-bar]'),
    ]
      .filter((g): g is HTMLElement => !!g)
      // 🔴 **안 보이는 것은 피할 것이 아니다.** 챗봇 창은 팀 화면에서 `visibility:hidden` 으로
      //    꺼지지만 자리는 그대로 차지한다 — `getBoundingClientRect()` 가 여전히 320×430 을 준다.
      //    그걸 피하려다 짚을 자리를 창 «밑»(화면 밖)으로 밀어내고, 그 자리를 누르면 무대 아래
      //    버튼 띠가 클릭을 먹어 단계가 안 넘어갔다(390px 7단계, 2026-09-18 실측).
      .filter((g) => g.getBoundingClientRect().height > 0 && win.getComputedStyle(g).visibility !== 'hidden')
      .map((g) => {
        const b = g.getBoundingClientRect();
        return { left: b.left - f.left, right: b.right - f.left, top: b.top - f.top, bottom: b.bottom - f.top };
      });

    const r = el.getBoundingClientRect();
    const overlapsX = (g: (typeof guards)[number]) => r.right > g.left - 12 && r.left < g.right + 12;
    const clash = guards.filter(overlapsX);
    if (!clash.length) return;

    // 겹치는 것들이 만드는 「못 두는 띠」를 피해, 지금 자리에서 가장 가까운 자리로 민다
    const floor = clash.reduce((y, g) => Math.max(y, g.bottom + 12), 12);
    const ceil = clash.reduce((y, g) => Math.min(y, g.top - 12 - r.height), frame.clientHeight - 12 - r.height);
    // 위로 밀 수 있으면 위로(양수 = 스크롤 내려 요소가 올라간다), 아니면 아래로
    const lift = ceil >= 12 ? r.top - Math.max(12, ceil) : r.top - floor;
    if (Math.abs(lift) > 1) win.scrollBy(0, lift);
  }, []);

  /**
   * 떠 온 화면 **자신의** 상단 고정 띠(헤더·탭 줄) 밑으로 짚을 자리가 숨지 않게 밀어 내린다.
   *
   * 🔴 위의 `scrollIntoSafeArea` 는 «우리가 띄운 것»(위젯 창·선택 띠)만 피한다. 그런데 편지함
   *    화면은 자기 헤더가 `position: sticky` 로 위를 덮고 있어서, 가운데로 맞춰 놓아도 그 줄이
   *    헤더 밑에 들어가 버린다 — 블록만 헤더 위에 동동 떠서 「저기 있다는데 안 보인다」가 된다
   *    (390px 실측 2026-09-18, 「이 셋이 같은 문제예요」의 첫 줄).
   *    겹칠 때만 움직인다 — 안 그러면 모든 단계가 늘 맨 위에 붙어 가운데 맞춤이 사라진다.
   */
  const clearStickyHeader = useCallback((el: HTMLElement) => {
    const frame = framesRef.current[live.current.page];
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!frame || !win || !doc) return;
    let bottom = 0;
    for (const node of doc.querySelectorAll<HTMLElement>('body *')) {
      const pos = win.getComputedStyle(node).position;
      if (pos !== 'sticky' && pos !== 'fixed') continue;
      const b = node.getBoundingClientRect();
      // 위에 붙어 있고 폭을 거의 다 차지하는 것만 «띠» 로 본다
      if (b.top <= 4 && b.height > 0 && b.width > frame.clientWidth * 0.6) bottom = Math.max(bottom, b.bottom);
    }
    if (!bottom) return;
    const r = el.getBoundingClientRect();
    if (r.top >= bottom + 8) return;
    win.scrollBy(0, r.top - (bottom + 8));
  }, []);

  /**
   * 짚을 자리로 **부드럽게 미끄러져 간다**(ny 2026-09-18 「스무스하게 스크롤이 되면 좋겠어」).
   *
   * 왜 이렇게 «두 번» 움직이나 — 자리를 고르는 계산(`scrollIntoSafeArea`·`clearStickyHeader`)은
   * 움직인 «뒤»의 좌표를 재서 다음 보정을 한다. 처음부터 부드럽게 시키면 그 재기가 아직 안 움직인
   * 좌표를 읽어 엉뚱한 데로 간다. 그래서 ①먼저 즉시 옮겨 «도착지»를 알아내고 ②원래 자리로
   * 돌려놓은 다음 ③거기까지 부드럽게 보낸다. ①②는 한 프레임 안에서 끝나 화면에는 안 보인다.
   */
  const scrollSmoothly = useCallback(
    (el: HTMLElement) => {
      const win = framesRef.current[live.current.page]?.contentWindow;
      if (!win) return;
      const before = win.scrollY;
      scrollIntoSafeArea(el);
      clearStickyHeader(el);
      const after = win.scrollY;
      if (Math.abs(after - before) < 2) return;
      // 움직임 줄이기를 켠 사람에게는 미끄러뜨리지 않는다 — 이미 도착해 있다
      if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      win.scrollTo(0, before);
      win.scrollTo({ top: after, behavior: 'smooth' });
      // 🔴 미끄러지다 «끊기는» 일이 있다. 랜딩에 박고 나서 실측에서 잡혔다 — 390px 7단계에서
      //    266px 못 미쳐 멈추는 바람에 짚을 자리가 무대 맨 아래 끝에 걸쳐, 누르면 그 밑
      //    버튼 띠가 클릭을 먹고 단계가 안 넘어갔다(2026-09-18).
      //    도착할 시점에 확인하고 안 왔으면 그냥 데려다 놓는다 — 덜 부드러운 게 못 가는 것보다 낫다.
      window.setTimeout(() => {
        try {
          if (Math.abs(win.scrollY - after) > 4) win.scrollTo(0, after);
        } catch {
          /* 그새 화면이 바뀌어 창이 없어졌으면 할 일도 없다 */
        }
      }, 700);
    },
    [scrollIntoSafeArea, clearStickyHeader],
  );


  // ── iframe 이 뜨면 CSS 와 리스너를 심는다 ──────────────────
  const handleLoad = useCallback(
    (page: SitePage) => {
      const doc = framesRef.current[page]?.contentDocument;
      if (!doc) return;
      // 두 번 불릴 수 있다(아래 «이미 떠 있던 것 줍기» 효과). 리스너가 겹쳐 붙으면 한 번 누른 게
      // 두 번으로 센다 — 문서마다 한 번만 단다. 화면이 새로 뜨면 문서가 바뀌므로 저절로 다시 단다.
      if (wiredRef.current.has(doc)) return;
      wiredRef.current.add(doc);
      if (!doc.getElementById('fl-tut')) {
        const style = doc.createElement('style');
        style.id = 'fl-tut';
        style.textContent = GATE_CSS;
        doc.head.appendChild(style);
      }

      /**
       * 누른 것을 각본에 넘긴다. `click` 과 `touchend` 두 길에서 들어온다.
       *
       * 🔴 **아이폰(WebKit)은 `<p>`·`<ul>`·`<div>` 처럼 「원래 안 눌리는」 요소를 탭해도 click 을 안 만든다**
       *    (`cursor:pointer` 를 줘도 — 2026-09-23 Playwright webkit 실측: pointerdown·touchstart·pointerup·
       *    touchend 만 오고 click 이 없다). 버튼·링크는 온다. 그래서 7단계(묶음 제목 `<p>`)·9단계(받은 사람
       *    `<ul>`)만 아이폰에서 안 넘어갔다. 탭은 `touchend` 에서 직접 받고, 그때 `preventDefault` 로
       *    브라우저가 합성할 click 을 끊는다 — 안 끊으면 버튼은 두 번 세고, 5→6단계처럼 같은 줄이 연이어
       *    짚히는 자리에서 한 탭에 두 단계가 넘어간다.
       */
      const onTap = (el: HTMLElement | null) => {
        if (page !== live.current.page) return;
        const t = live.current.target;
        // 요소가 아닌 것(문서 자체)이 target 으로 올 수 있다 — `closest` 가 없으면 누른 게 없는 것이다
        if (!el || typeof el.closest !== 'function') return;
        const hit = el.closest<HTMLElement>('.fl-hit');
        // 🔴 「볼 곳」만 있는 단계(팀 화면)에서도 **그 카드를 누르면 다음으로 간다.**
        //    링이 쳐진 걸 누르는 게 사람의 본능인데 아무 일도 안 일어나서, 왼쪽 패널 버튼을
        //    못 찾으면 거기서 막힌 것처럼 보였다(ny 2026-09-18 「넘어갈 수가 없어」).
        if (!t) {
          if (hit && live.current.spot) live.current.onHit();
          return;
        }
        // 선택 모드에서는 어디나 눌리지만, **집히는 것은 지정한 그것뿐**이다.
        // 다른 데를 눌러도 아무 일이 없고 반짝임은 계속 돈다 — 어디를 누르라는지 남아 있다.
        if (!hit) return;
        // 한 줄을 누르든(`frame`) 짚어 둔 셋 중 아무거나 누르든(`frame-many`) 다음으로 간다
        if (t.where === 'frame' || t.where === 'frame-many') {
          live.current.onHit();
          return;
        }
        if (t.where === 'frame-pick') {
          // 집는 대상은 «지정한 그것»이다. 아무 데나 집게 두면 각본의 다음 말과 어긋난다
          const r = hit.getBoundingClientRect();
          const box = toWrap(r);
          const pick = pickRef.current;
          if (pick) {
            pick.style.display = 'block';
            pick.style.left = `${box.x}px`;
            pick.style.top = `${box.y}px`;
            pick.style.width = `${box.w}px`;
            pick.style.height = `${box.h}px`;
          }
          live.current.onPick({ ...box, label: labelOf(hit, live.current.pieceFallback) });
        }
      };

      doc.addEventListener(
        'click',
        (e) => {
          // 사본엔 스크립트가 없지만 `<a href>` 는 그대로 이동한다 — 튜토리얼 밖으로 새지 않게 막는다
          e.preventDefault();
          e.stopPropagation();
          onTap(e.target as HTMLElement | null);
        },
        true,
      );

      // 탭인지 스크롤인지는 손가락이 «얼마나 움직였나»로 가른다 — 움직였으면 스크롤이지 탭이 아니다
      let touch: { x: number; y: number; at: number } | null = null;
      doc.addEventListener(
        'touchstart',
        (e) => {
          const t = e.changedTouches[0];
          touch = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
        },
        { capture: true, passive: true },
      );
      doc.addEventListener(
        'touchend',
        (e) => {
          const s = touch;
          touch = null;
          const t = e.changedTouches[0];
          if (!s || !t || e.touches.length) return;
          if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10 || Date.now() - s.at > 700) return;
          // 여기서 끊어야 브라우저가 click 을 합성하지 않는다(위 머리주석). passive 가 아니어야 듣는다.
          e.preventDefault();
          e.stopPropagation();
          onTap(e.target as HTMLElement | null);
        },
        { capture: true, passive: false },
      );

      // 선택 모드 — 가리키는 것을 두른다. **집을 수 있는 그것 위에서만** 켜진다
      doc.addEventListener(
        'pointermove',
        (e) => {
          if (page !== live.current.page) return;
          if (live.current.target?.where !== 'frame-pick') return;
          // 어디에 올려도 켜진다 — 집히는 것은 하나뿐이어도, 「화면 아무 데나 집을 수 있는
          // 도구」라는 게 이 단계에서 보여야 할 것이다(ny 2026-09-18).
          // ⚠️ 가리킨 요소를 **그대로** 두른다. 조상으로 넓히면 작은 버튼 위에서 줄 전체가
          //    잡혀 무엇을 집는지 어긋난다 — 실물 `widget-pick.js` 도 `elementFromPoint` 그대로다.
          hover(doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null);
        },
        true,
      );
      doc.addEventListener('pointerleave', () => hover(null), true);

      // 안에서 스크롤하면 링도 따라가야 한다
      doc.addEventListener('scroll', () => setReady((n) => n + 1), { passive: true, capture: true });
      setReady((n) => n + 1);
    },
    [toWrap, hover],
  );

  // ── 지금 눌러야 하는 곳에 링을 씌우고, 나머지를 막는다 ────
  useEffect(() => {
    // 화면을 옮기면 이전 화면에 남은 표시부터 걷는다 — 돌아왔을 때 옛 링이 남아 있으면 안 된다
    for (const p of Object.keys(PAGE_SRC) as SitePage[]) {
      const d = framesRef.current[p]?.contentDocument;
      if (!d) continue;
      d.documentElement.classList.remove('fl-gate', 'fl-pickmode');
      d.querySelectorAll('.fl-hit').forEach((el) => el.classList.remove('fl-hit'));
      d.querySelectorAll('.fl-shine').forEach((el) => el.classList.remove('fl-shine'));
    }

    const doc = curFrame()?.contentDocument;
    const root = doc?.documentElement;
    if (!doc || !root) return;

    // 떠 온 화면은 우리가 정한 길로만 다닌다 — 선택 모드만 예외로 열어 준다
    const picking = target?.where === 'frame-pick';
    root.classList.add(picking ? 'fl-pickmode' : 'fl-gate');

    if (hoverRef.current && target?.where !== 'frame-pick') hoverRef.current.style.display = 'none';
    if (target?.where !== 'frame-many') placeBlocks([]);

    // 단계·화면·폭이 그대로면 이미 보낸 것이다. 스크롤 도중에 다시 보내지 않는다
    const key = `${scene.page}|${wrapRef.current?.clientWidth ?? 0}|${JSON.stringify(target ?? null)}|${JSON.stringify(spot ?? null)}`;
    const scrollOnce = (el: HTMLElement) => {
      if (scrolledKey.current === key) return;
      scrolledKey.current = key;
      scrollSmoothly(el);
    };

    // 어두운 스포트라이트는 고객 화면(널널투어)에서만. 팀 화면·메일함은 그대로 밝게 둔다
    const dim = scene.page === 'map';

    // ① 위젯을 가리키는 단계 — 위젯은 우리 DOM 이다
    if (target?.where === 'widget') {
      const el = widgetRef.current?.querySelector<HTMLElement>(`[data-part="${target.id satisfies WidgetPart}"]`);
      if (!el) {
        place(null, '');
        return;
      }
      const w = wrapBox();
      const r = el.getBoundingClientRect();
      place({ x: r.left - w.left, y: r.top - w.top, w: r.width, h: r.height }, hint, true, dim);
      return;
    }

    // ②-1 여러 줄을 한꺼번에 짚는 단계 — 「이 셋이 같은 문제예요」.
    //      링은 «하나»를 두르는 물건이라 여기선 끄고, 줄마다 블록을 씌운다.
    if (target?.where === 'frame-many') {
      const found = target.text.map((t) => findByText(doc, [t]));
      if (found.some((el) => !el)) {
        place(null, '');
        placeBlocks([]);
        // 한 줄이라도 못 찾으면 「이 셋」이 성립하지 않는다 — 버튼으로 넘길 수 있게 알린다
        onTargetMissing();
        return;
      }
      const els = found as HTMLElement[];
      for (const el of els) el.classList.add('fl-hit');
      scrollOnce(els[0]);
      const draw = () => {
        const boxes = els.map((el) => toWrap(el.getBoundingClientRect()));
        placeBlocks(boxes);
        place(boxes[0], hint, false, false);
      };
      draw();
      // 스크롤이 끝난 «뒤»에 한 번 더 잰다 — 바로 재면 스크롤 전 좌표가 잡힌다(390px 실측)
      const a1 = requestAnimationFrame(() => {
        a2 = requestAnimationFrame(draw);
      });
      let a2 = 0;
      return () => {
        cancelAnimationFrame(a1);
        cancelAnimationFrame(a2);
      };
    }

    // ② 화면 안의 무언가 — 누르게 하거나(frame), 집게 하거나(frame-pick), 보게 하거나(spot)
    const want = target?.where === 'frame' || target?.where === 'frame-pick' ? target.text : spot?.text;
    if (!want) {
      place(null, '');
      return;
    }

    const found = findByText(doc, want);
    // 「볼 곳」은 찾은 글자에서 **그 글자를 품은 칸까지** 올라가 두를 수 있다(`spot.grow`).
    // 조상이 없으면 찾은 그 글자를 그대로 쓴다 — 못 올라갔다고 단계가 막히면 안 된다.
    //
    // 🔴 **화면에 안 들어가는 칸은 두르지 않는다.** 떠 온 화면에는 자기 고정 헤더가 있어서
    //    쓸 수 있는 세로가 화면보다 짧다. 그보다 큰 칸을 두르면 링의 아랫변이 잘려 나가
    //    「어디까지가 박스인지」를 알 수 없게 된다(390px 에서 실제로 9px 이 잘렸다).
    //    그럴 땐 찾은 글자만 두른다 — 작아도 «온전한» 박스가 잘린 박스보다 낫다.
    const grown = found && !target && spot?.grow ? (found.closest(spot.grow) as HTMLElement | null) : null;
    const room = (curFrame()?.clientHeight ?? 0) - stickyBottom(doc, curFrame()) - 24;
    const el = grown && (room <= 0 || grown.getBoundingClientRect().height <= room) ? grown : found;
    if (!el) {
      place(null, '');
      placeMail(null);
      // 눌러야 넘어가는 단계에서 못 찾으면 막힌다 — 버튼으로 넘길 수 있게 부모에게 알린다
      if (target) onTargetMissing();
      return;
    }

    // 누를 곳이든 볼 곳이든 **누를 수 있게** 연다 — 볼 곳을 누르면 다음 단계로 간다
    el.classList.add('fl-hit');
    if (picking) el.classList.add('fl-shine');

    scrollOnce(el);
    const label = target ? hint : (spot?.say ?? '');
    place(toWrap(el.getBoundingClientRect()), label, !picking, dim);
    placeMail(toWrap(el.getBoundingClientRect()));
    // ⚠️ 스크롤이 «끝난 뒤»에 한 번 더 잰다. 바로 재면 스크롤 전 좌표가 잡혀서 링이 화면 맨 위
    //    구석을 두른다(390px 실측 2026-09-18 — 데스크톱에선 이미 보이는 자리라 안 드러났다).
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        place(toWrap(el.getBoundingClientRect()), label, !picking, dim);
        placeMail(toWrap(el.getBoundingClientRect()));
      });
    });
    let raf2 = 0;
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [target, hint, spot, handoff, ready, scene.page, scene.widgetOpen, scene.picking, curFrame, toWrap, place, placeBlocks, placeMail, scrollSmoothly, onTargetMissing, PAGE_SRC]);

  /**
   * 🔴 이미 떠 있던 화면을 줍는다.
   *
   * 랜딩에 **박아 넣으면** iframe 이 처음 HTML 에 그대로 실려서, React 가 하이드레이션하기
   * «전»에 다 뜨는 일이 생긴다. 그러면 `onLoad` 가 영영 안 불리고 — 화면 안을 누르는 리스너가
   * 안 붙어 **4단계(「쿠폰 받기」 집기)부터 아무 반응이 없다**(2026-09-18 실측).
   * 팝업일 땐 열 때 만들어져 늘 늦게 떴기 때문에 드러나지 않던 자리다.
   */
  useEffect(() => {
    // ⚠️ 한 프레임 미룬다. `handleLoad` 는 끝에서 상태를 올리는데, 효과 «본문»에서 바로 올리면
    //    렌더가 연쇄로 도는 모양이 되어 린트가 막는다. 어차피 급할 일이 아니다.
    const id = requestAnimationFrame(() => {
      for (const page of Object.keys(PAGE_SRC) as SitePage[]) {
        if (framesRef.current[page]?.contentDocument?.readyState === 'complete') handleLoad(page);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [handleLoad, PAGE_SRC]);

  // 창 크기가 바뀌면 자리를 다시 잰다
  useEffect(() => {
    const on = () => setReady((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // 화면을 바꾸면 집어 둔 네모는 지운다 — 다른 화면의 좌표다
  useEffect(() => {
    const pick = pickRef.current;
    if (pick && scene.page !== 'map') pick.style.display = 'none';
  }, [scene.page]);

  const customer = isCustomerPage(scene.page);
  /** 위젯이 뜨는 화면 — 널널투어 하나뿐이다. 메일함 위에 챗봇이 떠 있으면 말이 안 된다 */
  const widgetOn = scene.page === 'map';

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-[#fbfaf9]">
      {/* 브라우저 주소줄 — 「지금 누구 화면인가」를 한눈에 */}
      <div className="flex h-9 items-center gap-2 border-b border-[#eeeae9] bg-white px-3">
        <div className="flex gap-1.5" aria-hidden="true">
          {['#f5b6b1', '#f6dca8', '#b8dcc4'].map((c) => (
            <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <div className="min-w-0 flex-1 truncate rounded-full bg-[#f6f3f2] px-3 py-1 text-[11px] text-[#a39d9b]">
          {PAGE_URL[scene.page]}
        </div>
        <span
          className="flex-none rounded-full px-2 py-[3px] text-[10.5px] font-semibold text-white transition-colors"
          style={{ background: customer ? '#191d1b' : '#2f6b4c' }}
        >
          {customer ? tr('stage.customerView') : tr('stage.teamView')}
        </span>
      </div>

      {/* 떠 온 화면 넉 장 — 겹쳐 두고 투명도로 바꾼다(전환이 끊기지 않게) */}
      <div className="relative h-[calc(100%-36px)] w-full">
        {(Object.keys(PAGE_SRC) as SitePage[]).map((p) => {
          const on = p === scene.page;
          return (
            <iframe
              key={p}
              ref={(el) => {
                framesRef.current[p] = el;
              }}
              src={PAGE_SRC[p]}
              title={p === 'map' ? tr('stage.siteFrame') : tr('stage.teamFrame')}
              onLoad={() => handleLoad(p)}
              aria-hidden={!on}
              className="absolute inset-0 h-full w-full border-0 bg-white"
              style={{
                opacity: on ? 1 : 0,
                pointerEvents: on ? 'auto' : 'none',
                transition: 'opacity .3s ease',
                zIndex: on ? 1 : 0,
              }}
              // 🔴 `allow-scripts` 는 사본의 스크립트를 위한 게 아니다 — 사본엔 스크립트가 한 줄도 없다
              //    (`__tests__/demo-sandbox.test.ts` 가 막는다). **WebKit(아이폰 사파리·카톡 인앱)은
              //    스크립트가 막힌 프레임 문서에는 부모가 `contentDocument` 에 단 리스너도 안 부른다** —
              //    click·pointermove·scroll 전부. 그래서 아이폰에서 「쿠폰 받기」 집기·빨간 박스 탭·
              //    세 줄 탭이 전부 무반응이었고, 스크롤 뒤 링을 다시 재는 리스너도 죽어 링이 화면 밖에
              //    그려졌다(2026-09-23 지인 제보 → Playwright webkit 실측: allow-scripts 없으면 0회,
              //    있으면 정상). 남는 잠금은 폼 제출·팝업·상위 창 이동 차단이다.
              sandbox="allow-same-origin allow-scripts"
            />
          );
        })}
      </div>

      {/* 스포트라이트 — 눌러야 할 곳만 밝고 나머지는 어둡게. 클릭은 통과시킨다.
          ⚠️ 위젯(z-40)보다 «위»에 둔다. 아래에 두면 위젯 안을 가리킬 때(입력칸·도구) 링이
          위젯 패널 뒤로 숨어 아무것도 안 보인다(1280 실측). */}
      <div className="pointer-events-none absolute inset-0 z-[45]">
        <span
          ref={ringRef}
          className="absolute rounded-[12px]"
          style={{
            display: 'none',
            // 둘레 밖을 어둡게 칠할지는 `place()` 가 화면마다 정한다 — 여기 기본값을 두면
            // 규칙이 두 군데가 되어, 한쪽만 고쳤을 때 팀 화면이 다시 어두워진다
            outline: '3px solid #F2645C',
            outlineOffset: '2px',
            animation: 'gdPulse 1.4s ease-in-out infinite',
            transition: 'left .3s, top .3s, width .3s, height .3s',
          }}
        />
        <span
          ref={hintRef}
          className="absolute whitespace-nowrap rounded-full bg-[#D13A2D] px-3 py-1.5 text-[12px] font-bold text-white shadow-[0_8px_24px_rgba(209,58,45,.35)]"
          style={{ display: 'none', transition: 'left .3s, top .3s' }}
        >
          {target ? (
            hint
          ) : spot ? (
            <>
              {spot.say}
              {/* 링이 쳐진 걸 눌러 넘어간다는 걸 말로도 적는다 — 왼쪽 패널 버튼만으로는 못 찾으셨다 */}
              <span className="ml-1 font-semibold opacity-75">{tr('stage.tapToContinue')}</span>
            </>
          ) : (
            ''
          )}
        </span>
      </div>

      {/* 「화면에서 선택하기」가 켜진 동안 — 실물(`widget-pick.js`)과 같은 띠.
          🔴 바깥 칸은 «클릭을 먹으면 안 된다». 폭 전체를 덮고 있어서, 여기가 auto 이면 띠와
             같은 높이에 있는 버튼은 눌리지 않는다 — 390px 에서 「쿠폰 받기」가 정확히 이 띠에
             가려 안 눌렸다(2026-09-18 실측). 눌리는 것은 안쪽 알약뿐이다. */}
      {scene.picking && (
        <div
          data-pick-bar=""
          className="pointer-events-none absolute inset-x-0 top-[48px] z-[46] flex justify-center"
          style={{ animation: 'gdRise .26s cubic-bezier(.2,.7,.2,1)' }}
        >
          <span className="pointer-events-auto flex items-center gap-2.5 rounded-full bg-[#191d1b] py-[9px] pl-[15px] pr-[10px] text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(25,29,27,.25)]">
            {tr('stage.pickBar')}
            <button
              type="button"
              onClick={onSkip}
              className="rounded-full bg-white/[.16] px-[11px] py-[5px] text-[12px] font-bold text-white"
            >
              {tr('stage.cancel')}
            </button>
          </span>
        </div>
      )}

      {/* 가리키는 요소를 두르는 박스 — 실물과 같은 값 */}
      <div
        ref={hoverRef}
        className="pointer-events-none absolute z-[44] rounded-[4px]"
        style={{
          display: 'none',
          border: `2px solid ${ACCENT}`,
          background: rgba(ACCENT, 0.12),
          boxShadow: '0 0 0 100vmax rgba(25,29,27,.14)',
          transition: 'top .05s, left .05s, width .05s, height .05s',
        }}
      >
        <span
          ref={tagRef}
          // ⚠️ `max-w-[60%]` 은 **가리키는 요소의** 60% 라 작은 버튼 위에서는 「but…」 으로 잘렸다.
          //    실물은 `max-width:60vw`(화면 기준)다 — 같은 값을 쓴다.
          className="absolute bottom-full left-[-2px] mb-[4px] max-w-[60vw] overflow-hidden text-ellipsis whitespace-nowrap rounded-[4px] px-[7px] py-[2px] text-[11px] font-bold text-white"
          style={{ background: ACCENT }}
        />
      </div>

      {/* 실제로 집은 자리 */}
      <div
        ref={pickRef}
        className="pointer-events-none absolute z-20 rounded-[8px] border-2 border-[#D13A2D] bg-[rgba(209,58,45,.08)]"
        style={{ display: 'none' }}
      >
        {/* ⚠️ `whitespace-nowrap` 이 없으면 **두른 요소의 폭에 맞춰 접힌다** — 72px 짜리
            「쿠폰 받기」 버튼 위에서 두 줄로 쪼개져 보기 흉했다(ny 2026-09-18). */}
        <span className="absolute bottom-full left-[-2px] mb-[5px] whitespace-nowrap rounded-full bg-[#D13A2D] px-[7px] py-[1.5px] text-[10px] font-bold leading-[1.5] text-white shadow-[0_2px_8px_rgba(209,58,45,.3)]">
          {tr('stage.problemHere')}
        </span>
      </div>

      {/* 「이 셋이 같은 문제예요」 — 한 화면의 여러 줄을 한꺼번에 짚는다.
          🔴 여기가 「비슷한 제보 묶기」의 전부다. 예전엔 편지함에서 묶음 화면으로 그냥 갈아 끼웠고,
             한때는 카드 셋이 날아와 포개지게도 해 봤다 — 둘 다 ny 에게 「점프처럼 보인다 / 스무스하지
             않다」였다(2026-09-18). 화면에 **이미 있는 그 줄들**을 하나씩 짚으면 보는 사람이
             「아, 저것들이 같은 얘기구나」를 자기 눈으로 확인한다.
          ⚠️ 칸 개수(4)가 한 단계에서 짚을 수 있는 최대다. 각본이 더 주면 앞에서부터 넷만 켜진다. */}
      <div ref={blocksRef} className="pointer-events-none absolute inset-0 z-[30]" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="absolute rounded-[10px] border-2 border-[#D13A2D] bg-[rgba(209,58,45,.10)]"
            style={{ display: 'none', animation: 'gdBlock .5s cubic-bezier(.34,.9,.3,1) both' }}
          />
        ))}
      </div>

      {/* 고객 화면 → 팀 화면으로 넘어가는 순간.
          🔴 그냥 갈아 끼우면 「화면이 바뀌었다」로만 읽히고 **제보가 건너갔다는 느낌이 없다**
             (ny 2026-09-18). 방금 남긴 그 한마디를 카드로 띄워 위젯 자리에서 가운데로
             날려 보내고, 그동안 뒤에서 팀 화면이 떠오른다. 1.5초. */}
      {handoff && (
        <div className="pointer-events-none absolute inset-0 z-[70] overflow-hidden">
          <div ref={mailRef} className="absolute" style={{ animation: 'gdMail 1.5s cubic-bezier(.34,.9,.3,1)' }}>
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 py-[7px] text-[12px] font-bold text-[#191d1b] shadow-[0_14px_34px_rgba(25,29,27,.28)]">
              <span className="text-[15px] leading-none" aria-hidden="true">
                📩
              </span>
              {tr('stage.reportOne')}
            </span>
          </div>
        </div>
      )}

      {/* 위젯은 고객 화면에만 뜬다. 팀 화면 위에 챗봇이 떠 있으면 말이 안 된다.
          🔴 이 칸은 **클릭을 먹으면 안 된다.** `inset-0` 으로 무대를 통째로 덮고 있어서, 여기가
             클릭을 받으면 떠 온 화면에는 마우스가 영영 닿지 않는다 — 「화면에서 선택하기」가
             hover 도 클릭도 안 되던 원인이 이거였다(2026-09-18 실측). 실제로 눌리는 것은
             `Widget` 안의 창과 동그란 버튼뿐이고 그 둘은 스스로 `pointer-events-auto` 다. */}
      <div
        ref={widgetRef}
        className="pointer-events-none absolute inset-0 z-40"
        style={{
          opacity: widgetOn ? 1 : 0,
          // 🔴 `pointer-events:none` 만으로는 안 된다 — **자식의 `auto` 가 그걸 되살린다.**
          //    그래서 팀 화면에서도 투명해진 창(320×430)이 그 자리의 클릭을 계속 먹었고,
          //    390px 에서는 그 창이 편지함 카드를 덮어 눌러도 다음으로 못 갔다(실측).
          //    `visibility` 는 자식까지 확실히 끄고, transition 을 걸어 두면 사라질 때만
          //    0.3초 뒤에 꺼져 페이드가 살아 있다.
          visibility: widgetOn ? 'visible' : 'hidden',
          transition: 'opacity .3s ease, visibility .3s',
        }}
        aria-hidden={!widgetOn}
      >
        <Widget scene={scene} want={target?.where === 'widget' ? target.id : null} onHit={onHit} />
      </div>
    </div>
  );
}

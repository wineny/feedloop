/**
 * Feedloop 위젯 선택기 — 「화면에서 짚기」. widget.js 가 그 버튼을 누를 때만 이 파일을 로드한다.
 *
 * 왜 따로인가: widget.js 는 남의 사이트 모든 방문자가 받는다(gzip 상한 18KB). 요소를 짚는 방문자는
 * 드물다 — 그들만 이 파일을 받는다. 그래서 여기는 크기보다 «정확히 짚기»를 우선한다.
 *
 * 하는 일: 호스트 문서 위에 오버레이(하이라이트 상자 + 상단 배너) → 마우스를 올리면 그 아래 요소를
 * 테두리로 표시 → 클릭(모바일은 탭)하면 그 요소를 설명하는 값(종류·셀렉터·글자·라벨·경로·html 뼈대·
 * 위치·URL)을 Promise 로 돌려준다. Esc·배너의 「취소」는 null.
 * html 은 outerHTML 이 아니라 **텍스트 노드를 뺀 뼈대**다 — 방문자가 짚는 것이 «주문 내역의 한 행»이면
 * outerHTML 엔 다른 사람의 이름·전화가 든다. 엔진이 쓰는 건 태그·클래스·data 속성이지 그 글자가 아니다.
 *
 * 원칙 — 이 코드도 남의 사이트에서 돈다:
 *  1. 짚는 동안 호스트의 클릭 핸들러가 돌면 안 된다(링크 이동·버튼 실행). capture 단계에서 막는다
 *  2. 스크롤은 막지 않는다 — 짚을 요소가 화면 밖에 있을 수 있다(touchstart 는 건드리지 않는다)
 *  3. 끝나면 흔적 없이 걷는다 — 리스너·오버레이·커서 전부 원상복구
 *  4. 값의 상한·마스킹은 서버(lib/widget/context.ts sanitizeTarget)가 다시 건다. 여기선 «모양»만 맞춘다
 * 종류 표·라벨 규칙은 lib/widget/pick.ts 와 같아야 한다(__tests__/widget-pick.test.ts 가 대조).
 */
(function () {
  'use strict';
  if (window.__feedloopPick) return;

  var KIND = { button: '버튼', a: '링크', input: '입력칸', textarea: '입력칸', select: '선택칸', img: '이미지' };
  var INK = '#191d1b';

  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  }

  /**
   * 셀렉터에 쓸 만한 클래스만. CSS 모듈(`Btn_root__x1a2b`)·이모션(`css-1k2j3h`)·해시 꼬리는 빌드마다
   * 바뀌어 다음 배포에서 못 찾는다. 유틸 클래스(`px-4`)는 남지만 그것만으론 유일하지 않아
   * nth-of-type 이 보완한다.
   */
  function stableClasses(el) {
    var out = [];
    var list = el.classList ? Array.prototype.slice.call(el.classList) : [];
    for (var i = 0; i < list.length && out.length < 2; i++) {
      var c = list[i];
      if (/^[A-Za-z_-][\w-]*$/.test(c) && !/__|--|[A-Za-z]\d{2,}|_[A-Za-z0-9]{5,}$|^css-/.test(c)) out.push(c);
    }
    return out;
  }

  /** 한 단계 = 태그(+id/testid/클래스)(+nth-of-type). anchor 면 위로 더 안 올라간다 */
  /** CSS 타입 셀렉터용 태그 이름. SVG 의 camelCase(`linearGradient`)는 대소문자를 구분하므로 원형 유지 */
  function tagOf(el) {
    return el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? el.tagName : el.tagName.toLowerCase();
  }

  function step(el) {
    var tag = tagOf(el);
    var testid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testid) return { sel: tag + '[data-testid="' + esc(testid) + '"]', anchor: true };
    var id = el.id;
    if (id && /^[A-Za-z_][\w-]*$/.test(id) && !/\d{3,}/.test(id)) return { sel: '#' + esc(id), anchor: true };
    var sel = tag;
    var cls = stableClasses(el);
    if (cls.length) sel += '.' + cls.map(esc).join('.');
    var p = el.parentElement;
    if (p) {
      var same = 0, idx = 0;
      for (var i = 0; i < p.children.length; i++) {
        if (p.children[i].tagName === el.tagName) { same++; if (p.children[i] === el) idx = same; }
      }
      if (same > 1) sel += ':nth-of-type(' + idx + ')';
    }
    return { sel: sel, anchor: false };
  }

  /** 아래에서 위로 쌓다가 anchor(id·testid)를 만나거나 문서에서 유일해지면 멈춘다. 최대 8단계 */
  function selectorFor(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && parts.length < 8) {
      var s = step(cur);
      parts.unshift(s.sel);
      if (s.anchor) break;
      var joined = parts.join(' > ');
      try { if (document.querySelectorAll(joined).length === 1) break; } catch (e) { /* 이상한 셀렉터면 계속 */ }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /** 글자 없는 요소(아이콘 버튼·이미지)의 이름 — 속성 → 감싸는 버튼/라벨 → 구역의 헤딩 */
  function nearestLabel(el) {
    var attr = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title');
    if (attr) return clean(attr);
    var wrap = el.closest && el.closest('button,a,label,[role="button"]');
    if (wrap && wrap !== el) return clean(wrap.innerText || wrap.textContent);
    var sect = el.closest && el.closest('section,form,article,nav,header,footer,main,dialog');
    if (sect) {
      var h = sect.querySelector('h1,h2,h3,legend');
      if (h) return clean(h.innerText || h.textContent);
    }
    return '';
  }

  /** 뼈대에 남길 속성. value·src·style·href 쿼리는 뺀다 — 토큰·개인 값이 실리는 자리다 */
  var KEEP_ATTR = /^(id|class|role|type|name|aria-label|placeholder|alt|title|data-[\w-]+)$/;
  var SKEL_DEPTH = 2, SKEL_KIDS = 6, SKEL_ATTR = 40;

  /** 텍스트 노드 없는 outerHTML. `<button class="primary" data-testid="claim"><svg class="ico"></svg></button>` */
  function skeleton(el, depth) {
    var tag = el.tagName.toLowerCase();
    var s = '<' + tag;
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (!KEEP_ATTR.test(a.name)) continue;
      var v = clean(a.value).slice(0, SKEL_ATTR).replace(/"/g, "'");
      s += ' ' + a.name + (v ? '="' + v + '"' : '');
    }
    if (tag === 'a' && el.getAttribute('href')) s += ' href="' + String(el.getAttribute('href')).split('?')[0].slice(0, SKEL_ATTR) + '"';
    s += '>';
    if (depth > 0) {
      var kids = el.children || [];
      for (var k = 0; k < kids.length && k < SKEL_KIDS; k++) s += skeleton(kids[k], depth - 1);
      if (kids.length > SKEL_KIDS) s += '…';
    } else if (el.children && el.children.length) s += '…';
    return /^(input|img|br|hr|meta|link|source|track|wbr|area|col|embed)$/.test(tag) ? s : s + '</' + tag + '>';
  }

  /** 조상 태그 경로. html·body 는 뺀다 — 어느 «구역»인지가 정보다 */
  function ancestry(el) {
    var tags = [];
    var cur = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement && tags.length < 6) {
      tags.unshift(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    tags.push(el.tagName.toLowerCase());
    return tags.join(' > ');
  }

  /** lib/widget/pick.ts AREA_TEXT_LIMIT 와 같다(테스트 대조) */
  var AREA_TEXT = 40;

  /**
   * 큰 영역의 이름 — 자기 안의 첫 h1~h3 → 가장 가까운 조상 구역(section·article…)의 헤딩 → 조상 경로 꼬리.
   * nearestLabel 과 달리 aria-label·버튼 글자를 보지 않는다 — 여기서 찾는 건 «어느 구역인가»다.
   */
  function areaName(el) {
    var h = el.querySelector && el.querySelector('h1,h2,h3');
    var cur = el;
    while (!h && cur && cur !== document.body) {
      cur = cur.parentElement && cur.parentElement.closest ? cur.parentElement.closest('section,article,aside,nav,main,form,dialog') : null;
      if (cur) h = cur.querySelector('h1,h2,h3,legend');
    }
    var name = h ? clean(h.innerText || h.textContent).slice(0, 60) : '';
    return name && /[\p{L}\p{N}]/u.test(name) ? name : ancestry(el).split(' > ').slice(-2).join(' > ');
  }

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    var t = { kind: KIND[tag] || (role === 'button' || role === 'link' ? KIND[role === 'link' ? 'a' : 'button'] : '영역'), tag: tag, selector: selectorFor(el) };
    var text = clean(el.innerText || el.textContent);
    // 글자·숫자가 하나도 없는 텍스트(「👤」·「›」 같은 아이콘)는 이름이 못 된다 — aria-label 이 대신 선다
    if (text && /[\p{L}\p{N}]/u.test(text)) t.text = text.slice(0, 120);
    // 큰 영역은 안의 글자로는 어디인지 모른다(I-55) — 글자는 앞 AREA_TEXT 자만, 이름은 구역 이름으로
    if (t.kind === '영역' && t.text && t.text.length > AREA_TEXT) {
      t.text = t.text.slice(0, AREA_TEXT);
      t.heading = areaName(el);
    }
    var label = nearestLabel(el);
    if (label && label !== text) t.label = label.slice(0, 100);
    t.path = ancestry(el);
    t.html = skeleton(el, SKEL_DEPTH).slice(0, 600);
    var r = el.getBoundingClientRect();
    t.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    // rect 의 기준 — 보낼 때의 뷰포트(context.viewport)는 iOS 주소창·회전으로 달라진다. 짚는 순간 값을 함께
    t.viewport = window.innerWidth + 'x' + window.innerHeight;
    t.url = location.href;
    return t;
  }

  function rgba(hex, a) {
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(242,100,92,' + a + ')';
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  var active = null;

  /**
   * opts.ignore — 위젯 호스트 요소. 그 안(섀도 트리 포함)은 짚을 수 없다.
   * opts.accent — 운영자 강조색(#rrggbb). 없으면 코랄.
   * opts.locale — 'ko' 면 한국어 배너, 그 밖엔 영어(widget.js 가 고른 언어를 넘긴다).
   */
  window.__feedloopPick = function (opts) {
    if (active) return active;
    opts = opts || {};
    var accent = /^#[0-9a-f]{6}$/i.test(opts.accent || '') ? opts.accent : '#F2645C';
    var ignore = opts.ignore;

    var ov = document.createElement('div');
    ov.setAttribute('data-feedloop-pick', '');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483001;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:2px solid ' + accent + ';background:' + rgba(accent, 0.12) + ';border-radius:4px;box-shadow:0 0 0 100vmax rgba(25,29,27,.14);transition:top .05s,left .05s,width .05s,height .05s';
    var tagEl = document.createElement('div');
    tagEl.style.cssText = 'position:absolute;left:-2px;bottom:100%;margin-bottom:4px;background:' + accent + ';color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
    box.appendChild(tagEl);
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:10px;background:' + INK + ';color:#fff;border-radius:999px;padding:9px 10px 9px 15px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(25,29,27,.25);max-width:calc(100vw - 24px)';
    var msg = document.createElement('span');
    var ko = opts.locale === 'ko';
    msg.textContent = ko ? '고칠 부분을 눌러 주세요' : 'Click the part to fix';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = ko ? '취소' : 'Cancel';
    cancel.style.cssText = 'border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
    bar.appendChild(msg); bar.appendChild(cancel);
    ov.appendChild(box); ov.appendChild(bar);

    var prevCursor = document.documentElement.style.cursor;
    var hovered = null;
    var resolveFn;

    function inOverlay(el) { return !!el && (ov.contains(el) || (ignore && ignore.contains(el))); }

    function at(x, y) {
      var el = document.elementFromPoint(x, y);
      return !el || inOverlay(el) ? null : el;
    }

    function show(el) {
      hovered = el;
      if (!el) { box.style.display = 'none'; return; }
      var r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left - 2 + 'px';
      box.style.top = r.top - 2 + 'px';
      box.style.width = r.width + 4 + 'px';
      box.style.height = r.height + 4 + 'px';
      // 호버 라벨은 textContent 로 — innerText 는 레이아웃을 강제해 pointermove 마다 호스트에 리플로를 건다.
      // 이름 규칙은 describe() 와 같다(글자·숫자 없는 「👤」는 이름이 아니다)
      var text = clean(el.textContent).slice(0, 40);
      var name = /[\p{L}\p{N}]/u.test(text) ? text : nearestLabel(el).slice(0, 40);
      tagEl.textContent = el.tagName.toLowerCase() + (name ? ' · ' + name : '');
    }

    function onMove(e) { show(at(e.clientX, e.clientY)); }
    function onDown(e) {
      if (ov.contains(e.target)) return;   // 배너의 「취소」는 살린다
      e.preventDefault();                  // 초점 이동·글자 선택·호스트 핸들러 차단 (스크롤은 영향 없음)
      e.stopPropagation();
      if (e.pointerType === 'touch') show(at(e.clientX, e.clientY));
    }
    function onClick(e) {
      if (ov.contains(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // 키보드 Enter 로 난 click 은 좌표가 (0,0)이라 좌상단 요소를 집는다 — 그땐 호버 중인 것만
      var el = (e.detail === 0 ? null : at(e.clientX, e.clientY)) || hovered;
      if (!el) return;
      var t;
      // 읽기 실패는 「취소」와 다르다 — 위젯이 방문자에게 다른 곳을 짚으라고 말할 수 있게 표시한다
      try { t = describe(el); } catch (err) { t = { error: true }; }
      finish(t);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } }
    function onScroll() { if (hovered) show(hovered); }
    // 모바일 탭은 touchstart → touchend → mousedown → click 순이라 호스트의 터치 핸들러(캐러셀·드로어)가
    // 먼저 돈다. 전파만 끊는다 — preventDefault 를 하면 click 합성이 안 돼 탭으로 못 짚고, 스크롤은 touchmove 라 무관
    function onTouch(e) { if (!ov.contains(e.target)) e.stopPropagation(); }

    // up·auxclick(가운데 클릭 = 새 탭)도 막는다 — 호스트 핸들러가 up 에 붙어 있는 경우가 흔하다
    var caps = { pointermove: onMove, pointerdown: onDown, mousedown: onDown, pointerup: onDown, mouseup: onDown, auxclick: onDown, click: onClick, keydown: onKey, touchstart: onTouch, touchend: onTouch };
    // 호스트가 body 자식을 통째로 갈아치우면(SPA 리마운트) 배너는 사라지는데 캡처 리스너만 남아
    // 페이지 전체가 클릭 불능이 된다 — 오버레이가 문서에서 빠지면 그 자리에서 끝낸다
    var mo = window.MutationObserver ? new MutationObserver(function () { if (!document.contains(ov)) finish(null); }) : null;

    function finish(t) {
      if (mo) mo.disconnect();
      for (var k in caps) document.removeEventListener(k, caps[k], true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      document.documentElement.style.cursor = prevCursor;
      active = null;
      resolveFn(t);
    }

    cancel.onclick = function (e) { e.stopPropagation(); finish(null); };

    active = new Promise(function (resolve) {
      resolveFn = resolve;
      for (var k in caps) document.addEventListener(k, caps[k], true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
      document.documentElement.style.cursor = 'crosshair';
      document.body.appendChild(ov);
      if (mo) mo.observe(document.body, { childList: true });
    });
    return active;
  };

  // window.__feedloopPick 은 사용 뒤에도 남긴다 — widget.js 가 두 번째 짚기에 «이미 로드됨» 판정으로 쓴다.
  // 권한이 있는 함수가 아니다(호스트가 이미 할 수 있는 DOM 읽기뿐). 아래 둘은 테스트가 순수 함수를 떼어 쓰려고 노출한다.
  window.__feedloopPick.describe = describe;
  window.__feedloopPick.selectorFor = selectorFor;
  window.__feedloopPick.areaName = areaName;
})();

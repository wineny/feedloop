/**
 * Feedloop 위젯 촬영기 — 「화면에서 선택하기」를 누른 방문자만 받는다 (I-55, 2026-09-25).
 * 빌드: `node scripts/widget-shot/build.mjs` → public/widget-shot.js (modern-screenshot 4.7.0 번들, gzip 상한 14KB)
 *
 * 하는 일: 방문자가 «보고 있던 뷰포트 그대로»(스크롤 위치 포함) 다시 그려 가로 1280·DPR 1 이하로 줄이고
 * WebP q0.75(안 되면 JPEG)로 인코딩해 업로드한다. 결과는 { id, thumb }(thumb = 칩 썸네일용 object URL) 또는 null.
 * 짚은 영역 테두리는 이미지에 굽지 않는다 — 운영자 화면이 target.rect 로 겹쳐 그린다.
 *
 * 원칙 — 이 코드도 남의 사이트에서 돈다:
 *  1. 위젯 호스트(섀도 루트)·선택 오버레이는 filter 로 뺀다 — 패널을 숨길 필요가 없다
 *  2. 외부 리소스를 인라인하려고 fetch 할 때 호스트 쿠키를 싣지 않는다(credentials:'omit')
 *  3. 실패는 전부 null — 촬영은 부가 기능이다. 위젯은 「위치만」 보낸다
 */
import { domToCanvas } from 'modern-screenshot';

var MAX_W = 1280;
var MAX_BYTES = 1024 * 1024;

function toBlob(canvas, type, q) {
  return new Promise(function (ok) {
    try { canvas.toBlob(function (b) { ok(b); }, type, q); } catch (e) { ok(null); }
  });
}

/** WebP 가 안 되는 브라우저(구형 Safari)는 PNG 를 준다 — 그땐 JPEG 로. 1MB 를 넘으면 품질을 한 번 내린다 */
function encode(canvas) {
  return toBlob(canvas, 'image/webp', 0.75)
    .then(function (b) { return b && b.type === 'image/webp' ? b : toBlob(canvas, 'image/jpeg', 0.75); })
    .then(function (b) {
      if (!b || b.size <= MAX_BYTES) return b;
      return toBlob(canvas, b.type, 0.5).then(function (s) { return s && s.size <= MAX_BYTES ? s : null; });
    });
}

/**
 * 캔버스를 채울 불투명 배경색. body 가 투명이면 html, 그것도 투명이면 흰색(코드 리뷰 H1) — 투명을 그대로 넘기면
 * Safari 는 WebP 를 못 만들어 JPEG 로 떨어지고, JPEG 에서 투명은 검정이 된다(iOS 캡처가 검은 바탕이 된다).
 */
function opaqueBg() {
  // 알파가 0 인 모든 표기(transparent · rgba(…, 0))를 투명으로 본다
  var t = /^transparent$|,\s*0(\.0+)?\)$/;
  var b = getComputedStyle(document.body).backgroundColor;
  if (b && !t.test(b)) return b;
  var h = getComputedStyle(document.documentElement).backgroundColor;
  return h && !t.test(h) ? h : '#fff';
}

window.__feedloopShot = function (opts) {
  var ignore = opts.ignore;
  var vw = window.innerWidth, vh = window.innerHeight;
  var sx = window.scrollX || window.pageXOffset || 0, sy = window.scrollY || window.pageYOffset || 0;
  var scale = Math.min(1, MAX_W / vw);
  var root = document.documentElement;
  return domToCanvas(root, {
    width: vw,
    height: vh,
    scale: scale,
    timeout: 4000,
    // 뷰포트만: 문서 전체를 그리고 자르면 긴 페이지에서 캔버스 한도(iOS 1,670만 화소)에 걸린다.
    // 루트를 스크롤만큼 되돌려 놓고 뷰포트 크기로 그린다
    style: { transform: 'translate(' + -sx + 'px,' + -sy + 'px)', transformOrigin: '0 0' },
    backgroundColor: opaqueBg(),
    filter: function (n) {
      if (n.nodeType !== 1) return true;
      if (ignore && n === ignore) return false;
      return !(n.hasAttribute && n.hasAttribute('data-feedloop-pick'));
    },
    fetch: { requestInit: { credentials: 'omit', mode: 'cors', cache: 'force-cache' } },
  })
    .then(encode)
    .then(function (blob) {
      if (!blob) return null;
      return fetch(opts.api + '/shots?visitorId=' + encodeURIComponent(opts.visitorId), {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': blob.type },
        credentials: 'omit',
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          return d && d.shotId ? { id: d.shotId, thumb: URL.createObjectURL(blob) } : null;
        });
    })
    .catch(function () { return null; });
};

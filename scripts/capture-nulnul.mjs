/**
 * 널널투어 화면을 우리 오리진으로 가져오는 캡처기 (2026-09-18, 레인 A)
 *
 * 왜 — 랜딩 데모가 「진짜 서비스를 만지는 느낌」이어야 하는데, 널널투어는 **다른 오리진**이라
 * iframe 으로 띄우면 우리가 그 안을 만질 수 없다. 반짝이는 안내를 버튼 위에 붙일 수도,
 * 「이 버튼만 누르게」 막을 수도 없다. 같은 오리진으로 가져오면 그게 전부 된다.
 *
 * 무엇을 하나 — 화면이 다 그려진 뒤의 HTML 을 통째로 받아, 그 안이 부르는 이미지·CSS·폰트를
 * 전부 내려받아 `public/demo/nulnul/` 에 self-contained 로 심는다. 스크립트는 걷어낸다
 * (하이드레이션이 돌면 남의 API 를 부르다 화면이 비어 버린다 — 우리가 필요한 건 «그려진 결과»다).
 *
 * 🔴 널널투어는 우리가 만든 서비스다. 사진 출처 표기(CC BY 등)는 원본 화면에 있는 그대로
 *    따라온다 — 그 줄을 지우지 않는다.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SITE = 'https://nulnul.vercel.app';
const mode = process.argv[2] ?? 'capture';
const pageUrl = process.argv[3] ?? SITE + '/';
const outDir = process.argv[4] ?? 'public/demo/nulnul';

const abs = (u) => { try { return new URL(u, pageUrl).href; } catch { return null; } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2 });
await page.goto(pageUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

// 「목록」 탭처럼 눌러야 나오는 것은 없지만, 캐러셀 등 지연 로딩을 위해 한 번 훑는다
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1200);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);

if (mode === 'list') {
  const found = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('img').forEach((i) => { if (i.currentSrc) out.add(i.currentSrc); if (i.src) out.add(i.src); });
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') [...bg.matchAll(/url\(["']?([^"')]+)/g)].forEach((m) => out.add(m[1]));
    });
    document.querySelectorAll('link[rel=preload], link[rel=icon], link[rel=apple-touch-icon]').forEach((l) => out.add(l.href));
    return [...out];
  });
  console.log(found.join('\n'));
  await browser.close();
  process.exit(0);
}

await mkdir(path.join(outDir, 'a'), { recursive: true });

/** 받아온 것 캐시 — 같은 파일을 두 번 받지 않는다 */
const saved = new Map();
async function grab(url) {
  const u = abs(url);
  if (!u || u.startsWith('data:')) return url;
  if (saved.has(u)) return saved.get(u);
  const res = await page.context().request.get(u).catch(() => null);
  if (!res || !res.ok()) { console.warn('  ! 못 받음', u.slice(0, 110)); saved.set(u, u); return u; }
  const buf = await res.body();
  const type = res.headers()['content-type'] ?? '';
  const ext =
    type.includes('css') ? 'css' :
    type.includes('svg') ? 'svg' :
    type.includes('png') ? 'png' :
    type.includes('webp') ? 'webp' :
    type.includes('avif') ? 'avif' :
    type.includes('jpeg') ? 'jpg' :
    type.includes('woff2') ? 'woff2' :
    type.includes('font') ? 'woff' :
    type.includes('json') ? 'json' : 'bin';
  const name = createHash('sha1').update(u).digest('hex').slice(0, 12) + '.' + ext;
  let body = buf;
  if (ext === 'css') {
    // CSS 안의 url(...) 도 같이 끌어온다 — 폰트가 여기 걸려 있다
    let css = buf.toString('utf8');
    const refs = [...css.matchAll(/url\((["']?)([^"')]+)\1\)/g)].map((m) => m[2]);
    for (const r of refs) {
      if (r.startsWith('data:')) continue;
      const local = await grab(new URL(r, u).href);
      // ⚠️ CSS 안의 경로는 **그 CSS 파일 자리** 기준이다. `grab` 이 주는 `a/이름` 을 그대로 넣으면
      //    CSS 자신이 이미 `a/` 안에 있어서 `a/a/이름` 을 찾는다 — 폰트가 통째로 안 걸린다
      //    (2026-09-18 발견: 그전까지 떠 온 화면은 전부 시스템 폰트로 폴백하고 있었다).
      css = css.split(r).join(local.replace(/^a\//, ''));
    }
    body = Buffer.from(css, 'utf8');
  }
  await writeFile(path.join(outDir, 'a', name), body);
  const rel = 'a/' + name;
  saved.set(u, rel);
  console.log('  ↓', (buf.length / 1024).toFixed(0).padStart(5), 'KB', rel, '←', u.slice(0, 90));
  return rel;
}

// ── 페이지가 실제로 쓰는 자산을 모은다 ────────────────────────────
const assets = await page.evaluate(() => {
  const imgs = [];
  document.querySelectorAll('img').forEach((i, n) => {
    i.setAttribute('data-cap', String(n));
    imgs.push({ n, src: i.currentSrc || i.src });
  });
  // SVG 안의 <image href> 도 사진이다 — 널널투어 전국 지도가 관광지 사진을 이걸로 박는다.
  // `<img>` 만 훑으면 그 한 장이 404 로 남아 지도에 구멍이 뚫린다(2026-09-18 실측).
  const svgs = [];
  document.querySelectorAll('image[href], image[xlink\\:href]').forEach((el, n) => {
    el.setAttribute('data-cap-svg', String(n));
    svgs.push({ n, src: el.getAttribute('href') || el.getAttribute('xlink:href') });
  });
  const css = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
  return { imgs, svgs, css };
});

console.log(`이미지 ${assets.imgs.length}장(+SVG ${assets.svgs.length}) · CSS ${assets.css.length}개 내려받는 중…`);
const imgMap = {};
for (const { n, src } of assets.imgs) imgMap[n] = await grab(src);
const svgMap = {};
for (const { n, src } of assets.svgs) svgMap[n] = await grab(src);
const cssMap = {};
for (const href of assets.css) cssMap[href] = await grab(href);

// ── HTML 을 우리 것으로 고쳐 쓴다 ─────────────────────────────────
const html = await page.evaluate(({ imgMap, svgMap, cssMap }) => {
  const doc = document.documentElement.cloneNode(true);
  // 스크립트는 전부 걷어낸다 — 하이드레이션이 돌면 남의 API 를 부르다 화면이 비워진다
  doc.querySelectorAll('script, noscript').forEach((s) => s.remove());
  doc.querySelectorAll('link[rel=preload], link[rel=prefetch], link[rel=modulepreload]').forEach((l) => l.remove());
  // Next 개발 서버가 끼워 넣는 폰트(`/__nextjs_font/…`)는 **프로덕션에 없는 주소**다.
  // 그대로 두면 배포된 사본에서 404 가 난다(2026-09-18, 우리 앱 화면을 떠 오면서 발견).
  doc.querySelectorAll('style').forEach((el) => {
    if ((el.textContent ?? '').includes('__nextjs_font')) el.remove();
  });
  doc.querySelectorAll('next-route-announcer').forEach((el) => el.remove());
  // 연습용 화면이 스스로 띄우는 「여기를 눌러보세요」 링(`DemoHint`)은 떠 오지 않는다.
  // 가이드 데모는 단계마다 **자기 링**을 씌우는데, 사본에 이 링까지 박혀 있으면 빨간 링이
  // 두 개가 되어 어느 쪽이 지금 할 일인지 알 수 없다(ny 지적 2026-09-18).
  doc.querySelectorAll('[data-demo-hint]').forEach((el) => el.remove());
  doc.querySelectorAll('img[data-cap]').forEach((i) => {
    const local = imgMap[i.getAttribute('data-cap')];
    if (local) { i.setAttribute('src', local); i.removeAttribute('srcset'); i.removeAttribute('data-cap'); i.setAttribute('loading', 'eager'); }
  });
  doc.querySelectorAll('image[data-cap-svg]').forEach((el) => {
    const local = svgMap[el.getAttribute('data-cap-svg')];
    if (local) { el.setAttribute('href', local); el.removeAttribute('xlink:href'); el.removeAttribute('data-cap-svg'); }
  });
  doc.querySelectorAll('link[rel=stylesheet]').forEach((l) => {
    const local = cssMap[l.href];
    if (local) l.setAttribute('href', local);
  });
  return '<!doctype html>\n' + doc.outerHTML;
}, { imgMap, svgMap, cssMap });

await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
console.log(`\n저장: ${outDir}/index.html (${(html.length / 1024).toFixed(0)} KB)`);
await browser.close();

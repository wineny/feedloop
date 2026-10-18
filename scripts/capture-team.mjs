/**
 * 팀 화면(우리 앱의 운영자 화면) 사본을 한 번에 다시 뜬다 — 뒷정리까지. (2026-09-18, 레인 A)
 *
 * 왜 이 스크립트가 생겼나 — `capture-nulnul.mjs` 는 한 장을 뜰 뿐이고, 그 «뒤»에 손으로 해야
 * 하는 일이 셋 있었다: ①세 장의 `a/` 를 `team-a/` 한 벌로 합치고 ②HTML 의 `"a/` 를
 * `"../team-a/` 로 바꾸고 ③아무도 안 부르는 폰트를 버리는 것(안 버리면 5MB 가 넘는다).
 * 손으로 하면 «다시 뜰 때마다» 그걸 다 기억해야 하고, 하나라도 빠뜨리면 배포된 사본에서
 * 404 가 나거나 용량이 불어난다. 그래서 절차를 통째로 여기 담았다.
 *
 * 쓰는 법 — dev 서버(3001)를 띄워 두고:
 *   node scripts/capture-team.mjs
 *
 * 🔴 `?demo=1` 로만 뜬다. 로그인한 진짜 운영자 화면을 뜨면 실방문자 이름·이메일이 제출물에
 *    박힌다(FAQ 「개인정보 포함 금지」). 그 증거가 화면의 「예시 데이터로 둘러보는 중이에요」
 *    배너이고, `__tests__/demo-sandbox.test.ts` 가 배너 없는 사본을 통과시키지 않는다.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.DEMO_BASE ?? 'http://localhost:3001';
const SHARED = 'public/demo/team-a';

/** 뜰 화면들. `out` 이름이 곧 `PAGE_SRC`(script.ts) 의 경로다 */
const PAGES = [
  { out: 'team-inbox', url: `${BASE}/inbox?demo=1` },
  { out: 'team-groups', url: `${BASE}/dashboard?demo=1` },
  { out: 'team-pr', url: `${BASE}/monitor?demo=1` },
];

await mkdir(SHARED, { recursive: true });

for (const { out, url } of PAGES) {
  const dir = `public/demo/${out}`;
  console.log(`\n■ ${out} ← ${url}`);
  execFileSync('node', ['scripts/capture-nulnul.mjs', 'capture', url, dir], { stdio: 'inherit' });

  // ① 자산을 한 벌로 합친다. 이름이 «URL 의 sha1» 이라 같은 이름이면 같은 파일이다
  const assetDir = path.join(dir, 'a');
  const names = await readdir(assetDir).catch(() => []);
  for (const n of names) await rename(path.join(assetDir, n), path.join(SHARED, n));
  await rm(assetDir, { recursive: true, force: true });

  // ② HTML 이 그 한 벌을 보게 한다
  const htmlPath = path.join(dir, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  await writeFile(htmlPath, html.split('"a/').join('"../team-a/'), 'utf8');
  console.log(`  → 자산 ${names.length}개를 ${SHARED} 로, 경로 ../team-a/ 로 고침`);
}

// ③ 아무도 «실제로» 안 부르는 것을 버린다.
//
//    🔴 CSS 만 읽어서는 못 버린다. 우리 앱의 글꼴은 한글을 100 조각쯤으로 나눠 `unicode-range`
//       로 걸어 두는데, CSS 에는 그 100개가 전부 `url(...)` 로 적혀 있고 브라우저는 **그 화면에
//       실제로 쓰인 글자의 조각만** 내려받는다. CSS 를 따라가며 모으면 안 쓰는 96개까지 남아
//       612KB 로 끝날 것이 3.0MB 가 된다(2026-09-18 실측).
//    그래서 사본을 «진짜로 띄워 보고» 브라우저가 부른 것만 남긴다. 혹시 덜 남겨서 404 가 나면
//    실측(가이드 데모 8단계 완주, 4xx 0)이 잡는다.
const htmls = await Promise.all(
  PAGES.map(({ out }) => readFile(`public/demo/${out}/index.html`, 'utf8')),
);
const referenced = new Set();
for (const h of htmls) for (const m of h.matchAll(/team-a\/([\w.-]+)/g)) referenced.add(m[1]);

const browser = await chromium.launch();
for (const { out } of PAGES) {
  // 폭을 바꿔 가며 훑는다 — 좁은 화면에서만 나오는 글자가 있으면 그 조각도 같이 걸린다
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 1200 } });
    const page = await ctx.newPage();
    page.on('request', (r) => {
      const m = /\/demo\/team-a\/([\w.-]+)/.exec(r.url());
      if (m) referenced.add(m[1]);
    });
    await page.goto(`${BASE}/demo/${out}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.fonts?.ready);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);
    await ctx.close();
  }
}
await browser.close();

const all = await readdir(SHARED);
let dropped = 0;
let keptBytes = 0;
for (const n of all) {
  if (referenced.has(n)) {
    keptBytes += (await readFile(path.join(SHARED, n))).length;
    continue;
  }
  await rm(path.join(SHARED, n));
  dropped++;
}
console.log(
  `\n✅ 사본 ${PAGES.length}장 · 공용 자산 ${all.length - dropped}개(${(keptBytes / 1024 / 1024).toFixed(1)}MB) · 안 불리는 ${dropped}개 버림`,
);

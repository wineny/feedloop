/**
 * 가이드 데모의 마지막 화면 — 방문자가 받은 되돌림 메일을 사본으로 뜬다. (2026-09-18, 레인 A)
 *
 * 본문은 `scripts/render-demo-mail.ts` 가 **프로덕션과 같은 함수**로 만든다(손으로 그리지 않는다).
 * 여기서는 그걸 임시 파일로 내놓고, 다른 사본들과 같은 캡처기로 떠서 self-contained 로 심는다 —
 * 그래야 메일 본문이 부르는 바깥 이미지(Fluent 3D 이모지)까지 우리 주소로 내려온다.
 * 안 그러면 심사 기간에 그 CDN 이 흔들릴 때 마지막 화면에 구멍이 뚫린다.
 *
 * 쓰는 법 — dev 서버(3001)를 띄워 두고:
 *   node scripts/capture-mail.mjs
 */
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';

const BASE = process.env.DEMO_BASE ?? 'http://localhost:3001';
const TMP = 'public/demo/_mail-src.html';

execFileSync('npx', ['tsx', 'scripts/render-demo-mail.ts', TMP], { stdio: 'inherit' });
try {
  execFileSync('node', ['scripts/capture-nulnul.mjs', 'capture', `${BASE}/demo/_mail-src.html`, 'public/demo/mail'], {
    stdio: 'inherit',
  });
} finally {
  // 임시 원본은 남기지 않는다 — 남으면 `/demo/_mail-src.html` 이 바깥을 부르는 채로 배포된다
  await rm(TMP, { force: true });
}
console.log('\n✅ public/demo/mail/index.html');

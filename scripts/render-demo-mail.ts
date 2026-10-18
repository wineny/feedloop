/**
 * 가이드 데모의 마지막 화면 — 「보낸 사람에게 실제로 간 메일」 을 만든다. (2026-09-18, 레인 A)
 *
 * 왜 — 데모가 「대화창에 반영됐어요 카드가 떴다」로 끝나면, 메일까지 간다는 것이 말로만 남는다
 * (ny 「마지막에는 유저한테 메일이 발송된 화면까지 이어지면 좋겠어」).
 *
 * 🔴 본문을 **손으로 그리지 않는다.** `renderLoopClosedEmail` 은 프로덕션에서 진짜 메일을 만들 때
 *    쓰는 바로 그 함수다(`src/lib/email/templates.ts`). 여기서 부르는 것이 곧 방문자가 받는 것이고,
 *    템플릿을 고치면 이 화면도 같이 바뀐다 — 데모와 제품이 갈라질 수가 없다.
 *    바깥을 감싼 메일함 틀(보낸사람·제목·받는사람 줄)만 여기서 그린다. 그건 어느 메일 앱에나
 *    있는 껍데기지 우리 제품 화면이 아니다.
 *
 * 쓰는 법 — `scripts/capture-mail.mjs` 가 이걸 부르고, 나온 임시 HTML 을 캡처기로 떠서
 * `public/demo/mail/` 에 self-contained 로 심은 뒤 임시 파일을 지운다.
 */
import { writeFile } from 'node:fs/promises';
import { renderLoopClosedEmail } from '../src/lib/email/templates';

/** 데모 각본과 한 글자도 어긋나면 안 된다 — `script.ts` 의 `GROUP_TITLE`·`mock-data.ts` 와 같은 사건 */
const TITLE = '「쿠폰 받기」를 눌러도 쿠폰이 발급되지 않음';
const TO = 'sujin@example.com';
const SERVICE = '널널투어';

const mail = renderLoopClosedEmail({
  serviceName: SERVICE,
  recipientName: '이수진',
  title: TITLE,
  prNumber: 128,
  prUrl: 'https://github.com/example/demo/pull/128',
  siteUrl: 'https://nulnul.vercel.app',
});

/**
 * 메일함 껍데기 — 어느 메일 앱에나 있는 머리글. 본문은 손대지 않는다.
 * 폭 처리는 본문(`emailShell`)과 똑같이 «속성 600 + width:100% + max-width» 셋이다 —
 * 껍데기만 안 줄어들면 좁은 화면에서 머리글이 본문보다 넓게 삐져나간다.
 */
const header = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3f2;padding:20px 16px 0">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #eeeae9;border-radius:14px">
      <tr><td style="padding:16px 20px">
        <div style="font-size:17px;font-weight:800;color:#191d1b;line-height:1.4">${mail.subject}</div>
        <div style="margin-top:8px;font-size:13px;color:#7b7573;line-height:1.6">
          보낸사람 <b style="color:#191d1b">${SERVICE}</b> · 받는사람 ${TO}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>`;

// `emailShell` 이 만든 문서의 <body> 바로 뒤에 껍데기를 끼운다
const at = mail.html.indexOf('>', mail.html.indexOf('<body')) + 1;
const html = mail.html.slice(0, at) + header + mail.html.slice(at);

// ⚠️ tsx 가 이 파일을 CJS 로 바꿔 돌리기 때문에 최상위 `await` 는 못 쓴다 — 함수로 감싼다
async function main() {
  const out = process.argv[2] ?? 'public/demo/_mail-src.html';
  await writeFile(out, html, 'utf8');
  console.log(`메일 본문 렌더 → ${out} (${(html.length / 1024).toFixed(0)} KB) · 제목 「${mail.subject}」`);
}

void main();

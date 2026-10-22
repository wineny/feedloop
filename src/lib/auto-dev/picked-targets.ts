// PR 본문에서 「제보자가 화면에서 짚은 요소」를 다시 읽는다 (B3 3차 후속, 2026-09-16).
//
// 왜 — 짚은 요소를 레포 원본과 대조한 결과(「이 파일이 그린다」)는 엔진이 PR 본문에만 쓴다. 담당자가
// 앱 안에서 반영을 판단하는 「수정 PR」 상세(I-19)엔 그 줄이 없어 GitHub 을 열어야 보였다. 본문은 상세가
// 이미 GitHub 에서 읽고 있으니(`/api/auto-dev/runs/[id]/pr`) 거기서 우리 형식만 파싱해 한 줄로 보여준다.
// DB 컬럼을 늘리지 않는 이유 — 옛 실행도 같은 본문 형식이라 파싱이면 전부 덮인다.
//
// 이 파일은 의존성 0 이다. 클라이언트 패널이 타입을 가져간다(`pr-review-client-boundary` 테스트가 런타임
// import 를 막는다 — 타입 import 만).
//
// 형식은 `lib/widget/verify-context.ts` `formatVerifiedForPrBody` 가 정한다 — 거기를 고치면 여기도.

export interface PickedTarget {
  /** 「「서울 종로」 버튼」 */
  label: string;
  status: 'confirmed' | 'unverified';
  /** confirmed 일 때 그리는 파일(≤3) */
  files: string[];
  /** confirmed 일 때 「CSS 모듈 클래스 'pill', 글자 '서울 종로'」 */
  evidence?: string;
}

const MAX_TARGETS = 3;
const MAX_LABEL = 80;
/** `- 짚은 요소: 「서울 종로」 버튼 → \`a\`, \`b\` 이(가) 그린다 (원본에서 확인: …)` */
const CONFIRMED_LINE = /^- 짚은 요소: (.+?) → (.+?) 이\(가\) 그린다(?: \(원본에서 확인: (.*)\))?\s*$/;
/** 영어판(i18n 4d 이후 PR 본문): `- Picked element: "Join" button → \`a\`, \`b\` renders it (verified in the source: …)` */
const CONFIRMED_LINE_EN = /^- Picked element: (.+?) → (.+?) renders it(?: \(verified in the source: (.*)\))?\s*$/;
/** 미확인 절 머리. 1차 「DOM 값이라 레포와 대조 불가」·3차 「레포 원본에서 확인하지 못함」 둘 다, 영어판도 */
const UNVERIFIED_HEAD = /^(?:제보자 브라우저가 보낸 «짚은 요소»|Picked elements sent by the reporter's browser)/;
/** 미확인 절의 요소 첫 줄 `· 「x」 버튼 <button> — 페이지 … (2건)` */
const UNVERIFIED_ITEM = /^· (.+?) <[a-z0-9-]+>/i;

function cut(s: string): string {
  const t = s.trim();
  return Array.from(t).length > MAX_LABEL ? `${Array.from(t).slice(0, MAX_LABEL).join('')}…` : t;
}

/**
 * PR 본문(우리 엔진이 쓴 것)에서 짚은 요소를 뽑는다. 우리 형식이 아니면 빈 배열 — 사람이 쓴 PR 이나
 * 옛 본문에서 억지로 찾지 않는다. 라벨·파일명은 본문에 있던 그대로이고(엔진이 이미 한 줄·백틱 없이 쓴 값),
 * 화면은 텍스트 노드로만 그린다.
 */
export function extractPickedTargets(prBody: string | null | undefined): PickedTarget[] {
  if (!prBody) return [];
  const out: PickedTarget[] = [];
  const lines = prBody.split('\n');
  let inUnverified = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (out.length >= MAX_TARGETS) break;
    const c = line.match(CONFIRMED_LINE) ?? line.match(CONFIRMED_LINE_EN);
    if (c) {
      const files = Array.from(c[2].matchAll(/`([^`]+)`/g), (m) => m[1].trim()).filter(Boolean).slice(0, 3);
      if (files.length === 0) continue;
      out.push({ label: cut(c[1]), status: 'confirmed', files, evidence: c[3]?.trim() || undefined });
      inUnverified = false;
      continue;
    }
    if (UNVERIFIED_HEAD.test(line)) {
      inUnverified = true;
      continue;
    }
    if (inUnverified) {
      // 절은 빈 줄이나 다음 마크다운 제목에서 끝난다
      if (line.trim() === '' || line.startsWith('#')) {
        inUnverified = false;
        continue;
      }
      const u = line.match(UNVERIFIED_ITEM);
      if (u) out.push({ label: cut(u[1]), status: 'unverified', files: [] });
    }
  }
  return out;
}

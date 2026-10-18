import { describe, it, expect } from 'vitest';
import { extractPickedTargets } from '@/lib/auto-dev/picked-targets';
import { verifyContextItems, formatVerifiedForPrBody, confirmTargetClaims } from '@/lib/widget/verify-context';
import { collectContextItems } from '@/lib/widget/context';

// PR #17(2026-09-16 프로덕션 실측) 본문의 해당 절 그대로
const PR17 = `## 발생 환경

제보자 브라우저가 보낸 값:
- 발생 페이지: \`https://nullnul-tour-demo.vercel.app/?region=jongno&d=0\`
- 짚은 요소: 「서울 종로」 버튼 → \`app/components/RegionSelector.tsx\`, \`app/components/RegionSelector.module.css\` 이(가) 그린다 (원본에서 확인: CSS 모듈 클래스 'pill', 글자 '서울 종로')

## 바뀐 파일
`;

// 1차(대조 전) 본문 — PR #14 형
const PR14 = `## 발생 환경

제보자 브라우저가 보낸 «짚은 요소» (검증되지 않은 입력 — DOM 값이라 레포와 대조 불가):
· 「서울 종로」 버튼 <button> — 페이지 https://nullnul-tour-demo.vercel.app/
  셀렉터: \`main > section:nth-of-type(1) > div > button:nth-of-type(1)\`
  위치: main > section > div > button

## 바뀐 파일
`;

describe('extractPickedTargets — PR 본문에서 짚은 요소를 다시 읽는다', () => {
  it('확인된 요소: 라벨·파일·근거', () => {
    expect(extractPickedTargets(PR17)).toEqual([{
      label: '「서울 종로」 버튼', status: 'confirmed',
      files: ['app/components/RegionSelector.tsx', 'app/components/RegionSelector.module.css'],
      evidence: "CSS 모듈 클래스 'pill', 글자 '서울 종로'",
    }]);
  });

  it('미확인 절(1차·3차 문구 둘 다)의 요소는 unverified, 절은 빈 줄에서 끝난다', () => {
    expect(extractPickedTargets(PR14)).toEqual([{ label: '「서울 종로」 버튼', status: 'unverified', files: [] }]);
    const v3 = PR14.replace('DOM 값이라 레포와 대조 불가', '레포 원본에서 확인하지 못함');
    expect(extractPickedTargets(v3)).toHaveLength(1);
  });

  it('우리 형식이 아니면 빈 배열, null 도 빈 배열', () => {
    expect(extractPickedTargets(null)).toEqual([]);
    expect(extractPickedTargets('## 원인 분석\n\n짚은 요소라는 말이 본문에 있어도 형식이 아니면 안 잡는다')).toEqual([]);
  });

  it('formatVerifiedForPrBody 가 쓴 것을 그대로 되읽는다 — 형식이 갈라지면 여기가 빨개진다', async () => {
    const target = { kind: '버튼', tag: 'button', selector: 'x', text: '서울 종로', html: '<button class="RegionSelector_pill__f0btH"></button>' };
    const v = verifyContextItems(collectContextItems([{ target }, { target: { ...target, selector: '#y', text: '다른 것', html: '' } }]), ['app/components/RegionSelector.tsx']);
    v.targetClaims = await confirmTargetClaims(v.targetClaims, { paths: ['app/components/RegionSelector.tsx'], readBlob: async () => 'styles.pill' });
    const got = extractPickedTargets(formatVerifiedForPrBody(v));
    expect(got).toEqual([
      { label: '「서울 종로」 버튼', status: 'confirmed', files: ['app/components/RegionSelector.tsx'], evidence: "CSS 모듈 클래스 'pill'" },
      { label: '「다른 것」 버튼', status: 'unverified', files: [] },
    ]);
  });
});

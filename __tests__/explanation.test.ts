import { describe, it, expect } from 'vitest';
import {
  normalizeExplanation,
  groundUnverifiedFiles,
  makeRepoPathResolver,
  parseStoredExplanation,
  extractLegacyExplanation,
  withVerdict,
  UNVERIFIED_MAX_ITEMS,
  EXPLANATION_FIELD_MAX,
} from '@/lib/auto-dev/explanation';

// 담당자용 설명은 보강이지 필수 재료가 아니다 — 모델이 형식을 어기면 그 부분만 버리고
// 수정안은 그대로 간다. 반대로 「코드로 확인」 항목의 파일은 레포에 실재해야만 버튼이 된다.

describe('normalizeExplanation', () => {
  it('모델 JSON 을 우리 형태로 옮긴다', () => {
    const out = normalizeExplanation({
      explanation: { problem: '문제', change: '바꿈', effect: '효과' },
      unverified: [
        { text: '파일을 못 봤다', verifiable_by: 'code', files: ['lib/a.ts'] },
        { text: '데이터 문제일 수 있다', verifiable_by: 'reporter', question: '어느 날짜인가요?' },
        { text: '아이폰에서만', verifiable_by: 'human' },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.source).toBe('model');
    expect(out!.unverified.map((u) => u.verifiableBy)).toEqual(['code', 'reporter', 'human']);
    expect(out!.unverified[0].files).toEqual(['lib/a.ts']);
    expect(out!.unverified[1].question).toBe('어느 날짜인가요?');
    // reporter 항목엔 파일이, code 항목엔 질문이 붙지 않는다
    expect(out!.unverified[1].files).toEqual([]);
    expect(out!.unverified[0].question).toBeNull();
    expect(out!.unverified.every((u) => u.verdict === null)).toBe(true);
  });

  it('explanation 이 없거나 비면 null — 수정안을 막지 않는다', () => {
    expect(normalizeExplanation({})).toBeNull();
    expect(normalizeExplanation({ explanation: 'string' })).toBeNull();
    expect(normalizeExplanation({ explanation: { problem: '', change: '' } })).toBeNull();
  });

  it('verifiable_by 가 없으면 파일→code, 질문→reporter, 아니면 human', () => {
    const out = normalizeExplanation({
      explanation: { problem: 'p', change: 'c' },
      unverified: [{ text: 'a', files: ['x.ts'] }, { text: 'b', question: 'q' }, { text: 'c' }],
    })!;
    expect(out.unverified.map((u) => u.verifiableBy)).toEqual(['code', 'reporter', 'human']);
  });

  it('읽을 파일이 없는 code 항목은 human 으로 내린다 — 버튼을 눌러도 할 일이 없다', () => {
    const out = normalizeExplanation({
      explanation: { problem: 'p', change: 'c' },
      unverified: [{ text: 'a', verifiable_by: 'code', files: [] }],
    })!;
    expect(out.unverified[0].verifiableBy).toBe('human');
  });

  it('상한 — 항목 6개, 필드 600자, 파일 3개. 거절이 아니라 자른다', () => {
    const out = normalizeExplanation({
      explanation: { problem: 'x'.repeat(2000), change: 'c' },
      unverified: Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, files: ['a', 'b', 'c', 'd', 'e'] })),
    })!;
    expect(out.problem.length).toBe(EXPLANATION_FIELD_MAX);
    expect(out.unverified).toHaveLength(UNVERIFIED_MAX_ITEMS);
    expect(out.unverified[0].files).toHaveLength(3);
  });

  it('text 가 비거나 문자열이 아닌 항목은 버린다, 개행은 공백으로 접는다', () => {
    const out = normalizeExplanation({
      explanation: { problem: 'p\n\n  q', change: 'c' },
      unverified: [{ text: '' }, { text: 42 }, null, { text: 'ok' }],
    })!;
    expect(out.problem).toBe('p q');
    expect(out.unverified.map((u) => u.text)).toEqual(['ok']);
  });
});

describe('groundUnverifiedFiles + makeRepoPathResolver', () => {
  const pool = new Set(['app/lib/coupons/identity.ts', 'app/lib/view.ts', 'app/app/api/coupons/mine/route.ts', 'app/lib/x/dup.ts', 'app/lib/y/dup.ts']);
  const resolveImport = (spec: string) => (spec === '@/lib/coupons/identity' ? 'app/lib/coupons/identity.ts' : null);
  const resolve = makeRepoPathResolver(pool, resolveImport, 'app/app/api/coupons/mine/route.ts');

  it('정확한 경로 · 별칭 · 꼬리(유일) 를 푼다', () => {
    expect(resolve('app/lib/view.ts')).toBe('app/lib/view.ts');
    expect(resolve('@/lib/coupons/identity')).toBe('app/lib/coupons/identity.ts');
    expect(resolve('identity.ts')).toBe('app/lib/coupons/identity.ts');
    expect(resolve('coupons/identity.ts')).toBe('app/lib/coupons/identity.ts');
  });

  it('꼬리가 둘 이상 맞으면 null — 어느 것인지 모르면 안 읽는다', () => {
    expect(resolve('dup.ts')).toBeNull();
    expect(resolve('nope.ts')).toBeNull();
  });

  it('못 푸는 파일은 버리고, 하나도 안 남으면 human 으로 내린다', () => {
    const base = normalizeExplanation({
      explanation: { problem: 'p', change: 'c' },
      unverified: [
        { text: 'a', verifiable_by: 'code', files: ['identity.ts', 'ghost.ts'] },
        { text: 'b', verifiable_by: 'code', files: ['ghost.ts'] },
        { text: 'c', verifiable_by: 'reporter', question: 'q' },
      ],
    })!;
    const out = groundUnverifiedFiles(base, resolve);
    expect(out.unverified[0]).toMatchObject({ verifiableBy: 'code', files: ['app/lib/coupons/identity.ts'] });
    expect(out.unverified[1]).toMatchObject({ verifiableBy: 'human', files: [] });
    // reporter 는 건드리지 않는다
    expect(out.unverified[2]).toMatchObject({ verifiableBy: 'reporter', question: 'q' });
  });
});

describe('parseStoredExplanation', () => {
  it('DB 값을 검증해 돌려준다 — verdict 포함', () => {
    const out = parseStoredExplanation({
      problem: 'p', change: 'c', effect: 'e', source: 'model',
      unverified: [{
        text: 't', verifiableBy: 'code', files: ['a.ts'],
        verdict: { status: 'fix_does_not_hold', text: 'v', checkedAt: '2026-09-13T00:00:00Z', files: ['a.ts'] },
      }],
    });
    expect(out?.unverified[0].verdict?.status).toBe('fix_does_not_hold');
  });

  it('형태가 아니면 null, 이상한 verdict 는 null 로', () => {
    expect(parseStoredExplanation(null)).toBeNull();
    expect(parseStoredExplanation('x')).toBeNull();
    expect(parseStoredExplanation({ problem: '', change: '' })).toBeNull();
    const out = parseStoredExplanation({
      problem: 'p', change: 'c',
      unverified: [{ text: 't', verifiableBy: 'weird', verdict: { status: 'nope' } }],
    })!;
    expect(out.unverified[0].verifiableBy).toBe('human');
    expect(out.unverified[0].verdict).toBeNull();
  });
});

describe('extractLegacyExplanation — 이 기능 전 실행의 PR 본문', () => {
  const body = [
    '`resolveCouponUserId()` 호출을 try 안으로 옮겨 모든 실패가 500 JSON 으로 수렴하게 했습니다.',
    '',
    '## 원인 분석',
    '',
    'identity 조회가 try 바깥이라 예외가 그대로 전파될 수 있었다.',
    '',
    '## 근거가 된 유저 피드백',
    '',
    '> 쿠폰함이 안 보여요',
    '',
    '## 머지 전 확인',
    '',
    '- [ ] identity.ts 내부 구현을 보지 못해 예외 상황이 존재하는지 확인 못 함',
    '- [ ] ⚠️ 정동커피상회 건은 데이터 쪽 문제일 가능성',
    '- [ ] 이 수정이 실제로 위 증상을 없애는지 직접 확인',
    '- [ ] 빌드·타입 검사 통과 확인',
    '',
    '---',
    '',
    '🤖 이 PR 은 유저 피드백을 근거로 **Feedloop** 이 자동 생성했습니다.',
  ].join('\n');

  it('원인 분석 → 문제, 머리말 → 바꾼 것, 체크리스트 → human 항목 (고정 2줄 제외)', () => {
    const out = extractLegacyExplanation(body)!;
    expect(out.source).toBe('pr_body');
    expect(out.problem).toContain('예외가 그대로 전파');
    expect(out.change).toContain('try 안으로');
    expect(out.effect).toBe('');
    expect(out.unverified.map((u) => u.text)).toEqual([
      'identity.ts 내부 구현을 보지 못해 예외 상황이 존재하는지 확인 못 함',
      '정동커피상회 건은 데이터 쪽 문제일 가능성',
    ]);
    expect(out.unverified.every((u) => u.verifiableBy === 'human')).toBe(true);
  });

  it('본문이 없거나 우리 형식이 아니면 null', () => {
    expect(extractLegacyExplanation(null)).toBeNull();
    expect(extractLegacyExplanation('')).toBeNull();
    expect(extractLegacyExplanation('## 딴 절\n\n내용')).toBeNull();
    // 사람이 쓴 PR(프로브 PR 처럼 고정 절이 없음)은 머리말을 설명으로 띄우지 않는다
    expect(extractLegacyExplanation('Deployments / Checks 필드 실측용. 확인 뒤 닫는다.')).toBeNull();
  });
});

describe('withVerdict', () => {
  const base = normalizeExplanation({
    explanation: { problem: 'p', change: 'c' },
    unverified: [{ text: 'a', files: ['x.ts'] }, { text: 'b' }],
  })!;
  const verdict = { status: 'fix_holds' as const, text: 'ok', checkedAt: 'now', files: ['x.ts'] };

  it('그 항목에만 적는다', () => {
    const out = withVerdict(base, 0, verdict)!;
    expect(out.unverified[0].verdict).toEqual(verdict);
    expect(out.unverified[1].verdict).toBeNull();
    // 원본은 그대로
    expect(base.unverified[0].verdict).toBeNull();
  });

  it('없는 index 면 null', () => {
    expect(withVerdict(base, 2, verdict)).toBeNull();
    expect(withVerdict(base, -1, verdict)).toBeNull();
    expect(withVerdict(base, 1.5, verdict)).toBeNull();
  });
});

describe('isSafeRepoPath — 저장된 파일 경로는 레포 안 상대 경로만', () => {
  it('절대경로·..·백슬래시·제어문자·스킴을 거른다', async () => {
    const { isSafeRepoPath, parseStoredExplanation } = await import('@/lib/auto-dev/explanation');
    expect(isSafeRepoPath('app/lib/identity.ts')).toBe(true);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('../../../user/repos')).toBe(false);
    expect(isSafeRepoPath('app/../x.ts')).toBe(false);
    expect(isSafeRepoPath('app\\x.ts')).toBe(false);
    expect(isSafeRepoPath(`a${String.fromCharCode(0)}b`)).toBe(false);
    expect(isSafeRepoPath('https://evil')).toBe(false);
    expect(isSafeRepoPath('')).toBe(false);
    // 읽기 경로에서 걸러진다 — 컬럼이 손으로 고쳐져도 getContent 로 못 간다
    const out = parseStoredExplanation({
      problem: 'p', change: 'c',
      unverified: [{ text: 't', verifiableBy: 'code', files: ['../../x', 'app/ok.ts'] }],
    })!;
    expect(out.unverified[0].files).toEqual(['app/ok.ts']);
  });

  it('모델 출력(쓰기 경로)은 import 표기를 받는다 — grounding 이 실제 경로로 바꾼다', async () => {
    const { normalizeExplanation } = await import('@/lib/auto-dev/explanation');
    const out = normalizeExplanation({
      explanation: { problem: 'p', change: 'c' },
      unverified: [{ text: 't', verifiable_by: 'code', files: ['./identity', '../lib/x', '@/lib/y'] }],
    })!;
    expect(out.unverified[0].files).toEqual(['./identity', '../lib/x', '@/lib/y']);
  });
});

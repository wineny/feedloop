import { describe, it, expect } from 'vitest';
import { isCodeFixable, isSpecWorthy, groupAction } from '@/lib/groups/policy';

// 크론·화면·API 가 전부 이 판단을 본다. 기준이 흩어지면
// 화면은 막는데 크론은 도는 상태가 된다.

describe('묶음 분류별로 다음 행동이 갈린다', () => {
  it('버그와 UX 는 코드 수정 PR 대상', () => {
    expect(isCodeFixable('bug')).toBe(true);
    expect(isCodeFixable('ux')).toBe(true);
  });

  it('기능 요청은 PR 이 아니라 스펙 — 무엇을 만들지는 사람이 정한다', () => {
    expect(isCodeFixable('feature_request')).toBe(false);
    expect(isSpecWorthy('feature_request')).toBe(true);
    expect(groupAction('feature_request')).toBe('spec');
  });

  it('칭찬·문의·기타는 고칠 것이 없다', () => {
    for (const c of ['praise', 'cs', 'other']) {
      expect(isCodeFixable(c)).toBe(false);
      expect(isSpecWorthy(c)).toBe(false);
      expect(groupAction(c)).toBe('none');
    }
  });

  it('모르는 값은 아무것도 하지 않는다 (모델이 지어낸 분류 대비)', () => {
    expect(groupAction('완전히_새로운_분류')).toBe('none');
    expect(isCodeFixable('')).toBe(false);
  });
});

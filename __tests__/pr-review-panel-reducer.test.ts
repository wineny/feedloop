import { describe, it, expect } from 'vitest';
import { reduce, INITIAL } from '@/components/monitor/PrReviewPanel';

// 리뷰가 잡은 결함: [AI 에게 확인시키기] 완료/실패가 열려 있던 「반영하지 않기」 폼(사유·메모)을 지웠다.
// 확인시키기는 그 폼과 무관한 행동이라 mode·reason·note 를 건드리면 안 된다.

describe('PrReviewPanel reduce', () => {
  const closing = reduce(reduce(reduce(INITIAL, { type: 'open_close' }), { type: 'pick_reason', reason: 'duplicate' }), { type: 'note', note: '메모' });

  it('확인시키기 완료·실패는 열린 「반영하지 않기」 폼을 보존한다', () => {
    const started = reduce(closing, { type: 'verify_start', index: 0 });
    expect(started.verifying).toBe(0);
    const done = reduce(started, { type: 'verify_done' });
    expect(done).toMatchObject({ mode: 'closing', reason: 'duplicate', note: '메모', verifying: null });
    const failed = reduce(started, { type: 'verify_fail', error: 'x' });
    expect(failed).toMatchObject({ mode: 'closing', reason: 'duplicate', note: '메모', verifying: null, error: 'x' });
  });

  it('반영·닫기 완료(done)는 폼을 접고, 닫기 실패(fail)는 폼에 남긴다', () => {
    expect(reduce(closing, { type: 'done', notice: null })).toMatchObject({ mode: 'idle', reason: null, note: '' });
    const submitting = reduce(closing, { type: 'close_start' });
    expect(reduce(submitting, { type: 'fail', error: 'e' })).toMatchObject({ mode: 'closing', reason: 'duplicate', note: '메모', error: 'e' });
    expect(reduce(reduce(INITIAL, { type: 'merge_start' }), { type: 'fail', error: 'e' }).mode).toBe('idle');
  });
});

import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DraftGateLine, mergeErrorMessage } from '@/components/monitor/PrReviewPanel';
import { renderWithIntl, translator } from './helpers/intl';
import { effectiveBlock, needsPolling, type PrReviewData, type PrReviewResponse } from '@/lib/hooks/usePrReview';

// 초안 PR 게이트 화면(2026-10-09) — 상태 한 줄 · 반영 잠금 · 대기 중 폴링.

beforeAll(() => (globalThis as { React?: typeof React }).React = React);
afterAll(() => delete (globalThis as { React?: typeof React }).React);

type Build = PrReviewData['build'];
const build = (state: Build['state'], extra: Partial<Build> = {}): Build => ({
  state, description: null, targetUrl: null, updatedAt: null, unavailable: false, ...extra,
});
const line = (draftGate: PrReviewData['draftGate'] | undefined, b: Build = build('pending'), draftGateBlocked?: PrReviewData['draftGateBlocked']) =>
  renderWithIntl(React.createElement(DraftGateLine, { review: { draftGate, draftGateBlocked, build: b } as PrReviewData })).replaceAll('&#x27;', "'");

// 반영 실패 문구를 읽는 번역기 — 실제 영어 사전
const t = translator('monitor');

const response = (review: Partial<PrReviewData>, blockedBy: PrReviewResponse['blockedBy'] = null) =>
  ({ review: { build: build('unknown'), preview: { url: null, state: 'none' }, ...review }, blockedBy, legacyExplanation: null }) as unknown as PrReviewResponse;

describe('DraftGateLine', () => {
  it('waiting — 검사가 있으면 통과 뒤, 없으면 10분 뒤 바뀐다고 말한다', () => {
    expect(line('waiting')).toContain('Waiting for automatic checks');
    expect(line('waiting')).toContain('It becomes ready for review once they pass');
    expect(line('waiting', build('unknown'))).toContain('10 minutes after the PR opens');
  });

  it('failed — 실패한 검사 이름과 https 링크만 건다', () => {
    const html = line('failed', build('failure', {
      failedChecks: [
        { name: 'Vercel', url: 'https://vercel.com/x' },
        { name: 'lint', url: null },
        { name: 'evil', url: 'javascript:alert(1)' },
      ],
    }));
    expect(html).toContain('Automatic checks failed, so it stays a draft');
    expect(html).toContain('href="https://vercel.com/x"');
    expect(html).toContain('lint');
    expect(html).toContain('evil');
    expect(html).not.toContain('javascript:');
    expect(line('failed', build('failure'))).not.toContain('Failed checks:');
  });

  it('promoted — 검사 없이 바뀐 PR 에 「통과」라고 말하지 않는다', () => {
    expect(line('promoted', build('success'))).toContain('Passed the automatic checks and was marked ready for review');
    const noChecks = line('promoted', build('unknown'));
    expect(noChecks).not.toContain('Passed');
    expect(noChecks).toContain('There were no automatic checks to wait for');
  });

  it('unsupported 는 안내, not_draft·필드 없음(옛 응답·데모)은 아무것도 안 그린다', () => {
    expect(line('unsupported')).toContain("This repository doesn't support draft PRs, so it was opened directly");
    expect(line('not_draft')).toBe('');
    expect(line(undefined)).toBe('');
    expect(renderWithIntl(React.createElement(DraftGateLine, { review: null }))).toBe('');
  });

  it('awaiting_human·checks_unavailable — 권한이 없어 자동으로 안 바꿨고 직접 반영하라고 말한다', () => {
    const unavailable = build('unknown', { unavailable: true });
    for (const html of [line('awaiting_human', unavailable, 'checks_unavailable'), line('awaiting_human', unavailable), line('waiting', build('pending', { unavailable: true }), 'checks_unavailable')]) {
      expect(html).toContain("No permission to read check results, so it wasn't changed automatically");
      expect(html).toContain('Check it yourself and ship');
    }
  });

  it('잠금·쓰기·게이트 확인 실패는 같은 「잠시 문제」 한 줄', () => {
    for (const r of ['lock_unavailable', 'write_failed', 'gate_failed'] as const) {
      const html = line('waiting', build('unknown'), r);
      expect(html).toContain("Something went wrong, so it couldn't be changed automatically");
      expect(html).toContain('Will check again shortly');
      expect(html).not.toContain('Waiting for automatic checks');
    }
  });

  it('manual_draft — 담당자가 되돌린 초안은 자동으로 안 바꾼다고 말한다', () => {
    const html = line('waiting', build('success'), 'manual_draft');
    expect(html).toContain('The owner turned this PR back into a draft');
    expect(html).toContain("It won't be changed automatically");
  });

  it('빌드 실패는 다른 사유보다 먼저 보인다', () => {
    const html = line('failed', build('failure', { failedChecks: [{ name: 'Vercel', url: null }] }), 'write_failed');
    expect(html).toContain('Automatic checks failed, so it stays a draft');
    expect(html).not.toContain('Something went wrong');
  });

  it('화면 문구에 「머지」(merge)를 쓰지 않는다 — 반영은 ship', () => {
    for (const g of ['waiting', 'failed', 'promoted', 'unsupported', 'awaiting_human'] as const) expect(line(g)).not.toMatch(/merge/i);
    for (const r of ['lock_unavailable', 'write_failed', 'gate_failed', 'manual_draft', 'checks_unavailable'] as const) {
      expect(line('waiting', build('unknown'), r)).not.toMatch(/merge/i);
      expect(mergeErrorMessage({ reason: r }, t)).not.toMatch(/merge/i);
    }
  });
});

describe('effectiveBlock', () => {
  it('대기 중 초안은 서버가 막지 않아도 draft_waiting 으로 잠근다', () => {
    expect(effectiveBlock(response({ draftGate: 'waiting' }))).toBe('draft_waiting');
  });
  it('서버 판정(빌드 진행·실패)이 더 구체적이라 우선한다', () => {
    expect(effectiveBlock(response({ draftGate: 'waiting', build: build('pending') }, 'build_pending'))).toBe('build_pending');
    expect(effectiveBlock(response({ draftGate: 'failed', build: build('failure') }, 'build_failed'))).toBe('build_failed');
  });
  it('수동 초안은 잠그고, 권한 부족(awaiting_human)은 「빌드 확인 없이 반영하기」로 열어 둔다', () => {
    expect(effectiveBlock(response({ draftGate: 'waiting', draftGateBlocked: 'manual_draft' }))).toBe('manual_draft');
    expect(effectiveBlock(response({ draftGate: 'awaiting_human', draftGateBlocked: 'checks_unavailable', build: build('unknown', { unavailable: true }) }))).toBeNull();
  });
  it('잠깐 실패는 그 자체로 잠그지 않는다 — 아직 초안이면 waiting 이 잠근다', () => {
    expect(effectiveBlock(response({ draftGate: 'waiting', draftGateBlocked: 'lock_unavailable' }))).toBe('draft_waiting');
    expect(effectiveBlock(response({ draftGate: 'promoted', draftGateBlocked: 'write_failed' }))).toBeNull();
  });
  it('승격·미지원·옛 응답은 잠그지 않는다', () => {
    expect(effectiveBlock(response({ draftGate: 'promoted' }))).toBeNull();
    expect(effectiveBlock(response({ draftGate: 'unsupported' }))).toBeNull();
    expect(effectiveBlock(response({}))).toBeNull();
    expect(effectiveBlock(null)).toBeNull();
  });
});

describe('needsPolling', () => {
  it('검사가 없는 대기 초안도 다시 읽는다 — 10분 승격은 서버가 GET 을 받을 때 일어난다', () => {
    expect(needsPolling(response({ draftGate: 'waiting' }))).toBe(true);
  });
  it('잠깐 실패는 다시 읽고, 수동 초안·권한 부족은 저절로 안 바뀌어 멈춘다', () => {
    for (const r of ['lock_unavailable', 'write_failed', 'gate_failed'] as const) expect(needsPolling(response({ draftGate: 'waiting', draftGateBlocked: r }))).toBe(true);
    expect(needsPolling(response({ draftGate: 'waiting', draftGateBlocked: 'manual_draft' }))).toBe(false);
    expect(needsPolling(response({ draftGate: 'awaiting_human', draftGateBlocked: 'checks_unavailable', build: build('unknown', { unavailable: true }) }))).toBe(false);
  });
  it('빌드 진행은 그대로, 끝난 상태는 멈춘다', () => {
    expect(needsPolling(response({ build: build('pending') }))).toBe(true);
    expect(needsPolling(response({ draftGate: 'promoted', build: build('success') }))).toBe(false);
    expect(needsPolling(response({ draftGate: 'failed', build: build('failure') }))).toBe(false);
    expect(needsPolling(response({}))).toBe(false);
    expect(needsPolling(null)).toBe(false);
  });
});

describe('mergeErrorMessage', () => {
  it('409 reason 을 화면 문구로 바꾼다', () => {
    const transient = ['lock_unavailable', 'write_failed', 'gate_failed'].map((reason) => mergeErrorMessage({ error: 'server text', reason, blockedBy: 'draft_waiting' } as never, t));
    for (const m of transient) expect(m).toBe('Something went wrong, so shipping was paused. Please try again in a moment');
    expect(mergeErrorMessage({ error: 'x', reason: 'manual_draft' }, t)).toContain('The owner turned this PR back into a draft');
    expect(mergeErrorMessage({ error: 'x', reason: 'checks_unavailable' }, t)).toContain('no permission to read check results');
  });
  it('모르는 reason·reason 없음은 서버 error, 그것도 없으면 기본 문구', () => {
    expect(mergeErrorMessage({ error: 'Waiting for checks', blockedBy: 'draft_waiting' } as never, t)).toBe('Waiting for checks');
    expect(mergeErrorMessage({ error: 'server text', reason: 'toString' }, t)).toBe('server text');
    expect(mergeErrorMessage({}, t)).toBe("Couldn't ship");
    expect(mergeErrorMessage(null, t)).toBe("Couldn't ship");
  });
  it('반영을 잠그는 이유마다 사전에 문구가 있다(en·ko)', () => {
    for (const locale of ['en', 'ko'] as const) {
      const tl = translator('monitor.mergeBlock', locale);
      for (const reason of ['merged', 'closed', 'build_failed', 'build_pending', 'conflict', 'draft_waiting', 'manual_draft']) expect(tl.has(reason)).toBe(true);
    }
  });
});

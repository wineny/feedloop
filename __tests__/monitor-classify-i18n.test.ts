import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '@/components/monitor/RunDetail';
import { ClassificationTabs } from '@/components/classify/ClassificationTabs';
import type { Insight } from '@/components/classify/types';
import type { RunItem } from '@/app/api/auto-dev/runs/route';
import { getDemoData } from '@/lib/demo/mock-data';
import { renderWithIntl } from './helpers/intl';

// 영어 심사위원이 `/monitor?demo=1`·`/classify?demo=1` 에서 보는 화면에 한글이 없어야 한다.
// 두 화면은 클라이언트에서 그리므로 서버 HTML 만으로는 못 본다 — 데모 데이터로 그 화면의 컴포넌트를 직접 렌더한다.

beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());

const hangul = (s: string) => s.match(/[가-힣]/g)?.length ?? 0;
const noop = () => {};

const monitor = (locale: 'en' | 'ko') => getDemoData(locale).monitor as { runs: RunItem[]; lines: { type: string; message: string }[] };
const classify = (locale: 'en' | 'ko') => getDemoData(locale).classify as { insights: Insight[] };

describe('/monitor?demo=1 — 수정안 상세', () => {
  it.each(monitor('en').runs.map((r) => r.id))('en: 실행 %s 상세에 한글이 없다', (id) => {
    const { runs, lines } = monitor('en');
    const run = runs.find((r) => r.id === id)!;
    const html = renderWithIntl(React.createElement(RunDetail, { run, staticLines: lines, readOnly: true, onRunChange: noop, onRefresh: noop }), 'en');
    expect(hangul(html)).toBe(0);
  });

  it('en: 중단·검증불가 실행(중단 이유 코드 포함)도 한글이 없다', () => {
    const base = monitor('en').runs[2];
    for (const stopReason of ['root_cause_unknown', 'budget_exhausted', 'something_new']) {
      for (const status of ['stopped', 'unverifiable', 'failed'] as const) {
        const html = renderWithIntl(React.createElement(RunDetail, { run: { ...base, status, stopReason }, readOnly: true }), 'en');
        expect(hangul(html), `${status}/${stopReason}`).toBe(0);
      }
    }
  });

  it('en: 닫힌 PR(사유 있음·없음)도 한글이 없고, ko 는 한국어다', () => {
    const pr = monitor('en').runs[1].pr!;
    for (const closeReason of [null, 'hallucinated_path', 'other'] as const) {
      const run = { ...monitor('en').runs[1], pr: { ...pr, closedAt: '2026-10-20T00:00:00Z', closeReason, closeNote: null } };
      expect(hangul(renderWithIntl(React.createElement(RunDetail, { run, readOnly: true }), 'en'))).toBe(0);
      expect(hangul(renderWithIntl(React.createElement(RunDetail, { run }), 'en'))).toBe(0);
    }
    const ko = renderWithIntl(React.createElement(RunDetail, { run: monitor('ko').runs[0], readOnly: true }), 'ko');
    expect(ko).toContain('반영 알림');
  });
});

describe('/classify?demo=1 — 피드백 목록', () => {
  it('en: 탭·행·배지에 한글이 없다(데모 데이터의 제보 원문은 영어다)', () => {
    const html = renderWithIntl(React.createElement(ClassificationTabs, { insights: classify('en').insights, groupsById: new Map(), demo: true }), 'en');
    expect(hangul(html)).toBe(0);
    expect(html).toContain('All');
  });

  it('en: 모든 분류·감정·분류 주체 조합을 그려도 한글이 없다', () => {
    const base = classify('en').insights[0];
    const insights: Insight[] = [];
    for (const category of ['bug', 'ux', 'feature_request', 'cs', 'praise', 'other', 'unknown_new']) {
      for (const sentiment of ['positive', 'neutral', 'negative', 'odd']) {
        insights.push({ ...base, id: `${category}-${sentiment}`, category, sentiment, classified_by: sentiment === 'odd' ? 'jev' : 'llm', classify_confidence: 0.8, follow_up_needed: true, source_message_ids: ['a'] });
      }
    }
    const html = renderWithIntl(React.createElement(ClassificationTabs, { insights, groupsById: new Map(), demo: false }), 'en');
    expect(hangul(html)).toBe(0);
  });

  it('ko: 같은 화면이 한국어로 나온다', () => {
    const html = renderWithIntl(React.createElement(ClassificationTabs, { insights: classify('ko').insights, groupsById: new Map(), demo: true }), 'ko');
    expect(html).toContain('전체');
    expect(html).toContain('아직 안 묶임');
  });
});

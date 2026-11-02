import { describe, expect, it } from 'vitest';
import {
  EMPTY_REFUND_REASONS,
  REFUND_INSIGHT_WINDOW_MS,
  SPIKE_MIN_24H,
  SPIKE_RATIO,
  isGithubPrUrl,
  matchRefundInsight,
  normalizeRefundReason,
  refundBucket,
  refundReasons,
  type RefundGroupSource,
  type RefundInsightSource,
  type RefundMessageSource,
  type RefundRunSource,
  type RefundSource,
} from '@/lib/dashboard/refund-reasons';

const MIN = 60_000;
const base = Date.parse('2026-10-30T00:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * MIN).toISOString();

const refund = (o: Partial<RefundSource> & { id: string }): RefundSource => ({
  conversation_id: null,
  reason: null,
  created_at: at(0),
  ...o,
});
/** A visitor message. Default: just before the refund at `at(0)` — the refund turn. */
const message = (id: string, conversation_id: string, minutes = -0.1): RefundMessageSource => ({ id, conversation_id, created_at: at(minutes) });
const insight = (o: Partial<RefundInsightSource> & { id: string }): RefundInsightSource => ({
  message_id: null,
  source_message_ids: [],
  group_id: null,
  category: 'bug',
  summary: `summary of ${o.id}`,
  created_at: at(0),
  ...o,
});
const run = (o: Partial<RefundRunSource>): RefundRunSource => ({
  insight_id: null,
  group_id: null,
  status: 'completed',
  pr_url: null,
  closed_at: null,
  created_at: at(0),
  ...o,
});

function aggregate({
  refunds = [],
  messages = [],
  insights = [],
  runs = [],
  groups = [],
}: {
  refunds?: RefundSource[];
  messages?: RefundMessageSource[];
  insights?: RefundInsightSource[];
  runs?: RefundRunSource[];
  groups?: RefundGroupSource[];
}, now?: number) {
  return refundReasons({ refunds, messages, insights, runs, groups }, undefined, now);
}

describe('refund reasons — helpers', () => {
  it('buckets: bug/ux → fix, feature_request → feature, the rest → other, no insight → unclassified', () => {
    expect(refundBucket('bug')).toBe('fix');
    expect(refundBucket('ux')).toBe('fix');
    expect(refundBucket('feature_request')).toBe('feature');
    expect(refundBucket('praise')).toBe('other');
    expect(refundBucket('cs')).toBe('other');
    expect(refundBucket('other')).toBe('other');
    expect(refundBucket(null)).toBe('unclassified');
    expect(refundBucket(undefined)).toBe('unclassified');
  });

  it('normalizes reason text: trim, lowercase, collapse spaces', () => {
    expect(normalizeRefundReason('  I bought   the WRONG\nplan ')).toBe('i bought the wrong plan');
    expect(normalizeRefundReason(null)).toBe('');
  });

  it('only GitHub pull request URLs are linked out', () => {
    expect(isGithubPrUrl('https://github.com/example/demo/pull/128')).toBe(true);
    expect(isGithubPrUrl('https://github.com/example/demo/pull/128/files')).toBe(false);
    expect(isGithubPrUrl('https://evil.example/github.com/a/b/pull/1')).toBe(false);
    expect(isGithubPrUrl('javascript:alert(1)')).toBe(false);
    expect(isGithubPrUrl(null)).toBe(false);
  });
});

describe('matchRefundInsight — the insight the refund turn became', () => {
  const turn = message('m-turn', 'c', -0.1);
  const earlierTurn = message('m-early', 'c', -30);
  const laterTurn = message('m-later', 'c', 5);

  it('exact: message_id is the refund turn = the latest visitor message at/before the refund', () => {
    const own = insight({ id: 'own', message_id: 'm-turn', created_at: at(1) });
    const old = insight({ id: 'old', message_id: 'm-early', created_at: at(-29) });
    expect(matchRefundInsight(at(0), [laterTurn, turn, earlierTurn], [old, own])?.id).toBe('own');
  });

  it('exact via extend: the refund turn sits in an earlier insight’s source_message_ids', () => {
    const extended = insight({ id: 'A', message_id: 'm-early', source_message_ids: ['m-turn'], created_at: at(-29) });
    const unrelatedLater = insight({ id: 'B', message_id: 'm-later', created_at: at(6) });
    expect(matchRefundInsight(at(0), [earlierTurn, turn, laterTurn], [unrelatedLater, extended])?.id).toBe('A');
  });

  it('fallback: no exact link → earliest insight within the window after the refund, never an older one', () => {
    const older = insight({ id: 'older', message_id: 'm-early', created_at: at(-29) });
    const soon = insight({ id: 'soon', created_at: at(2) });
    const sooner = insight({ id: 'sooner', created_at: at(1) });
    expect(matchRefundInsight(at(0), [], [older, soon, sooner])?.id).toBe('sooner');
    expect(matchRefundInsight(at(0), [], [older])).toBeNull();
  });

  it('fallback is capped: an insight past the window is not this refund’s', () => {
    const tooLate = insight({ id: 'late', created_at: new Date(base + REFUND_INSIGHT_WINDOW_MS + 1).toISOString() });
    const justIn = insight({ id: 'in', created_at: new Date(base + REFUND_INSIGHT_WINDOW_MS).toISOString() });
    expect(matchRefundInsight(at(0), [], [tooLate])).toBeNull();
    expect(matchRefundInsight(at(0), [], [tooLate, justIn])?.id).toBe('in');
  });
});

describe('refundReasons', () => {
  it('empty input → zero everywhere, no top items', () => {
    expect(aggregate({})).toEqual(EMPTY_REFUND_REASONS);
  });

  it('real demo DB today: two unclassified refunds with the same reason → one top item, count 2', () => {
    const result = aggregate({
      refunds: [
        refund({ id: 'r1', conversation_id: 'conv-a', reason: 'I bought the wrong plan by mistake.', created_at: at(0) }),
        refund({ id: 'r2', conversation_id: 'conv-b', reason: 'I bought the wrong plan by mistake.', created_at: at(10) }),
      ],
      messages: [message('m-a', 'conv-a', -0.1), message('m-b', 'conv-b', 9.9)],
    });
    expect(result.total).toBe(2);
    expect(result.buckets).toEqual({ fix: 0, feature: 0, other: 0, unclassified: 2 });
    expect(result.top).toEqual([
      {
        key: 'reason:i bought the wrong plan by mistake.',
        label: 'I bought the wrong plan by mistake.',
        count: 2,
        bucket: 'unclassified',
        // the newest refund's conversation
        href: '/inbox?c=conv-b',
        external: false,
        recent24h: 0,
        spike: false,
      },
    ]);
  });

  it('bug reason in a grouped insight with an open PR → fix, group title, PR link', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: 'Receipt shows the wrong currency', created_at: at(0) })],
      messages: [message('m-1', 'conv-1')],
      insights: [insight({ id: 'ins-1', message_id: 'm-1', group_id: 'g-1', category: 'bug', summary: 'Receipt currency wrong', created_at: at(1) })],
      groups: [{ id: 'g-1', title: 'Receipt shows the wrong currency' }],
      runs: [
        run({ group_id: 'g-1', pr_url: 'https://github.com/example/demo/pull/7', closed_at: at(5), created_at: at(3) }),
        run({ group_id: 'g-1', pr_url: 'https://github.com/example/demo/pull/128', created_at: at(2) }),
        run({ group_id: 'g-1', status: 'failed', created_at: at(4) }),
      ],
    });
    expect(result.buckets).toEqual({ fix: 1, feature: 0, other: 0, unclassified: 0 });
    expect(result.top).toEqual([
      {
        key: 'group:g-1',
        label: 'Receipt shows the wrong currency',
        count: 1,
        bucket: 'fix',
        href: 'https://github.com/example/demo/pull/128',
        external: true,
        recent24h: 0,
        spike: false,
      },
    ]);
  });

  it('PR linked to the insight directly (no group) also counts', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: 'Checkout froze' })],
      messages: [message('m-1', 'conv-1')],
      insights: [insight({ id: 'ins-1', message_id: 'm-1', category: 'ux', summary: 'Checkout freezes on Safari' })],
      runs: [run({ insight_id: 'ins-1', pr_url: 'https://github.com/example/demo/pull/9' })],
    });
    expect(result.top[0]).toMatchObject({ key: 'insight:ins-1', label: 'Checkout freezes on Safari', bucket: 'fix', href: 'https://github.com/example/demo/pull/9', external: true });
  });

  it('a PR URL that is not a GitHub pull request is not linked out — the conversation is', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: 'Checkout froze' })],
      messages: [message('m-1', 'conv-1')],
      insights: [insight({ id: 'ins-1', message_id: 'm-1', category: 'bug' })],
      runs: [run({ insight_id: 'ins-1', pr_url: 'https://example.com/not-a-pr' })],
    });
    expect(result.top[0]).toMatchObject({ bucket: 'fix', href: '/inbox?c=conv-1', external: false });
  });

  it('feature_request → feature bucket, insight summary as the label, conversation link', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: "It doesn't export to CSV" })],
      messages: [message('m-1', 'conv-1')],
      insights: [insight({ id: 'ins-1', message_id: 'm-1', category: 'feature_request', summary: 'Request: CSV export' })],
    });
    expect(result.buckets.feature).toBe(1);
    expect(result.top[0]).toEqual({
      key: 'insight:ins-1',
      label: 'Request: CSV export',
      count: 1,
      bucket: 'feature',
      href: '/inbox?c=conv-1',
      external: false,
      recent24h: 0,
      spike: false,
    });
  });

  it('extend + a later unrelated insight in the same conversation → the refund goes to the extended insight', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: 'Still broken, refund please', created_at: at(10) })],
      messages: [message('m-report', 'conv-1', -60), message('m-refund', 'conv-1', 9.9), message('m-praise', 'conv-1', 12)],
      insights: [
        // A: the earlier bug report; the refund reason extended it (old created_at, refund turn in source_message_ids)
        insight({ id: 'A', message_id: 'm-report', source_message_ids: ['m-refund'], category: 'bug', created_at: at(-59) }),
        // B: an unrelated later insight, created right after the refund — the time rule alone would pick it
        insight({ id: 'B', message_id: 'm-praise', category: 'praise', created_at: at(12) }),
      ],
    });
    expect(result.buckets).toEqual({ fix: 1, feature: 0, other: 0, unclassified: 0 });
    expect(result.top[0].key).toBe('insight:A');
  });

  it('a conversation with several insights → the refund turn’s own insight decides the bucket', () => {
    const result = aggregate({
      refunds: [refund({ id: 'r1', conversation_id: 'conv-1', reason: 'Too expensive for us', created_at: at(10) })],
      messages: [message('m-1', 'conv-1', 0), message('m-2', 'conv-1', 9.9), message('m-3', 'conv-1', 80)],
      insights: [
        insight({ id: 'earlier-bug', message_id: 'm-1', category: 'bug', created_at: at(0) }),
        insight({ id: 'the-reason', message_id: 'm-2', category: 'cs', summary: 'Price too high for a small team', created_at: at(11) }),
        insight({ id: 'later-praise', message_id: 'm-3', category: 'praise', created_at: at(90) }),
      ],
    });
    expect(result.buckets).toEqual({ fix: 0, feature: 0, other: 1, unclassified: 0 });
    expect(result.top[0]).toMatchObject({ key: 'insight:the-reason', label: 'Price too high for a small team', bucket: 'other' });
  });

  it('top 3: most frequent first, ties → newer first; a row with no conversation and no reason still counts', () => {
    const result = aggregate({
      refunds: [
        refund({ id: 'a1', reason: 'Wrong plan', created_at: at(0) }),
        refund({ id: 'a2', reason: ' wrong  PLAN', created_at: at(1) }),
        refund({ id: 'b1', reason: 'Too pricey', created_at: at(5) }),
        refund({ id: 'c1', reason: 'Changed my mind', created_at: at(9) }),
        refund({ id: 'd1', reason: 'Not needed', created_at: at(2) }),
        refund({ id: 'blank', reason: null, conversation_id: null, created_at: at(-20) }),
      ],
    });
    expect(result.total).toBe(6);
    expect(result.buckets.unclassified).toBe(6);
    expect(result.top.map((i) => [i.label, i.count])).toEqual([
      // newest wording of the merged reason is the label
      ['wrong  PLAN', 2],
      ['Changed my mind', 1],
      ['Too pricey', 1],
    ]);
    expect(result.top[0].href).toBeNull();
  });

  it('no reason and no insight → label null (the screen says «No reason given»)', () => {
    const result = aggregate({ refunds: [refund({ id: 'blank' })] });
    expect(result.top).toEqual([{ key: 'reason:', label: null, count: 1, bucket: 'unclassified', href: null, external: false, recent24h: 0, spike: false }]);
  });
});

describe('spike badge', () => {
  const DAY = 24 * 60 * MIN;
  const now = base;
  /** n refunds with the same reason, `ageMs` before now. */
  const same = (prefix: string, n: number, ageMs: number) =>
    Array.from({ length: n }, (_, i) => refund({ id: `${prefix}${i}`, reason: 'too expensive', created_at: new Date(now - ageMs).toISOString() }));
  const top = (refunds: RefundSource[]) => aggregate({ refunds }, now).top[0];

  it('constants', () => {
    expect([SPIKE_MIN_24H, SPIKE_RATIO]).toEqual([3, 2]);
  });
  it('2 in 24 h → no', () => {
    expect(top(same('a', 2, MIN))).toMatchObject({ recent24h: 2, spike: false });
  });
  it('3 in 24 h with an empty baseline → yes', () => {
    expect(top(same('a', 3, MIN))).toMatchObject({ recent24h: 3, spike: true });
  });
  it('3 vs a baseline of 14 in 7 days → no (needs 4)', () => {
    expect(top([...same('a', 3, MIN), ...same('b', 14, 3 * DAY)]).spike).toBe(false);
  });
  it('exactly 2x the daily average → yes', () => {
    // baseline 7 → avg 1/day → 3 >= 2 · 1
    expect(top([...same('a', 3, MIN), ...same('b', 7, 3 * DAY)]).spike).toBe(true);
    // baseline 10 → avg 1.43 → 3 >= 2.86
    expect(top([...same('a', 3, MIN), ...same('b', 10, 3 * DAY)]).spike).toBe(true);
    // baseline 11 → avg 1.57 → 3 < 3.14
    expect(top([...same('a', 3, MIN), ...same('b', 11, 3 * DAY)]).spike).toBe(false);
  });
  it('24 h boundary: exactly 24 h old is baseline, not recent', () => {
    expect(top(same('a', 3, DAY)).recent24h).toBe(0);
  });
  it('8 d boundary: exactly 8 d old is outside the baseline', () => {
    // 3 recent + 14 at exactly 8 d → baseline 0 → spike
    expect(top([...same('a', 3, MIN), ...same('b', 14, 8 * DAY)]).spike).toBe(true);
    // 1 ms inside the window counts
    expect(top([...same('a', 3, MIN), ...same('b', 14, 8 * DAY - 1)]).spike).toBe(false);
  });
  /** n refunds with reason `r`, `ageMs` before now. */
  const many = (r: string, n: number, ageMs: number) =>
    Array.from({ length: n }, (_, j) => refund({ id: `${r}-${ageMs}-${j}`, reason: `reason ${r}`, created_at: new Date(now - ageMs).toISOString() }));

  it('a spiking reason outside the top 3 is appended after them', () => {
    // a/b/c: many old refunds, none recent. d: only 3, all in the last hour → spike, but 4th by count.
    const refunds = [...many('a', 10, 30 * DAY), ...many('b', 9, 30 * DAY), ...many('c', 8, 30 * DAY), ...many('d', 3, MIN)];
    const result = aggregate({ refunds }, now);
    expect(result.top.map((i) => [i.label, i.count, i.spike])).toEqual([
      ['reason a', 10, false],
      ['reason b', 9, false],
      ['reason c', 8, false],
      ['reason d', 3, true],
    ]);
  });
  it('a non-spiking reason outside the top 3 stays out', () => {
    const refunds = [...many('a', 10, 30 * DAY), ...many('b', 9, 30 * DAY), ...many('c', 8, 30 * DAY), ...many('d', 2, MIN)];
    const result = aggregate({ refunds }, now);
    expect(result.top.map((i) => i.label)).toEqual(['reason a', 'reason b', 'reason c']);
  });
  it('spiking reasons inside the top 3 are not duplicated; the top may exceed 3 only by spiking reasons', () => {
    const refunds = ['a', 'b', 'c', 'd', 'e'].flatMap((r, i) => many(r, 10 - i, MIN));
    const result = aggregate({ refunds }, now);
    expect(result.top.map((i) => i.label)).toEqual(['reason a', 'reason b', 'reason c', 'reason d', 'reason e']);
    expect(result.top.every((i) => i.spike)).toBe(true);
  });
});

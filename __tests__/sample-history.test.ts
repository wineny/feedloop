// F4: the seeded sample refund history (src/lib/demo/sample-history.ts) — the safety rules every row follows,
// and that the dashboard's own pure functions see the intended story (top reasons, coupon spike).
import { describe, expect, it } from 'vitest';
import { assertSampleHistory, buildSampleHistory, SAMPLE_HISTORY_DAYS, type SampleHistory } from '@/lib/demo/sample-history';
import { isSampleRef, isSampleVisitor } from '@/lib/demo/sample-marker';
import { refundReasons } from '@/lib/dashboard/refund-reasons';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const BOT = '11111111-1111-4111-8111-111111111111';

function build(): SampleHistory {
  let n = 0;
  return buildSampleHistory({ botId: BOT, now: NOW, idGen: () => `id-${String(++n).padStart(4, '0')}` });
}

describe('buildSampleHistory', () => {
  const h = build();

  it('~30 decided refunds within the last 60 days, one demo bot', () => {
    expect(h.actions.length).toBeGreaterThanOrEqual(25);
    expect(h.actions.length).toBeLessThanOrEqual(35);
    for (const a of h.actions) {
      const t = Date.parse(a.created_at);
      expect(t).toBeLessThan(NOW);
      expect(t).toBeGreaterThanOrEqual(NOW - SAMPLE_HISTORY_DAYS * DAY);
    }
    const all = [...h.conversations, ...h.messages, ...h.groups, ...h.insights, ...h.actions];
    expect(new Set(all.map((r) => r.bot_id))).toEqual(new Set([BOT]));
  });

  it('every capture / refund id carries the SAMPLE- marker; every visitor the sample- marker', () => {
    for (const a of h.actions) {
      expect(isSampleRef(a.target_id)).toBe(true);
      if (a.paypal_ref !== null) expect(isSampleRef(a.paypal_ref)).toBe(true);
    }
    expect(new Set(h.actions.map((a) => a.target_id)).size).toBe(h.actions.length);
    for (const c of h.conversations) expect(isSampleVisitor(c.external_user_id)).toBe(true);
    for (const m of h.messages) expect(isSampleVisitor(m.external_user_id)).toBe(true);
  });

  it('final states only: no pending / executing / unknown / failed / expired', () => {
    expect(new Set(h.actions.map((a) => a.status))).toEqual(new Set(['executed', 'rejected']));
    expect(h.actions.every((a) => a.kind === 'refund')).toBe(true);
    const executed = h.actions.filter((a) => a.status === 'executed');
    expect(executed.some((a) => a.origin === 'auto')).toBe(true);
    expect(executed.some((a) => a.origin === 'approval')).toBe(true);
    for (const a of executed) expect(a).toMatchObject({ executed_at: expect.any(String), sent_at: expect.any(String), send_attempts: 1 });
    for (const a of h.actions.filter((x) => x.status === 'rejected')) expect(a).toMatchObject({ paypal_ref: null, sent_at: null, executed_at: null, payload: null });
  });

  it('no row created in the last 24 h is executed (daily cap); customer_key is always null (per-customer cap)', () => {
    const recent = h.actions.filter((a) => Date.parse(a.created_at) > NOW - DAY);
    expect(recent.length).toBeGreaterThanOrEqual(3);
    expect(recent.every((a) => a.status === 'rejected')).toBe(true);
    expect(h.actions.every((a) => a.customer_key === null)).toBe(true);
  });

  it('guardrail: auto = every check passed, no decision; approval = a failed check and a decision time, nobody named', () => {
    for (const a of h.actions) {
      const failed = Object.values(a.guardrail).filter((v) => !v).length;
      expect(Object.keys(a.guardrail)).toHaveLength(10);
      expect(a.decided_by).toBeNull();
      if (a.origin === 'auto') expect([failed, a.decided_at]).toEqual([0, null]);
      else {
        expect(failed).toBeGreaterThan(0);
        expect(a.decided_at).not.toBeNull();
      }
    }
  });

  it('every action has an announcement for its status (the reaper writes nothing into sample chats)', () => {
    const announced = new Set(h.announcements.map((x) => `${x.action_id}:${x.status}`));
    for (const a of h.actions) expect(announced.has(`${a.id}:${a.status}`)).toBe(true);
    expect(h.announcements.every((x) => x.response_id === null)).toBe(true);
  });

  it('nothing left for the LLM: messages done, groupable insights grouped, groups already scored', () => {
    expect(h.messages.every((m) => m.classification_state === 'done')).toBe(true);
    for (const i of h.insights) if (['bug', 'ux', 'feature_request'].includes(i.category)) expect(i.group_id).not.toBeNull();
    expect(h.insights.some((i) => i.group_id === null)).toBe(true); // one-off cs / other reasons stay ungrouped
    for (const g of h.groups) expect(typeof g.impact_core).toBe('boolean');
  });

  it('three groups, one per triage verdict', () => {
    expect(h.groups.map((g) => g.triage).sort()).toEqual(['fix', 'needs_decision', 'wont_fix']);
    for (const g of h.groups) expect(g.triage_reason.length).toBeLessThanOrEqual(160);
  });

  it('the dashboard sees coupon / export / price as top reasons and a coupon spike', () => {
    const r = refundReasons(
      {
        refunds: h.actions,
        messages: h.messages,
        insights: h.insights,
        runs: [],
        groups: h.groups,
      },
      3,
      NOW,
    );
    expect(r.total).toBe(h.actions.length);
    expect(r.buckets.unclassified).toBe(0);
    expect(r.top.map((t) => t.label)).toEqual([
      'Coupon code not applied at checkout',
      'No CSV export for conversations and insights',
      'Price feels too high for small sites',
    ]);
    expect(r.top.map((t) => t.bucket)).toEqual(['fix', 'feature', 'other']);
    expect(r.top.map((t) => t.spike)).toEqual([true, false, false]);
  });

  it('assertSampleHistory rejects a row that could reach PayPal or the live caps', () => {
    const broken = (mutate: (x: SampleHistory) => void) => {
      const x = structuredClone(build());
      mutate(x);
      return () => assertSampleHistory(x, NOW);
    };
    expect(broken(() => {})).not.toThrow();
    expect(broken((x) => { x.actions[0].target_id = '5O190127TN364715T'; })).toThrow(/SAMPLE-/);
    expect(broken((x) => { (x.actions[0] as { status: string }).status = 'pending'; })).toThrow(/not final/);
    expect(broken((x) => { x.announcements.pop(); })).toThrow(/announcement/);
    expect(broken((x) => { (x.actions[0] as { customer_key: string | null }).customer_key = 'a@b.c'; })).toThrow(/customer_key/);
    expect(broken((x) => { (x.messages[0] as { classification_state: string }).classification_state = 'pending'; })).toThrow(/classified/);
    expect(broken((x) => { x.insights.find((i) => i.group_id)!.group_id = null; })).toThrow(/auto-grouping/);
    expect(broken((x) => { x.conversations[0].external_user_id = 'visitor-1'; })).toThrow(/sample- prefix/);
    expect(
      broken((x) => {
        const a = x.actions.find((y) => y.status === 'executed' && y.origin === 'auto')!;
        a.created_at = new Date(NOW - 60 * 60_000).toISOString();
      }),
    ).toThrow(/last 24 h/);
  });
});

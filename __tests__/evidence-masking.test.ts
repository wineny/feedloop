// PR and spec evidence never quote an email or a PayPal order id (design §7 review): the payment
// turn's insight sits on a "<order id> <email>" message, and that body is cited in the PR body, the
// auto-dev prompt and the spec draft. When nothing real is left after masking, the insight summary
// (the symptom) is used. Both readers share lib/insights/evidence.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  supplements: [] as string[],
  callClaude: vi.fn<(prompt: string) => Promise<string>>(async () => '# Spec'),
}));

vi.mock('@/lib/auto-dev/ai-engine', () => ({ callAutoDev: vi.fn(), callClaude: state.callClaude }));
vi.mock('@/lib/insights/supplements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/insights/supplements')>();
  return { ...actual, loadSupplementBodies: async () => state.supplements };
});
vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    rpc: async () => ({ data: true, error: null }),
    from: () => {
      const q = {
        select: () => q, eq: () => q, order: () => q, update: () => q,
        limit: async () => ({ data: state.rows, error: null }),
        maybeSingle: async () => ({ data: { id: 'g1', bot_id: 'bot', title: 'Receipt currency', summary: 'Wrong currency' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return q;
    },
  }),
}));

import { resolveRunValidationInput, type LoadedRun } from '@/lib/auto-dev/execute-run';
import { evidenceText, maskEvidence } from '@/lib/insights/evidence';
import { generateGroupSpec } from '@/lib/groups/spec';

const ORDER = '5O190127TN364715T';
const EMAIL = 'buyer@example.com';
const SUMMARY = 'Receipt shows the wrong currency';

const baseRun: LoadedRun = {
  id: 'run', bot_id: 'bot', insight_id: null, group_id: null, status: 'in_progress', pr_url: null, pr_number: null,
  files_changed: null, error_message: null, insights: null, insight_groups: null,
  bots: { github_repo_url: 'https://github.com/qa/repo', user_id: 'owner' },
};

beforeEach(() => {
  state.rows = [];
  state.supplements = [];
  state.callClaude.mockClear();
});

describe('maskEvidence / evidenceText', () => {
  it('masks emails and PayPal order ids, keeps plain upper-case words and numbers', () => {
    expect(maskEvidence(`order ${ORDER}, paid with ${EMAIL} at CHECKOUT on 20261022`)).toBe(
      'order ***, paid with *** at CHECKOUT on 20261022',
    );
  });

  it('masks a 17-character order id in any case; error codes, SKUs and versions stay', () => {
    expect(maskEvidence(`refund ${ORDER.toLowerCase()} please`)).toBe('refund *** please');
    expect(maskEvidence('5o190127TN364715t')).toBe('***');
    for (const kept of ['ERR500XYZ', 'AB12CD34EF', '2026R10A', 'V2X8Y9Z1', '3F2A9B1C', 'SKU-PRO-2026', 'ABCDEFGH12345678']) {
      expect(maskEvidence(`Checkout fails with ${kept}`)).toBe(`Checkout fails with ${kept}`);
    }
    // 18 characters is not a PayPal order id either
    expect(maskEvidence('id 5O190127TN364715TX')).toBe('id 5O190127TN364715TX');
  });

  it('leaves a body with nothing to mask untouched (existing feedback evidence does not change)', () => {
    expect(evidenceText('앱이 멈춰요', 'App freezes')).toBe('앱이 멈춰요');
    expect(evidenceText('The coupon tab shows a white screen', 'x')).toBe('The coupon tab shows a white screen');
  });

  it('falls back to the summary when masking leaves no real content', () => {
    expect(evidenceText(`${ORDER} ${EMAIL}`, SUMMARY)).toBe(SUMMARY);
    expect(evidenceText(`order ${ORDER}, email ${EMAIL}`, SUMMARY)).toBe(SUMMARY);
  });

  it('keeps the masked body when real content remains', () => {
    expect(evidenceText(`The receipt for ${ORDER} showed EUR instead of USD`, SUMMARY)).toBe(
      'The receipt for *** showed EUR instead of USD',
    );
  });
});

describe('resolveRunValidationInput', () => {
  it('single insight on a payment turn: the evidence is the symptom, no email or order id, supplements masked', async () => {
    state.supplements = [`my email is ${EMAIL}, it happened twice`];
    const run: LoadedRun = {
      ...baseRun,
      insight_id: 'ins-1',
      insights: { category: 'bug', summary: SUMMARY, source_message_ids: ['m2'], messages: { body: `${ORDER} ${EMAIL}`, context: null } },
    };
    const { insight } = await resolveRunValidationInput(run);
    expect(insight.message_body).toContain(SUMMARY);
    expect(insight.message_body).toContain('(follow-up) my email is ***, it happened twice');
    expect(insight.message_body).not.toContain(EMAIL);
    expect(insight.message_body).not.toContain(ORDER);
  });

  it('group: each report is masked, and the payment one shows its summary', async () => {
    state.rows = [
      { summary: 'Wrong currency on the receipt', source_message_ids: [], messages: { body: 'The receipt said € but I paid in $', context: null } },
      { summary: SUMMARY, source_message_ids: [], messages: { body: `${ORDER} ${EMAIL}`, context: null } },
    ];
    const run: LoadedRun = {
      ...baseRun,
      group_id: '11111111-1111-4111-8111-111111111111',
      insight_groups: { title: 'Receipt currency', summary: 'Receipt shows the wrong currency', category: 'bug', status: 'open' },
    };
    const { insight } = await resolveRunValidationInput(run);
    expect(insight.message_body).toContain('2 actual reports:');
    expect(insight.message_body).toContain('- The receipt said € but I paid in $');
    expect(insight.message_body).toContain(`- ${SUMMARY}`);
    expect(insight.message_body).not.toContain(EMAIL);
    expect(insight.message_body).not.toContain(ORDER);
  });
});

describe('generateGroupSpec reads the group the same way', () => {
  it('spec voices are masked, the payment report shows its summary, supplements are masked', async () => {
    state.supplements = [`reach me at ${EMAIL}`];
    state.rows = [
      { summary: 'Wrong currency on the receipt', source_message_ids: [], messages: { body: 'The receipt said € but I paid in $' } },
      { summary: SUMMARY, source_message_ids: ['m2'], messages: { body: `${ORDER} ${EMAIL}` } },
    ];
    const result = await generateGroupSpec('g1');
    expect(result.evidenceCount).toBe(2);
    const prompt = state.callClaude.mock.calls[0][0];
    expect(prompt).toContain('The receipt said € but I paid in $');
    expect(prompt).toContain(SUMMARY);
    expect(prompt).toContain('(follow-up) reach me at ***');
    expect(prompt).not.toContain(EMAIL);
    expect(prompt).not.toContain(ORDER);
  });
});

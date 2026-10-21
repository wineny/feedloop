// Stage 3 task 4: one English mail to the owner when a refund waits for approval.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRefundApprovalEmail } from '@/lib/email/templates';
import type { PaymentActionRow } from '@/lib/paypal/store';

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  sendEmail: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({ ok: true, id: 'pm-1' })),
  configured: true,
}));

vi.mock('@/lib/supabase', () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: h.rows[table] ?? null, error: null });
      return chain;
    },
    rpc: vi.fn(),
  }),
}));
vi.mock('@/lib/email/postmark', () => ({
  isEmailConfigured: () => h.configured,
  sendEmail: h.sendEmail,
}));

import { emailOwnerRefundApproval } from '@/lib/email/notify';

const action: PaymentActionRow = {
  id: 'act-1',
  bot_id: 'bot-1',
  conversation_id: 'conv-1',
  kind: 'refund',
  target_id: 'CAP123',
  amount_cents: 2950,
  currency: 'USD',
  customer_key: 'buyer@example.com',
  origin: 'approval',
  status: 'pending',
  reason: 'It did not work <b>at all</b>',
  guardrail: { amount_within_max: false, within_days: true, customer_cap_ok: false },
  paypal_ref: null,
  error: null,
  decided_by: null,
  decided_at: null,
  created_at: '2026-10-21T01:00:00.000Z',
  updated_at: '2026-10-21T01:00:00.000Z',
  reconcile_attempts: 0,
  reconcile_attempted_at: null,
  sent_at: null,
  send_attempts: 0,
};

describe('renderRefundApprovalEmail', () => {
  it('is English, names the amount and the failed checks, escapes the reason, links the inbox', () => {
    const r = renderRefundApprovalEmail({
      serviceName: 'Feedloop',
      visitorLabel: 'Visitor #ab12',
      visitorEmail: 'buyer@example.com',
      amount: '$29.50',
      reason: 'It did not work <b>at all</b>',
      failedChecks: ['Amount within auto limit', 'Customer refund cap not exceeded'],
      captureId: 'CAP123',
      inboxUrl: 'https://feedloop-demo.vercel.app/inbox?c=conv-1',
      requestedAt: new Date('2026-10-21T01:00:00Z'),
    });
    expect(r.subject).toBe('[Feedloop] Refund approval needed · $29.50 · Visitor #ab12');
    expect(r.html).toContain('&lt;b&gt;at all&lt;/b&gt;');
    expect(r.html).not.toContain('<b>at all</b>');
    expect(r.html).toContain('Amount within auto limit');
    expect(r.html).toContain('https://feedloop-demo.vercel.app/inbox?c=conv-1');
    expect(r.text).toContain('- Customer refund cap not exceeded');
    expect(r.text).toContain('Nothing has been sent to PayPal');
    expect(r.subject + r.text).not.toMatch(/[가-힣]/);
  });

  it('drops a non-https inbox link and explains an empty check list', () => {
    const r = renderRefundApprovalEmail({
      serviceName: 'S', visitorLabel: 'V', visitorEmail: null, amount: '$1', reason: null, failedChecks: [], captureId: 'C', inboxUrl: 'http://evil',
    });
    expect(r.html).not.toContain('http://evil');
    expect(r.text).toContain('Automatic refunds are switched off');
    expect(r.text).toContain('(none given)');
  });
});

describe('emailOwnerRefundApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.configured = true;
    h.rows = {
      bots: { service_name: 'Feedloop', user_id: 'user-1' },
      users: { email: 'owner@example.com' },
      conversations: { contact_name: null, contact_email: null, external_user_id: 'ab12cdef' },
    };
    process.env.WEBHOOK_BASE_URL = 'https://feedloop-demo.vercel.app';
  });

  it('sends one mail to the bot owner with the facts and the deep link', async () => {
    const r = await emailOwnerRefundApproval({ botId: 'bot-1', conversationId: 'conv-1', action });
    expect(r).toEqual({ sent: true, to: 'owner@example.com' });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const sent = h.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe('owner@example.com');
    expect(sent.tag).toBe('refund-approval');
    expect(sent.subject).toBe('[Feedloop] Refund approval needed · $29.50 · Visitor #ab12');
    expect(String(sent.text)).toContain('buyer@example.com');
    expect(String(sent.text)).toContain('https://feedloop-demo.vercel.app/inbox?c=conv-1');
    expect(sent.metadata).toMatchObject({ actionId: 'act-1', conversationId: 'conv-1', botId: 'bot-1' });
  });

  it('does not send for a row that is not pending, without mail config, or without an owner email', async () => {
    expect(await emailOwnerRefundApproval({ botId: 'bot-1', conversationId: 'conv-1', action: { ...action, status: 'executing' } })).toEqual({ sent: false, reason: 'not_pending' });
    h.configured = false;
    expect(await emailOwnerRefundApproval({ botId: 'bot-1', conversationId: 'conv-1', action })).toEqual({ sent: false, reason: 'not_configured' });
    h.configured = true;
    h.rows.users = { email: '' };
    expect(await emailOwnerRefundApproval({ botId: 'bot-1', conversationId: 'conv-1', action })).toEqual({ sent: false, reason: 'no_owner_email' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('reports a provider failure without throwing', async () => {
    h.sendEmail.mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect(await emailOwnerRefundApproval({ botId: 'bot-1', conversationId: 'conv-1', action })).toEqual({ sent: false, reason: 'send_failed' });
  });
});

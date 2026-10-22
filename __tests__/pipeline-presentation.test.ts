import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { runState } from '@/components/monitor/RunBadge';
import { translator } from './helpers/intl';
import type { RunItem } from '@/app/api/auto-dev/runs/route';
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: vi.fn() }));
vi.mock('@/lib/classify/recovery', () => ({ runClassificationRecovery: vi.fn() }));
import { resolveOwnedBots } from '@/lib/auth/ownership';
import { getServiceRoleClient } from '@/lib/supabase';
import { PATCH } from '@/app/api/classify/route';

describe('pipeline presentation states', () => {
  it('normalizes active work and distinguishes stops from failures', () => {
    expect(runState({ status: 'in_progress', pr: null })).toBe('running');
    expect(runState({ status: 'stopped', pr: null })).toBe('stopped');
    expect(runState({ status: 'unverifiable', pr: null })).toBe('unverifiable');
    const label = translator('monitor.state');
    expect(label('failed')).not.toBe(label('stopped'));
  });
  it('retains a published PR after a later persistence failure', () => {
    const pr: NonNullable<RunItem['pr']> = { url: 'https://github.com/test/test/pull/1', number: 1, mergedAt: null, closedAt: null, closeReason: null, closeNote: null };
    expect(runState({ status: 'failed', pr })).toBe('open');
    expect(runState({ status: 'failed', pr: { ...pr, mergedAt: '2026-09-13' } })).toBe('merged');
  });
});

describe('explicit exhausted classification retry', () => {
  const rpc = vi.fn();
  const messageId = '11111111-1111-4111-8111-111111111111';
  const request = (body: unknown) => new NextRequest('http://localhost/api/classify', { method: 'PATCH', body: JSON.stringify(body) });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveOwnedBots).mockResolvedValue({ ok: true, userId: 'operator', botIds: ['owned'] });
    vi.mocked(getServiceRoleClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof getServiceRoleClient>);
  });
  it('takes operator identity from authenticated ownership, never request fields', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect((await PATCH(request({ messageId, operatorId: 'attacker' }))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('retry_exhausted_classification', { p_message_id: messageId, p_operator_id: 'operator' });
  });
  it('rejects repeat/nonexhausted/nonowned requests without reporting queued', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await PATCH(request({ messageId }))).status).toBe(409);
  });
  it('requires authentication and validates the message id before mutation', async () => {
    expect((await PATCH(request({ messageId: 'bad' }))).status).toBe(400);
    vi.mocked(resolveOwnedBots).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await PATCH(request({ messageId }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('surfaces database failures', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    expect((await PATCH(request({ messageId }))).status).toBe(500);
  });
});

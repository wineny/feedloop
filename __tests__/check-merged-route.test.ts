import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { select, check } = vi.hoisted(() => ({ select: vi.fn(), check: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: () => ({ select }) }) }));
vi.mock('@/lib/auto-dev/loop-closed', () => ({ checkMergedRuns: check }));
vi.mock('@/lib/widget/shots', () => ({ cleanupShots: async () => ({ orphans: 0, expired: 0, failed: false }) }));
import { GET } from '@/app/api/cron/check-merged/route';
beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = 'local-test'; });
it('bot lookup failure returns an error instead of a successful empty cron scan', async () => {
  select.mockResolvedValue({ data: null, error: { message: 'offline' } });
  const response = await GET(new NextRequest('http://localhost/api/cron/check-merged', { headers: { authorization: 'Bearer local-test' } }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'follow_up_bots_lookup_failed: offline' });
  expect(check).not.toHaveBeenCalled();
});

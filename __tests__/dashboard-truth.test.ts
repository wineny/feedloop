import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from, resolveOwnedBots, results, calls } = vi.hoisted(() => ({ from: vi.fn(), resolveOwnedBots: vi.fn(), results: [] as unknown[], calls: [] as { table: string; methods: [string, ...unknown[]][] }[] }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from }) }));
vi.mock('@/lib/auth/ownership', () => ({ resolveOwnedBots, resolveAccessibleBots: resolveOwnedBots }));
import { GET } from '@/app/api/dashboard/route';
beforeEach(() => {
 vi.clearAllMocks(); results.length = 0; calls.length = 0;
 resolveOwnedBots.mockResolvedValue({ ok: true, botIds: ['owned-bot'] });
 from.mockImplementation((table: string) => {
  const result = results.shift() ?? { data: [], count: 0, error: null };
  const call = { table, methods: [] as [string, ...unknown[]][] }; calls.push(call);
  const query = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) } as Record<string, unknown>;
  for (const method of ['select', 'in', 'eq', 'not', 'is', 'lte', 'lt', 'order', 'limit']) query[method] = (...args: unknown[]) => { call.methods.push([method, ...args]); return query; };
  return query;
 });
});
describe('dashboard message processing counts', () => {
 it('seven done messages are seven processed even when only five insights exist', async () => {
  for (const count of [7, 7, 0, 0, 0, 0, 0, 0, 0, 0]) results.push({ count, error: null });
  results.push({ data: [], error: null }, { data: Array.from({ length: 5 }, (_, index) => ({ id: `insight-${index}`, message_id: `message-${index}`, group_id: null, source_message_ids: [], category: 'other', summary: 'fixture', created_at: '2026-09-13T00:00:00Z' })), error: null });
  const data = await (await GET()).json();
  expect(data.stats.classified).toBe(7);
  expect(data.stats.classification).toEqual({ done: 7, pending: 0, processing: 0, failed: 0, exhausted: 0, eligible: 0 });
  expect(calls[1].table).toBe('messages'); expect(calls[1].methods).toContainEqual(['eq', 'classification_state', 'done']);
  expect(calls[3].methods).toContainEqual(['not', 'delivered_at', 'is', null]);
 });
 it('exposes all recovery states and selects only eligible due work', async () => {
  for (const count of [12, 5, 1, 1, 2, 2, 2, 1, 3, 1]) results.push({ count, error: null });
  const data = await (await GET()).json();
  expect(data.stats.classification).toEqual({ done: 5, pending: 2, processing: 2, failed: 2, exhausted: 1, eligible: 3 });
  expect(data.stats.returnQueued).toBe(1);
  expect(calls[8].methods).toContainEqual(['in', 'classification_state', ['pending', 'failed', 'processing']]);
  expect(calls[8].methods).toContainEqual(['lt', 'classification_attempts', 3]);
  expect(calls[8].methods.some(call => call[0] === 'lte' && call[1] === 'classification_next_at')).toBe(true);
 });
 it('does not silently convert a failed count query to zero', async () => { results.push({ error: { message: 'database unavailable' } }); expect((await GET()).status).toBe(500); });
 // I-27 — 헤더 셀렉터가 `?botId=` 로 한 서비스만 본다. 소유 검사는 resolveOwnedBots 가 그 값으로 한다.
 it('passes ?botId= to ownership scoping and falls back to all bots without it', async () => {
  const { NextRequest } = await import('next/server');
  await GET(new NextRequest('https://feedloop.test/api/dashboard?botId=owned-bot'));
  expect(resolveOwnedBots).toHaveBeenLastCalledWith('owned-bot');
  await GET(new NextRequest('https://feedloop.test/api/dashboard'));
  expect(resolveOwnedBots).toHaveBeenLastCalledWith(null);
 });
});

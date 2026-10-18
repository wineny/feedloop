import { afterEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
import { TerminalLog } from '@/components/monitor/TerminalLog';
import { runState } from '@/components/monitor/RunBadge';
afterEach(() => { hooks.effects.length = 0; vi.unstubAllGlobals(); });
it.each(['error', 'complete', 'disconnect'])('refreshes persisted stopped status after %s, without treating errors as successful PRs', kind => {
  const sources: FakeSource[] = [];
  class FakeSource {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = vi.fn();
    constructor() { sources.push(this); }
  }
  vi.stubGlobal('EventSource', FakeSource);
  const persisted = { status: 'unverifiable' as const, pr: null };
  let displayed = 'running';
  const refresh = vi.fn(() => { displayed = runState(persisted); });
  const complete = vi.fn();
  TerminalLog({ streamUrl: '/api/auto-dev/stream?runId=test', onSettled: refresh, onComplete: complete });
  for (const effect of hooks.effects) effect();
  if (kind === 'disconnect') sources[0].onerror!();
  else sources[0].onmessage!({ data: JSON.stringify({ type: kind, message: 'check_timeout' }) });
  expect(refresh).toHaveBeenCalledOnce();
  expect(displayed).toBe('unverifiable');
  expect(sources[0].close).toHaveBeenCalled();
  if (kind !== 'complete') expect(complete).not.toHaveBeenCalled();
});
